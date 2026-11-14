use crate::floors::{ext_intents, ext_floors_self};
use crate::receivers::floor_div_u128;
use crate::state::{FloorStatus, Totals};
use crate::{Contract, ContractExt};
use near_sdk::json_types::U128;
use near_sdk::serde_json::Value;
use near_sdk::{env, near, AccountId, Gas, NearToken, PromiseOrValue};
use serde::Deserialize;

// Mirror of floors.rs constants (they're private there)
const GAS_TRANSFER: Gas = Gas::from_tgas(20);
const GAS_CALLBACK: Gas = Gas::from_tgas(25);

// ---------------------------------------------------------------------------
// on_auth message shape
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug)]
struct OnAuthMsg {
    pub op: String,
    pub floor_id: Option<u64>,
    pub asset: Option<String>,
}

// ---------------------------------------------------------------------------
// on_auth implementation
// ---------------------------------------------------------------------------

#[near]
impl Contract {
    /// Called by intents.near when a signer authorises an operation.
    /// predecessor must be params.intents.
    pub fn on_auth(
        &mut self,
        signer_id: AccountId,
        msg: String,
    ) -> PromiseOrValue<Value> {
        near_sdk::require!(
            env::predecessor_account_id() == self.params.intents,
            "E_NOT_INTENTS"
        );

        let parsed: OnAuthMsg = serde_json::from_str(&msg)
            .unwrap_or_else(|_| env::panic_str("E_BAD_MSG: invalid on_auth json"));

        match parsed.op.as_str() {
            "sell_to_floor" => {
                let floor_id = parsed.floor_id
                    .unwrap_or_else(|| env::panic_str("E_BAD_MSG: floor_id required"));
                self.on_auth_sell(signer_id, floor_id)
            }
            "close" => {
                let floor_id = parsed.floor_id
                    .unwrap_or_else(|| env::panic_str("E_BAD_MSG: floor_id required"));
                self.on_auth_close(signer_id, floor_id)
            }
            "withdraw_credit" => {
                let asset = parsed.asset
                    .unwrap_or_else(|| env::panic_str("E_BAD_MSG: asset required"));
                self.on_auth_withdraw_credit(signer_id, asset)
            }
            _ => env::panic_str("E_BAD_MSG: unknown op"),
        }
    }
}

// ---------------------------------------------------------------------------
// Internal helpers (not exported as NEAR methods)
// ---------------------------------------------------------------------------

impl Contract {
    fn on_auth_sell(&mut self, signer_id: AccountId, floor_id: u64) -> PromiseOrValue<Value> {
        near_sdk::require!(!self.pause.global && !self.pause.sell_to_floor, "E_PAUSED");

        let floor = self.floors.get(&floor_id)
            .unwrap_or_else(|| env::panic_str("E_FLOOR_NOT_FOUND"));

        near_sdk::require!(floor.owner == signer_id, "E_NOT_FLOOR_OWNER");
        near_sdk::require!(floor.status == FloorStatus::Active, "E_FLOOR_NOT_ACTIVE");
        near_sdk::require!(
            env::block_timestamp() < floor.expires_ns,
            "E_FLOOR_EXPIRED"
        );

        let asset_config = self.params.assets.get(&floor.asset)
            .expect("E_ASSET_NOT_FOUND");
        let decimals_pow = 10u128.pow(u32::from(asset_config.decimals));
        let payout_usdc = floor_div_u128(floor.qty, floor.floor_price_e6, decimals_pow);

        let sleeve_id = floor.sleeve.clone();
        let qty = floor.qty;
        let reserved_usdc = floor.reserved_usdc;

        // Transition to PayoutPending before the cross-contract call
        {
            let floor_mut = self.floors.get_mut(&floor_id).unwrap();
            floor_mut.status = FloorStatus::PayoutPending;
        }

        // Update totals: move reserved → pending
        let usdc_id = self.params.usdc.clone();
        {
            let t = self.totals.entry(usdc_id.clone()).or_insert_with(Totals::default);
            t.reserved = t.reserved.saturating_sub(reserved_usdc);
            t.pending += payout_usdc;
        }

        // Release sleeve reservation
        {
            if let Some(sleeve) = self.sleeves.get_mut(&sleeve_id) {
                sleeve.reserved_usdc = sleeve.reserved_usdc.saturating_sub(reserved_usdc);
                let surplus = reserved_usdc.saturating_sub(payout_usdc);
                sleeve.free_usdc += surplus;
            }
        }

        crate::events::emit_floor_payout_pending(
            &crate::events::FloorPayoutPendingEvent { floor_id }
        );

        let intents_contract = self.params.intents.clone();
        PromiseOrValue::Promise(
            ext_intents::ext(intents_contract)
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(GAS_TRANSFER)
                .mt_transfer(
                    signer_id,
                    usdc_id,
                    U128(payout_usdc),
                    None,
                    Some("floor payout via auth".to_string()),
                )
                .then(
                    ext_floors_self::ext(env::current_account_id())
                        .with_static_gas(GAS_CALLBACK)
                        .on_sell_payout(floor_id, U128(payout_usdc), U128(qty)),
                ),
        )
    }

