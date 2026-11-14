use crate::events::{
    emit_change_applied, emit_change_queued, emit_paused, emit_unpaused, ChangeAppliedEvent,
    ChangeQueuedEvent, PausedEvent, UnpausedEvent,
};
use crate::state::{Params, PendingChange};
use crate::{Contract, ContractExt};
use near_sdk::{env, near, AccountId};

// ---------------------------------------------------------------------------
// Time-lock constant: 48 hours in nanoseconds
// ---------------------------------------------------------------------------
const CHANGE_DELAY_NS: u64 = 48 * 3_600 * 1_000_000_000u64;

// ---------------------------------------------------------------------------
// Access-control helpers (pub(crate) so tests and other modules can use them)
// ---------------------------------------------------------------------------

impl Contract {
    pub(crate) fn assert_owner(&self) {
        near_sdk::require!(
            env::predecessor_account_id() == self.roles.owner,
            "E_UNAUTHORIZED: caller is not the contract owner"
        );
    }

    /// Owner always has admin rights; otherwise the caller must be in `roles.admins`.
    pub(crate) fn assert_admin(&self) {
        let caller = env::predecessor_account_id();
        let is_owner = caller == self.roles.owner;
        let is_admin = self.roles.admins.contains(&caller);
        near_sdk::require!(
            is_owner || is_admin,
            "E_UNAUTHORIZED: caller is not an admin"
        );
    }

    /// Guardian, any admin, or owner may call. Used for pause().
    pub(crate) fn assert_guardian_or_admin(&self) {
        let caller = env::predecessor_account_id();
        if caller == self.roles.owner
            || self.roles.admins.contains(&caller)
            || caller == self.roles.guardian
        {
            return;
        }
        env::panic_str("E_UNAUTHORIZED: caller is not guardian or admin");
    }

    /// Returns true when the given scope is currently paused.
    pub(crate) fn is_paused(&self, scope: &str) -> bool {
        if self.pause.global {
            return true;
        }
        match scope {
            "open_floors" => self.pause.buy,
            "close_floors" => self.pause.close,
            "sell_to_floor" => self.pause.sell_to_floor,
            "unwind" => self.pause.unwind,
            _ => false,
        }
    }
}

// ---------------------------------------------------------------------------
// Admin methods exposed on-chain
// ---------------------------------------------------------------------------

#[near]
impl Contract {
    // -----------------------------------------------------------------------
    // Params initialisation (owner-only, intended for one-time setup)
    // -----------------------------------------------------------------------

    /// Replace contract params. Owner-only. Can be called multiple times by
    /// the owner (use `queue_change` / `apply_change` for time-locked updates
    /// in production).
    pub fn init_params(&mut self, params: crate::state::Params) {
        self.assert_owner();
        self.params = params;
    }

    // -----------------------------------------------------------------------
    // Time-locked parameter changes
    // -----------------------------------------------------------------------

    /// Queue a parameter change with a 48-hour delay.
    /// `kind`: a short label (e.g. "params", "roles", "upgrade").
    /// `value`: serialised payload (opaque string; applied by `apply_change`).
    pub fn queue_change(&mut self, change_id: String, kind: String, value: String) {
        self.assert_owner();

        // Reject duplicate change_id.
        let already_exists = self
            .pending_changes
            .iter()
            .any(|c| c.change_id == change_id);
        near_sdk::require!(
            !already_exists,
            "E_BAD_MSG: change_id already queued"
        );

        let now_ns = env::block_timestamp();
        let apply_after_ns = now_ns.saturating_add(CHANGE_DELAY_NS);
        let queued_ns = now_ns;

        let change = PendingChange {
            change_id: change_id.clone(),
            kind: kind.clone(),
            payload: value,
            queued_ns,
            apply_after_ns,
        };
        self.pending_changes.push(change);

        emit_change_queued(&ChangeQueuedEvent {
            change_id,
            kind,
            eta_ns: apply_after_ns,
        });
    }

