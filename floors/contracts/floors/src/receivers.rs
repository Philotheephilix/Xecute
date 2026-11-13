use crate::state::{Floor, FloorStatus, Totals};
use crate::{Contract, ContractExt, StorageKey};
use near_sdk::json_types::U128;
use near_sdk::store::IterableSet;
use near_sdk::{env, near, AccountId, Gas, PromiseOrValue};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// External types
// ---------------------------------------------------------------------------

/// Shape returned by the Pyth mock (and real Pyth on NEAR).
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PythPrice {
    pub price: i64,
    pub expo: i32,
    pub publish_time: u64,
}

/// The msg JSON passed into mt_on_transfer.
#[derive(Deserialize, Debug)]
pub struct MtOnTransferMsg {
    pub op: String,
    pub quote: floors_types::FloorQuote,
    pub sig: String,
}

// ---------------------------------------------------------------------------
// External contract interfaces (cross-contract calls)
// ---------------------------------------------------------------------------

#[near_sdk::ext_contract(ext_pyth)]
pub trait PythOracle {
    fn get_price_no_older_than(&self, price_id: String, age: u32) -> Option<PythPrice>;
}

#[near_sdk::ext_contract(ext_self)]
pub trait SelfCallback {
    fn on_open_price(
        &mut self,
        sender_id: AccountId,
        amounts: Vec<U128>,
        quote_json: String,
        quote_id_hex: String,
        floor_usdc: U128,
    );
}

// ---------------------------------------------------------------------------
// Gas
// ---------------------------------------------------------------------------
const GAS_FOR_PYTH: Gas = Gas::from_tgas(15);
const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(40);

// ---------------------------------------------------------------------------
// Math helpers (no floats, no external crates)
// ---------------------------------------------------------------------------

/// ceil(a * b / divisor) — safe for token_qty * floor_price_e6 / 10^decimals
pub fn ceil_div_u128(a: u128, b: u128, divisor: u128) -> u128 {
    let quot = a / divisor;
    let rem = a % divisor;
    let base = quot.checked_mul(b).expect("overflow");
    if rem == 0 {
        base
    } else {
        let rem_b = rem.checked_mul(b).expect("overflow rem_b");
        base.checked_add((rem_b + divisor - 1) / divisor)
            .expect("overflow add")
    }
}