    fn on_auth_close(&mut self, signer_id: AccountId, floor_id: u64) -> PromiseOrValue<Value> {
        near_sdk::require!(!self.pause.global && !self.pause.close, "E_PAUSED");

        let floor = self.floors.get(&floor_id)
            .unwrap_or_else(|| env::panic_str("E_FLOOR_NOT_FOUND"));

        near_sdk::require!(floor.owner == signer_id, "E_NOT_FLOOR_OWNER");
        near_sdk::require!(floor.status == FloorStatus::Active, "E_FLOOR_NOT_ACTIVE");

        let qty = floor.qty;
        let reserved_usdc = floor.reserved_usdc;
        let asset = floor.asset.clone();
        let owner = floor.owner.clone();

        // Transition to ClosePending before transfer (reentrancy guard)
        {
            let floor_mut = self.floors.get_mut(&floor_id).unwrap();
            floor_mut.status = FloorStatus::ClosePending;
        }

        // Mirrors floors.rs::close() — only subtract reserved and escrow now;
        // free/sleeve adjustments are deferred to on_close_transfer (success path)
        // so a concurrent mt_on_transfer cannot see inflated capacity.
        {
            let usdc_id = self.params.usdc.clone();
            let t = self.totals.entry(usdc_id).or_insert_with(Totals::default);
            t.reserved = t.reserved.saturating_sub(reserved_usdc);
        }
        {
            let t = self.totals.entry(asset.clone()).or_insert_with(Totals::default);
            t.escrow = t.escrow.saturating_sub(qty);
        }

        let intents = self.params.intents.clone();
        PromiseOrValue::Promise(
            ext_intents::ext(intents)
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(GAS_TRANSFER)
                .mt_transfer(
                    owner,
                    asset,
                    U128(qty),
                    None,
                    Some("close floor via auth".to_string()),
                )
                .then(
                    ext_floors_self::ext(env::current_account_id())
                        .with_static_gas(GAS_CALLBACK)
                        .on_close_transfer(floor_id, U128(qty)),
                ),
        )
    }

    fn on_auth_withdraw_credit(
        &mut self,
        signer_id: AccountId,
        asset: String,
    ) -> PromiseOrValue<Value> {
        let credit_key = (signer_id.clone(), asset.clone());
        let amount = self.credits.get(&credit_key).copied().unwrap_or(0);

        near_sdk::require!(amount > 0, "E_NO_CREDIT");

        // Zero out credit and reduce totals.credits, move to pending
        self.credits.remove(&credit_key);
        {
            let t = self.totals.entry(asset.clone()).or_insert_with(Totals::default);
            t.credits = t.credits.saturating_sub(amount);
            t.pending += amount;
        }

        let intents_contract = self.params.intents.clone();
        let owner = signer_id.clone();
        PromiseOrValue::Promise(
            ext_intents::ext(intents_contract)
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(GAS_TRANSFER)
                .mt_transfer(
                    signer_id,
                    asset.clone(),
                    U128(amount),
                    None,
                    Some("withdraw credit via auth".to_string()),
                )
                .then(
                    ext_floors_self::ext(env::current_account_id())
                        .with_static_gas(GAS_CALLBACK)
                        .on_withdraw_credit_result(owner, asset, U128(amount)),
                ),
        )
    }
}

// ---------------------------------------------------------------------------
// Callback: on_withdraw_credit_result
// ---------------------------------------------------------------------------

#[near]
impl Contract {
    /// Private callback fired after a withdraw_credit mt_transfer.
    /// Restores credit if the transfer failed.
    #[private]
    pub fn on_withdraw_credit_result(&mut self, owner: AccountId, asset: String, amount: U128) {
        let amount = amount.0;
        if near_sdk::is_promise_success() {
            // Transfer succeeded — credit was already zeroed and totals updated; reduce held.
            {
                let t = self.totals.entry(asset.clone()).or_insert_with(crate::state::Totals::default);
                t.held = t.held.saturating_sub(amount);
                t.pending = t.pending.saturating_sub(amount);
            }
            near_sdk::env::log_str(&format!(
                r#"{{"standard":"floors","version":"1.0.0","event":"credit_withdrawn","data":[{{"owner":"{}","asset":"{}","amount":"{}"}}]}}"#,
                owner, asset, amount
            ));
        } else {
            // Transfer failed — restore the credit and totals.
            let credit_key = (owner.clone(), asset.clone());
            let entry = self.credits.entry(credit_key).or_insert(0);
            *entry += amount;
            {
                let t = self.totals.entry(asset.clone()).or_insert_with(crate::state::Totals::default);
                t.credits += amount;
                t.pending = t.pending.saturating_sub(amount);
            }
            near_sdk::env::log_str(&format!(
                r#"{{"standard":"floors","version":"1.0.0","event":"credit_withdraw_failed","data":[{{"owner":"{}","asset":"{}","amount":"{}"}}]}}"#,
                owner, asset, amount
            ));
        }
    }
}