    /// Apply a queued change after its delay has elapsed.
    /// Permissionless — anyone can call once the delay is up.
    pub fn apply_change(&mut self, change_id: String) {
        let now_ns = env::block_timestamp();

        // Find the index of the pending change.
        let index = self
            .pending_changes
            .iter()
            .position(|c| c.change_id == change_id)
            .unwrap_or_else(|| env::panic_str("E_NOT_FOUND: change_id not found"));

        let change = self.pending_changes.get(index as u32).unwrap().clone();

        near_sdk::require!(
            now_ns >= change.apply_after_ns,
            "E_TOO_EARLY: time-lock delay has not elapsed"
        );

        // Remove from the vector by swapping with the last element.
        let last_idx = self.pending_changes.len() - 1;
        if index as u32 != last_idx {
            let last = self.pending_changes.get(last_idx).unwrap().clone();
            *self.pending_changes.get_mut(index as u32).unwrap() = last;
        }
        self.pending_changes.pop();

        // M4 fix: Apply the change payload based on kind.
        match change.kind.as_str() {
            "params" => {
                apply_params_patch(&mut self.params, &change.payload);
            }
            other => {
                env::panic_str(&format!("E_BAD_MSG: unknown change kind '{other}'"));
            }
        }

        emit_change_applied(&ChangeAppliedEvent {
            change_id,
            kind: change.kind,
        });
    }

    // -----------------------------------------------------------------------
    // Pause / unpause (admin-only pause, owner-only unpause per spec §3)
    // -----------------------------------------------------------------------

    /// Pause a specific operation scope. Guardian, admin, or owner.
    /// `scope`: "open_floors" | "close_floors" | "sell_to_floor" | "unwind"
    pub fn pause(&mut self, scope: String) {
        self.assert_guardian_or_admin();
        let by = env::predecessor_account_id().to_string();
        match scope.as_str() {
            "open_floors" => self.pause.buy = true,
            "close_floors" => self.pause.close = true,
            "sell_to_floor" => self.pause.sell_to_floor = true,
            "unwind" => self.pause.unwind = true,
            _ => env::panic_str("E_BAD_MSG: unknown pause scope"),
        }
        emit_paused(&PausedEvent { scope, by });
    }

    /// Unpause a specific operation scope. Owner-only.
    pub fn unpause(&mut self, scope: String) {
        self.assert_owner();
        let by = env::predecessor_account_id().to_string();
        match scope.as_str() {
            "open_floors" => self.pause.buy = false,
            "close_floors" => self.pause.close = false,
            "sell_to_floor" => self.pause.sell_to_floor = false,
            "unwind" => self.pause.unwind = false,
            _ => env::panic_str("E_BAD_MSG: unknown pause scope"),
        }
        emit_unpaused(&UnpausedEvent { scope, by });
    }

    // -----------------------------------------------------------------------
    // Quote-signer key management (owner-only)
    // -----------------------------------------------------------------------

    /// Add a named Ed25519 quote-signer public key (hex-encoded, 64 chars).
    /// H6 fix: writes to quote_signer_keys (HashMap) which the verifier now reads.
    pub fn add_quote_signer(&mut self, key_id: String, public_key_hex: String) {
        self.assert_owner();
        near_sdk::require!(
            public_key_hex.len() == 64,
            "E_BAD_MSG: public_key_hex must be 64 hex chars (32 bytes)"
        );
        let bytes = hex::decode_to_array(&public_key_hex)
            .unwrap_or_else(|_| env::panic_str("E_BAD_MSG: invalid hex in public_key_hex"));
        self.roles.quote_signer_keys.insert(key_id, bytes);
    }

    /// Remove a named quote-signer key.
    pub fn remove_quote_signer(&mut self, key_id: String) {
        self.assert_owner();
        near_sdk::require!(
            self.roles.quote_signer_keys.remove(&key_id).is_some(),
            "E_BAD_MSG: key_id not found"
        );
    }

    // -----------------------------------------------------------------------
    // Admin account management (owner-only)
    // -----------------------------------------------------------------------

    /// Add an account to the admin list.
    pub fn add_admin(&mut self, account_id: AccountId) {
        self.assert_owner();
        if !self.roles.admins.contains(&account_id) {
            self.roles.admins.push(account_id);
        }
    }

    /// Remove an account from the admin list.
    pub fn remove_admin(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.roles.admins.retain(|a| a != &account_id);
    }

    /// Set the auto_protect_bot account. Pass None to clear. Owner or admin only.
    pub fn set_auto_protect_bot(&mut self, account: Option<AccountId>) {
        self.assert_admin();
        self.roles.auto_protect_bot = account;
    }