/// floor(a * b / divisor)
pub fn floor_div_u128(a: u128, b: u128, divisor: u128) -> u128 {
    let quot = a / divisor;
    let rem = a % divisor;
    let base = quot.checked_mul(b).expect("overflow");
    let rem_b = rem.checked_mul(b).expect("overflow rem_b");
    base.checked_add(rem_b / divisor).expect("overflow add")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn decode_hex32(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

fn decode_base64_64(b64: &str) -> Option<[u8; 64]> {
    use near_sdk::base64::{engine::general_purpose::STANDARD, Engine};
    let bytes = STANDARD.decode(b64).ok()?;
    if bytes.len() != 64 {
        return None;
    }
    let mut out = [0u8; 64];
    out.copy_from_slice(&bytes);
    Some(out)
}

/// Encode the quote for signature verification.
/// H5 fix: single canonical format — delegates to build_quote_message in quotes.rs.
///
/// Format (matches TypeScript signing.ts and build_quote_message):
///   b"FLOORS_QUOTE/V1"  (15 bytes)
///   id                  (32 bytes raw — decoded from hex)
///   owner               (4-byte LE u32 length + UTF-8)
///   asset               (4-byte LE u32 length + UTF-8)
///   qty                 (16 bytes LE u128)
///   floor_price_e6      (16 bytes LE u128)
///   fee_usdc            (16 bytes LE u128)
///   sleeve              (4-byte LE u32 length + UTF-8)
///   expires_at          (8 bytes LE u64 — Unix seconds, not nanoseconds)
fn quote_signing_message(q: &floors_types::FloorQuote) -> Vec<u8> {
    // Decode hex id
    let id_bytes: [u8; 32] = {
        let mut out = [0u8; 32];
        if q.id.len() == 64 {
            for i in 0..32 {
                out[i] = u8::from_str_radix(&q.id[i * 2..i * 2 + 2], 16).unwrap_or(0);
            }
        }
        out
    };
    let qty: u128 = q.qty.parse().unwrap_or(0);
    let floor_price_e6: u128 = q.floor_price_e6.parse().unwrap_or(0);
    let fee_usdc: u128 = q.fee_usdc.parse().unwrap_or(0);
    // expires_at_ns is nanoseconds; signing format uses seconds
    let expires_at_ns: u64 = q.expires_at_ns.parse().unwrap_or(0);
    let expires_at_secs: u64 = expires_at_ns / 1_000_000_000;

    crate::quotes::build_quote_message(
        &id_bytes,
        &q.owner,
        &q.asset,
        qty,
        floor_price_e6,
        fee_usdc,
        &q.sleeve,
        expires_at_secs,
    )
}

// ---------------------------------------------------------------------------
// Contract impl — public-facing NEAR methods
// ---------------------------------------------------------------------------

#[near]
impl Contract {
    /// Entry point for opening a floor.
    /// Called by intents.near via NEP-245 after a transfer with message.
    pub fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        // Must be called by intents.near
        near_sdk::require!(
            env::predecessor_account_id() == self.params.intents,
            "E_NOT_INTENTS: predecessor must be intents.near"
        );

        let refusal: Vec<U128> = amounts.clone();

        // Parse msg
        let parsed: MtOnTransferMsg = match serde_json::from_str(&msg) {
            Ok(v) => v,
            Err(_) => return PromiseOrValue::Value(refusal),
        };
        if parsed.op != "open_floor" {
            return PromiseOrValue::Value(refusal);
        }

        let quote = parsed.quote;

        // Basic length checks
        if token_ids.len() != 2 || amounts.len() != 2 || previous_owner_ids.len() != 2 {
            return PromiseOrValue::Value(refusal);
        }

        // previous_owner_ids all == quote.owner
        for pid in &previous_owner_ids {
            if pid.as_str() != quote.owner {
                return PromiseOrValue::Value(refusal);
            }
        }

        // Parse quote fields
        let Ok(expected_qty) = quote.qty.parse::<u128>() else {
            return PromiseOrValue::Value(refusal);
        };
        let Ok(expected_fee) = quote.fee_usdc.parse::<u128>() else {
            return PromiseOrValue::Value(refusal);
        };
        let Ok(expires_at_ns) = quote.expires_at_ns.parse::<u64>() else {
            return PromiseOrValue::Value(refusal);
        };
        let Ok(floor_price_e6) = quote.floor_price_e6.parse::<u128>() else {
            return PromiseOrValue::Value(refusal);
        };

        // token_ids[0] = asset, token_ids[1] = usdc
        if token_ids[0] != quote.asset || token_ids[1] != self.params.usdc {
            return PromiseOrValue::Value(refusal);
        }
        if amounts[0].0 != expected_qty || amounts[1].0 != expected_fee {
            return PromiseOrValue::Value(refusal);
        }

        // Paused?
        if self.pause.global || self.pause.buy {
            return PromiseOrValue::Value(refusal);
        }

        // Asset allowed?
        let asset_config = match self.params.assets.get(&quote.asset) {
            Some(c) => c.clone(),
            None => return PromiseOrValue::Value(refusal),
        };
        if asset_config.paused {
            return PromiseOrValue::Value(refusal);
        }

        // Quote not expired
        if env::block_timestamp() >= expires_at_ns {
            return PromiseOrValue::Value(refusal);
        }

        // Quote TTL within allowed max
        let max_ttl_ns = u64::from(self.params.quote_ttl_max_secs) * 1_000_000_000;
        if expires_at_ns > env::block_timestamp().saturating_add(max_ttl_ns) {
            return PromiseOrValue::Value(refusal);
        }

        // Quote not already used
        let Some(quote_id_bytes) = decode_hex32(&quote.id) else {
            return PromiseOrValue::Value(refusal);
        };
        if self.quote_is_used(&quote_id_bytes) {
            return PromiseOrValue::Value(refusal);
        }

        // H6 fix: Verify signature — look up key by key_id in quote_signer_keys (HashMap).
        // add_quote_signer also writes to quote_signer_keys, so rotation works.
        let Some(sig_bytes) = decode_base64_64(&parsed.sig) else {
            return PromiseOrValue::Value(refusal);
        };
        let key_id_str = quote.key_id.to_string();
        let Some(&pub_key) = self.roles.quote_signer_keys.get(&key_id_str) else {
            return PromiseOrValue::Value(refusal);
        };
        let signing_msg = quote_signing_message(&quote);
        if !env::ed25519_verify(&sig_bytes, &signing_msg, &pub_key) {
            return PromiseOrValue::Value(refusal);
        }

        // Product allowed?
        if !asset_config.allowed_products.is_empty() {
            let product = (u32::from(quote.floor_bps), u64::from(quote.duration_secs));
            if !asset_config.allowed_products.contains(&product) {
                return PromiseOrValue::Value(refusal);
            }
        }

        // floor_usdc >= min_floor_usdc
        let decimals_pow = 10u128.pow(u32::from(asset_config.decimals));
        let floor_usdc = ceil_div_u128(expected_qty, floor_price_e6, decimals_pow);
        if floor_usdc < self.params.min_floor_usdc {
            return PromiseOrValue::Value(refusal);
        }

        // Sleeve exists and has capacity
        let sleeve_id = quote.sleeve.clone();
        if !self.params.sleeves.contains_key(&sleeve_id) {
            return PromiseOrValue::Value(refusal);
        }
        let sleeve_free = match self.sleeves.get(&sleeve_id) {
            Some(s) => s.free_usdc,
            None => return PromiseOrValue::Value(refusal),
        };
        if sleeve_free < floor_usdc {
            return PromiseOrValue::Value(refusal);
        }

        // Mark quote used and hold sleeve USDC
        self.hold_quote(quote_id_bytes, expires_at_ns);
        {
            let sleeve = self.sleeves.get_mut(&sleeve_id).unwrap();
            sleeve.free_usdc -= floor_usdc;
            sleeve.reserved_usdc += floor_usdc;
        }

        // Validate quote.pyth_feed matches the configured feed for this asset
        let feed_bytes = match decode_hex32(&quote.pyth_feed) {
            Some(b) => b,
            None => return PromiseOrValue::Value(refusal),
        };
        near_sdk::require!(
            feed_bytes == asset_config.pyth_price_id,
            "E_INVALID_PYTH_FEED: quote pyth_feed does not match configured feed for asset"
        );

        // Cross-contract call to Pyth
        let pyth = self.params.pyth.clone();
        let current_account = env::current_account_id();
        let pyth_feed = quote.pyth_feed.clone();
        let max_age = self.params.pyth_max_age_secs;

        // Pass quote as JSON string to avoid complex borsh in Promise args
        let quote_json = serde_json::to_string(&quote).unwrap_or_default();

        PromiseOrValue::Promise(
            ext_pyth::ext(pyth)
                .with_static_gas(GAS_FOR_PYTH)
                .get_price_no_older_than(pyth_feed, max_age)
                .then(
                    ext_self::ext(current_account)
                        .with_static_gas(GAS_FOR_CALLBACK)
                        .on_open_price(
                            sender_id,
                            amounts,
                            quote_json,
                            quote.id.clone(),
                            U128(floor_usdc),
                        ),
                ),
        )
    }

    /// Private callback: called after pyth returns the price.
    #[private]
    pub fn on_open_price(
        &mut self,
        sender_id: AccountId,
        amounts: Vec<U128>,
        quote_json: String,
        quote_id_hex: String,
        floor_usdc: U128,
    ) -> Vec<U128> {
        let refusal: Vec<U128> = amounts.clone();
        let floor_usdc = floor_usdc.0;

        // Decode the quote ID so we can release it on any failure path.
        // This must succeed — the hex was valid when hold_quote was called in mt_on_transfer.
        let quote_id_bytes: Option<[u8; 32]> = decode_hex32(&quote_id_hex);

        // C3 fix: Extract sleeve_id before full deserialization so rollback works even
        // if full quote deserialization fails.
        #[derive(serde::Deserialize)]
        struct QuoteSleeveOnly { sleeve: String }
        let sleeve_id_for_rollback: String = serde_json::from_str::<QuoteSleeveOnly>(&quote_json)
            .map(|q| q.sleeve)
            .unwrap_or_default();

        // Deserialize quote
        let quote: floors_types::FloorQuote = match serde_json::from_str(&quote_json) {
            Ok(q) => q,
            Err(_) => {
                self.rollback_sleeve_hold(&sleeve_id_for_rollback, floor_usdc);
                if let Some(qid) = quote_id_bytes { self.release_quote(qid); }
                return refusal;
            }
        };

        let Ok(expected_qty) = quote.qty.parse::<u128>() else {
            self.rollback_sleeve_hold(&quote.sleeve, floor_usdc);
            if let Some(qid) = quote_id_bytes { self.release_quote(qid); }
            return refusal;
        };
        let Ok(expected_fee) = quote.fee_usdc.parse::<u128>() else {
            self.rollback_sleeve_hold(&quote.sleeve, floor_usdc);
            if let Some(qid) = quote_id_bytes { self.release_quote(qid); }
            return refusal;
        };
        let Ok(floor_price_e6) = quote.floor_price_e6.parse::<u128>() else {
            self.rollback_sleeve_hold(&quote.sleeve, floor_usdc);
            if let Some(qid) = quote_id_bytes { self.release_quote(qid); }
            return refusal;
        };
        let Ok(expires_at_ns) = quote.expires_at_ns.parse::<u64>() else {
            self.rollback_sleeve_hold(&quote.sleeve, floor_usdc);
            if let Some(qid) = quote_id_bytes { self.release_quote(qid); }
            return refusal;
        };

        // Read Pyth result
        let pyth_result: Option<PythPrice> = match env::promise_result_checked(0, usize::MAX) {
            Ok(bytes) => {
                serde_json::from_slice::<Option<PythPrice>>(&bytes)
                    .ok()
                    .flatten()
            }
            Err(_) => None,
        };

        let pyth_price = match pyth_result {
            Some(p) if p.price >= 0 => p,
            _ => {
                self.rollback_sleeve_hold(&quote.sleeve, floor_usdc);
                if let Some(qid) = quote_id_bytes { self.release_quote(qid); }
                return refusal;
            }
        };

        // Convert pyth price to e6 units
        let pyth_price_e6 = {
            let p = pyth_price.price as u128;
            let expo = pyth_price.expo;
            let shift = 6i32 + expo; // we want e6
            if shift >= 0 {
                match p.checked_mul(10u128.pow(shift as u32)) {
                    Some(v) => v,
                    None => {
                        self.rollback_sleeve_hold(&quote.sleeve, floor_usdc);
                        if let Some(qid) = quote_id_bytes { self.release_quote(qid); }
                        return refusal;
                    }
                }
            } else {
                let divisor = 10u128.pow((-shift) as u32);
                p / divisor
            }
        };

        // Validate price: floor_price_e6 <= pyth_price_e6 * (10000 + tolerance_bps) / 10000
        //
        // Tolerance direction: the risk service sets strike = spot * (1 - depth), so the
        // floor price is always strictly below spot at quote time. The tolerance_bps allowance
        // on the RIGHT side (Pyth price) handles the case where Pyth is slightly stale and
        // reports a price LOWER than the current market (i.e. spot has risen since the last
        // Pyth update). In that scenario, the floor price may appear marginally above the
        // stale Pyth price but is still legitimately below true spot. Allowing up to
        // tolerance_bps (default 100 bps = 1%) above the reported Pyth price is intentional
        // and safe: the risk service already prices in the Pyth staleness window.
        let tolerance_bps = u128::from(self.params.pyth_tolerance_bps);
        let lhs = floor_price_e6.saturating_mul(10_000);
        let rhs = pyth_price_e6.saturating_mul(10_000 + tolerance_bps);
        if lhs > rhs {
            self.rollback_sleeve_hold(&quote.sleeve, floor_usdc);
            if let Some(qid) = quote_id_bytes { self.release_quote(qid); }
            return refusal;
        }

        // All checks pass — create the floor
        let floor_id = self.next_floor_id;
        self.next_floor_id += 1;

        // Fee split
        let platform_fee = expected_fee
            .checked_mul(u128::from(self.params.platform_fee_bps))
            .expect("overflow platform_fee")
            / 10_000;
        let sleeve_fee = expected_fee.saturating_sub(platform_fee);

        let asset_config = self.params.assets.get(&quote.asset).cloned().unwrap();
        let decimals_pow = 10u128.pow(u32::from(asset_config.decimals));
        let _ = decimals_pow; // already computed as floor_usdc

        let floor = Floor {
            owner: sender_id.clone(),
            asset: quote.asset.clone(),
            qty: expected_qty,
            floor_price_e6,
            reserved_usdc: floor_usdc,
            sleeve: quote.sleeve.clone(),
            fee_usdc: expected_fee,
            opened_ns: env::block_timestamp(),
            expires_ns: expires_at_ns,
            status: FloorStatus::Active,
        };

        self.floors.insert(floor_id, floor);

        // Update floors_by_owner
        let owner_hash = env::sha256(sender_id.as_bytes());
        if !self.floors_by_owner.contains_key(&sender_id) {
            let set = IterableSet::new(StorageKey::FloorsByOwnerInner {
                owner_hash: owner_hash.clone(),
            });
            self.floors_by_owner.insert(sender_id.clone(), set);
        }
        self.floors_by_owner
            .get_mut(&sender_id)
            .unwrap()
            .insert(floor_id);

        // Update asset totals (asset tokens in escrow)
        let asset_totals = self
            .totals
            .entry(quote.asset.clone())
            .or_insert_with(Totals::default);
        asset_totals.held += expected_qty;
        asset_totals.escrow += expected_qty;
        let asset_str = quote.asset.clone();

        // Update USDC totals
        let usdc_id = self.params.usdc.clone();
        let usdc_totals = self
            .totals
            .entry(usdc_id.clone())
            .or_insert_with(Totals::default);
        usdc_totals.held += expected_fee;
        usdc_totals.reserved += floor_usdc;
        usdc_totals.free = usdc_totals.free.saturating_sub(floor_usdc);
        usdc_totals.platform += platform_fee;
        usdc_totals.free += sleeve_fee;

        // Add sleeve_fee to sleeve free balance
        {
            let sleeve = self.sleeves.get_mut(&quote.sleeve).unwrap();
            sleeve.free_usdc += sleeve_fee;
        }

        // Assert solvency
        {
            let t = self.totals.get(&asset_str).unwrap();
            t.assert_solvent(&asset_str);
        }
        {
            let t = self.totals.get(&usdc_id).unwrap();
            t.assert_usdc_solvent();
        }

        // Emit event
        crate::events::emit_floor_opened(&crate::events::FloorOpenedEvent {
            floor_id,
            owner: sender_id.to_string(),
            asset: quote.asset.clone(),
            qty: expected_qty.to_string(),
            floor_price_e6: floor_price_e6.to_string(),
            reserved_usdc: floor_usdc.to_string(),
            fee_usdc: expected_fee.to_string(),
            platform_fee_usdc: platform_fee.to_string(),
            sleeve: quote.sleeve.clone(),
            expires_ns: expires_at_ns.to_string(),
            quote_id: quote_id_hex,
        });

        // Accept tokens
        vec![U128(0), U128(0)]
    }
}

// ---------------------------------------------------------------------------
// Internal helpers — plain impl (no #[near] macro)
// ---------------------------------------------------------------------------

impl Contract {
    /// Roll back a sleeve USDC hold when an open fails.
    pub(crate) fn rollback_sleeve_hold(&mut self, sleeve_id: &str, floor_usdc: u128) {
        if floor_usdc == 0 {
            return;
        }
        if let Some(sleeve) = self.sleeves.get_mut(sleeve_id) {
            sleeve.reserved_usdc = sleeve.reserved_usdc.saturating_sub(floor_usdc);
            sleeve.free_usdc += floor_usdc;
        }
    }
}