    /// Set the unwind_bot account. Pass None to clear. Owner or admin only.
    pub fn set_unwind_bot(&mut self, account: Option<AccountId>) {
        self.assert_admin();
        self.roles.unwind_bot = account;
    }

    /// Set min_floor_usdc directly. Owner or admin only.
    /// For testnet: allows lowering the minimum so small amounts can open floors.
    pub fn set_min_floor_usdc(&mut self, value: near_sdk::json_types::U128) {
        self.assert_admin();
        self.params.min_floor_usdc = value.0;
    }

    /// Set quote_ttl_max_secs directly. Owner or admin only.
    pub fn set_quote_ttl_max_secs(&mut self, value: u32) {
        self.assert_admin();
        self.params.quote_ttl_max_secs = value;
    }
}

// ---------------------------------------------------------------------------
// Params patch application
// ---------------------------------------------------------------------------

/// Apply a JSON patch to Params in-place.
/// Only scalar top-level fields are supported. Patch fields that are present
/// override the corresponding Params field. Unknown fields are ignored.
/// This avoids round-tripping through serde_json::Value which can corrupt
/// large u128 values (e.g. u128::MAX).
fn apply_params_patch(params: &mut Params, patch_json: &str) {
    use near_sdk::AccountId;

    let patch: serde_json::Value = serde_json::from_str(patch_json)
        .unwrap_or_else(|e| near_sdk::env::panic_str(&format!("E_BAD_PAYLOAD: invalid JSON: {e}")));

    let obj = match &patch {
        serde_json::Value::Object(m) => m,
        _ => near_sdk::env::panic_str("E_BAD_PAYLOAD: patch must be a JSON object"),
    };

    for (key, val) in obj {
        match key.as_str() {
            "platform_fee_bps" => {
                if let Some(n) = val.as_u64() {
                    params.platform_fee_bps = n as u16;
                }
            }
            "pyth_max_age_secs" => {
                if let Some(n) = val.as_u64() {
                    params.pyth_max_age_secs = n as u32;
                }
            }
            "pyth_tolerance_bps" => {
                if let Some(n) = val.as_u64() {
                    params.pyth_tolerance_bps = n as u16;
                }
            }
            "quote_ttl_max_secs" => {
                if let Some(n) = val.as_u64() {
                    params.quote_ttl_max_secs = n as u32;
                }
            }
            "min_floor_usdc" => {
                if let Some(n) = val.as_u64() {
                    params.min_floor_usdc = n as u128;
                } else if let Some(s) = val.as_str() {
                    if let Ok(n) = s.parse::<u128>() {
                        params.min_floor_usdc = n;
                    }
                }
            }
            "auto_protect_window_secs" => {
                if let Some(n) = val.as_u64() {
                    params.auto_protect_window_secs = n as u32;
                }
            }
            "payout_gas" => {
                if let Some(n) = val.as_u64() {
                    params.payout_gas = n;
                }
            }
            "expire_batch_max" => {
                if let Some(n) = val.as_u64() {
                    params.expire_batch_max = n as u16;
                }
            }
            "intents" => {
                if let Some(s) = val.as_str() {
                    if let Ok(a) = s.parse::<AccountId>() {
                        params.intents = a;
                    }
                }
            }
            "pyth" => {
                if let Some(s) = val.as_str() {
                    if let Ok(a) = s.parse::<AccountId>() {
                        params.pyth = a;
                    }
                }
            }
            "usdc" => {
                if let Some(s) = val.as_str() {
                    params.usdc = s.to_string();
                }
            }
            "platform_account" => {
                if let Some(s) = val.as_str() {
                    if let Ok(a) = s.parse::<AccountId>() {
                        params.platform_account = a;
                    }
                }
            }
            // Unknown fields are silently ignored (forward compatibility)
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Hex decoding helper (no extra crate needed)
// ---------------------------------------------------------------------------

mod hex {
    pub fn decode_to_array(s: &str) -> Result<[u8; 32], ()> {
        let bytes = decode(s)?;
        bytes.try_into().map_err(|_| ())
    }

    pub fn decode(s: &str) -> Result<Vec<u8>, ()> {
        if s.len() % 2 != 0 {
            return Err(());
        }
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| ()))
            .collect()
    }
}
