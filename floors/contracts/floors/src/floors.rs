use crate::receivers::floor_div_u128;
use crate::state::{FloorStatus, Totals};
use crate::{Contract, ContractExt};
use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise};

// ---------------------------------------------------------------------------
// Cross-contract: intents.near mt_transfer
// ---------------------------------------------------------------------------

#[near_sdk::ext_contract(ext_intents)]
pub trait Intents {
    #[payable]
    fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    );

    fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128;
}

#[near_sdk::ext_contract(ext_floors_self)]
pub trait FloorsSelf {
    fn on_sell_payout(
        &mut self,
        floor_id: u64,
        payout_usdc: U128,
        asset_qty: U128,
    );
    fn on_close_transfer(
        &mut self,
        floor_id: u64,
        qty_returned: U128,
    );
    fn on_expire_transfer(
        &mut self,
        floor_id: u64,
        qty_returned: U128,
    );
    fn on_retry_payout(
        &mut self,
        floor_id: u64,
        payout_usdc: U128,
    );
    fn on_withdraw_credit_result(
        &mut self,
        owner: AccountId,
        asset: String,
        amount: U128,
    );
    fn on_auto_protect_sell_payout(
        &mut self,
        floor_id: u64,
        payout_usdc: U128,
        asset_qty: U128,
        reserved_usdc: U128,
    );
}

const GAS_TRANSFER: Gas = Gas::from_tgas(20);
const GAS_CALLBACK: Gas = Gas::from_tgas(25);

// ---------------------------------------------------------------------------
// Floor lifecycle methods
// ---------------------------------------------------------------------------

#[near]
impl Contract {
    /// Sell tokens at the floor price. Caller must be the floor owner.
    /// Requires 1 yoctoNEAR attached.
    #[payable]
    pub fn sell_to_floor(&mut self, floor_id: u64) -> Promise {
        near_sdk::require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "E_DEPOSIT: requires 1 yoctoNEAR"
        );

        let caller = env::predecessor_account_id();

        let floor = self.floors.get(&floor_id)
            .unwrap_or_else(|| near_sdk::env::panic_str("E_FLOOR_NOT_FOUND"));

        near_sdk::require!(floor.owner == caller, "E_NOT_FLOOR_OWNER");
        near_sdk::require!(floor.status == FloorStatus::Active, "E_FLOOR_NOT_ACTIVE");
        near_sdk::require!(!self.pause.global && !self.pause.sell_to_floor, "E_PAUSED");
        near_sdk::require!(
            env::block_timestamp() < floor.expires_ns,
            "E_FLOOR_EXPIRED: floor has expired"
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
                // Any surplus from rounding back to free
                let surplus = reserved_usdc.saturating_sub(payout_usdc);
                sleeve.free_usdc += surplus;
            }
        }

        crate::events::emit_floor_payout_pending(
            &crate::events::FloorPayoutPendingEvent { floor_id }
        );

        // Cross-contract: transfer USDC to owner via intents.mt_transfer
        // params.usdc is the token_id (nep141:... string), params.intents is the contract
        let intents_contract = self.params.intents.clone();
        ext_intents::ext(intents_contract)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_TRANSFER)
            .mt_transfer(caller, usdc_id, U128(payout_usdc), None, Some("floor payout".to_string()))
            .then(
                ext_floors_self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_sell_payout(floor_id, U128(payout_usdc), U128(qty)),
            )
    }

    /// Callback after the USDC payout for sell_to_floor.
    #[private]
    pub fn on_sell_payout(
        &mut self,
        floor_id: u64,
        payout_usdc: U128,
        asset_qty: U128,
    ) {
        let payout_usdc = payout_usdc.0;
        let asset_qty = asset_qty.0;

        let success = matches!(
            env::promise_result_checked(0, usize::MAX),
            Ok(_)
        );

        let floor = match self.floors.get(&floor_id) {
            Some(f) => f.clone(),
            None => return,
        };

        let usdc_id = self.params.usdc.clone();

        if success {
            // Finalize: update totals
            {
                let t = self.totals.entry(usdc_id.clone()).or_insert_with(Totals::default);
                t.held = t.held.saturating_sub(payout_usdc);
                t.pending = t.pending.saturating_sub(payout_usdc);
            }
            {
                let t = self.totals.entry(floor.asset.clone()).or_insert_with(Totals::default);
                t.escrow = t.escrow.saturating_sub(asset_qty);
                t.delivered += asset_qty;
            }

            // Mark sleeve delivered
            {
                if let Some(sleeve) = self.sleeves.get_mut(&floor.sleeve) {
                    let delivered = sleeve.delivered.entry(floor.asset.clone()).or_insert(0);
                    *delivered += asset_qty;
                }
            }

            // Mark floor Sold
            {
                let floor_mut = self.floors.get_mut(&floor_id).unwrap();
                floor_mut.status = FloorStatus::Sold;
                floor_mut.qty = 0;
            }

            crate::events::emit_floor_sold(&crate::events::FloorSoldEvent {
                floor_id,
                owner: floor.owner.to_string(),
                qty: asset_qty.to_string(),
                paid_usdc: payout_usdc.to_string(),
                by: "owner".to_string(),
            });

        } else {
            // H8 fix: Payout failed — revert floor to Active so it can be retried or closed.
            {
                let floor_mut = self.floors.get_mut(&floor_id).unwrap();
                floor_mut.status = FloorStatus::Active;
            }

            // Revert totals: move pending back to reserved
            {
                let t = self.totals.entry(usdc_id.clone()).or_insert_with(Totals::default);
                t.pending = t.pending.saturating_sub(payout_usdc);
                t.reserved += payout_usdc;
            }

            // Restore sleeve reservation
            {
                if let Some(sleeve) = self.sleeves.get_mut(&floor.sleeve) {
                    sleeve.reserved_usdc += payout_usdc;
                }
            }

            let owner = floor.owner.clone();
            crate::events::emit_payout_failed(&crate::events::PayoutFailedEvent {
                floor_id: floor_id.to_string(),
                owner: owner.to_string(),
                asset: usdc_id,
                amount: payout_usdc.to_string(),
                reason: "mt_transfer failed".to_string(),
            });
        }

        // Assert solvency
        if let Some(t) = self.totals.get(&floor.asset) {
            t.assert_solvent(&floor.asset);
        }
        if let Some(t) = self.totals.get(&self.params.usdc.clone()) {
            t.assert_usdc_solvent();
        }
    }

    /// Close an active floor early, returning tokens to the owner.
    #[payable]
    pub fn close(&mut self, floor_id: u64) -> Promise {
        near_sdk::require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "E_DEPOSIT: requires 1 yoctoNEAR"
        );

        let caller = env::predecessor_account_id();
        let floor = self.floors.get(&floor_id)
            .unwrap_or_else(|| env::panic_str("E_FLOOR_NOT_FOUND"));

        near_sdk::require!(floor.owner == caller, "E_NOT_FLOOR_OWNER");
        near_sdk::require!(floor.status == FloorStatus::Active, "E_FLOOR_NOT_ACTIVE");
        near_sdk::require!(!self.pause.global && !self.pause.close, "E_PAUSED");

        let qty = floor.qty;
        let reserved_usdc = floor.reserved_usdc;
        let asset = floor.asset.clone();
        let sleeve_id = floor.sleeve.clone();
        let owner = floor.owner.clone();

        // Transition to ClosePending before cross-contract transfer (reentrancy guard)
        {
            let floor_mut = self.floors.get_mut(&floor_id).unwrap();
            floor_mut.status = FloorStatus::ClosePending;
        }

        // Remove from held now (USDC is no longer reserved for this floor).
        // Do NOT release free_usdc / totals.free yet — that only happens in the
        // success callback so a concurrent mt_on_transfer cannot see inflated capacity.
        {
            let usdc_id = self.params.usdc.clone();
            let t = self.totals.entry(usdc_id).or_insert_with(Totals::default);
            t.reserved = t.reserved.saturating_sub(reserved_usdc);
            // held stays the same until on_close_transfer (asset qty deducted there)
        }
        // Reduce escrow immediately — tokens are leaving escrow on this transfer.
        {
            let t = self.totals.entry(asset.clone()).or_insert_with(Totals::default);
            t.escrow = t.escrow.saturating_sub(qty);
        }

        let intents = self.params.intents.clone();

        // Transfer tokens back to owner via intents.mt_transfer
        ext_intents::ext(intents)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_TRANSFER)
            .mt_transfer(owner, asset, U128(qty), None, Some("close floor".to_string()))
            .then(
                ext_floors_self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_close_transfer(floor_id, U128(qty)),
            )
    }

    #[private]
    pub fn on_close_transfer(&mut self, floor_id: u64, qty_returned: U128) {
        let success = matches!(
            env::promise_result_checked(0, usize::MAX),
            Ok(_)
        );
        let qty_returned = qty_returned.0;

        let floor = match self.floors.get(&floor_id) {
            Some(f) => f.clone(),
            None => return,
        };

        near_sdk::require!(
            floor.status == FloorStatus::ClosePending,
            "E_UNEXPECTED_STATUS: expected ClosePending"
        );

        if success {
            let floor_mut = self.floors.get_mut(&floor_id).unwrap();
            floor_mut.status = FloorStatus::Closed;
            floor_mut.qty = 0;

            // Reduce held since tokens left the contract
            {
                let t = self.totals.entry(floor.asset.clone()).or_insert_with(Totals::default);
                t.held = t.held.saturating_sub(qty_returned);
            }

            // Transfer succeeded: now safe to release reserved USDC back to sleeve capacity.
            // (close() already subtracted totals.reserved; here we add back to free.)
            {
                let usdc_id = self.params.usdc.clone();
                let t = self.totals.entry(usdc_id).or_insert_with(Totals::default);
                t.free += floor.reserved_usdc;
            }
            if let Some(sleeve) = self.sleeves.get_mut(&floor.sleeve) {
                sleeve.reserved_usdc = sleeve.reserved_usdc.saturating_sub(floor.reserved_usdc);
                sleeve.free_usdc += floor.reserved_usdc;
            }

            crate::events::emit_floor_closed(&crate::events::FloorClosedEvent {
                floor_id,
                owner: floor.owner.to_string(),
                qty_returned: qty_returned.to_string(),
                unlocked_usdc: floor.reserved_usdc.to_string(),
            });
        } else {
            // Transfer failed: reverse the close state.
            // close() already subtracted totals.reserved — restore it.
            {
                let usdc_id = self.params.usdc.clone();
                let t = self.totals.entry(usdc_id).or_insert_with(Totals::default);
                t.reserved += floor.reserved_usdc;
            }
            // Restore asset escrow (close() already subtracted it).
            {
                let t = self.totals.entry(floor.asset.clone()).or_insert_with(Totals::default);
                t.escrow += qty_returned;
            }
            // Restore floor to Active.
            if let Some(floor_mut) = self.floors.get_mut(&floor_id) {
                floor_mut.status = FloorStatus::Active;
            }
        }

        if let Some(t) = self.totals.get(&floor.asset) {
            t.assert_solvent(&floor.asset);
        }
        if let Some(t) = self.totals.get(&self.params.usdc.clone()) {
            t.assert_usdc_solvent();
        }
    }

    /// Expire floors that have passed their expiry timestamp.
    /// Permissionless — anyone can call. Processes up to `expire_batch_max` ids.
    /// Caller must attach exactly N yoctoNEAR where N = ids.len(), since each
    /// mt_transfer call requires 1 yoctoNEAR as deposit.
    /// H7: batch expire. L4: #[payable].
    #[payable]
    pub fn expire(&mut self, ids: Vec<u64>) -> Vec<Promise> {
        near_sdk::require!(!ids.is_empty(), "E_BAD_MSG: ids must not be empty");
        let required = NearToken::from_yoctonear(ids.len() as u128);
        near_sdk::require!(
            env::attached_deposit() >= required,
            "E_DEPOSIT: attach N yocto for N floors"
        );

        let batch_max = usize::from(self.params.expire_batch_max).max(1);
        let intents = self.params.intents.clone();
        let current_account = env::current_account_id();

        let mut promises = Vec::new();
        let gas_per_floor: u64 = GAS_TRANSFER.as_gas() + GAS_CALLBACK.as_gas();

        for (i, floor_id) in ids.iter().copied().enumerate() {
            // Enforce batch limit
            if i >= batch_max {
                break;
            }
            // Guard against gas exhaustion
            let used = env::used_gas().as_gas();
            let total = env::prepaid_gas().as_gas();
            if total.saturating_sub(used) < gas_per_floor * 2 {
                break;
            }

            let floor = match self.floors.get(&floor_id) {
                Some(f) => f.clone(),
                None => continue,
            };

            if floor.status != FloorStatus::Active {
                continue;
            }
            if env::block_timestamp() < floor.expires_ns {
                continue;
            }

            let qty = floor.qty;
            let reserved_usdc = floor.reserved_usdc;
            let asset = floor.asset.clone();
            let sleeve_id = floor.sleeve.clone();
            let owner = floor.owner.clone();

            // Transition to ExpirePending (reentrancy guard)
            {
                let floor_mut = self.floors.get_mut(&floor_id).unwrap();
                floor_mut.status = FloorStatus::ExpirePending;
            }

            // Remove from reserved now; do NOT release free_usdc yet (deferred to callback).
            {
                let usdc_id = self.params.usdc.clone();
                let t = self.totals.entry(usdc_id).or_insert_with(Totals::default);
                t.reserved = t.reserved.saturating_sub(reserved_usdc);
            }
            // Reduce escrow — tokens are leaving escrow on this transfer.
            {
                let t = self.totals.entry(asset.clone()).or_insert_with(Totals::default);
                t.escrow = t.escrow.saturating_sub(qty);
            }

            let p = ext_intents::ext(intents.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(GAS_TRANSFER)
                .mt_transfer(owner, asset, U128(qty), None, Some("expire floor".to_string()))
                .then(
                    ext_floors_self::ext(current_account.clone())
                        .with_static_gas(GAS_CALLBACK)
                        .on_expire_transfer(floor_id, U128(qty)),
                );
            promises.push(p);
        }

        promises
    }

    #[private]
    pub fn on_expire_transfer(&mut self, floor_id: u64, qty_returned: U128) {
        let success = matches!(
            env::promise_result_checked(0, usize::MAX),
            Ok(_)
        );
        let qty_returned = qty_returned.0;

        let floor = match self.floors.get(&floor_id) {
            Some(f) => f.clone(),
            None => return,
        };

        near_sdk::require!(
            floor.status == FloorStatus::ExpirePending,
            "E_UNEXPECTED_STATUS: expected ExpirePending"
        );

        if success {
            let floor_mut = self.floors.get_mut(&floor_id).unwrap();
            floor_mut.status = FloorStatus::Expired;
            floor_mut.qty = 0;

            // Reduce held
            {
                let t = self.totals.entry(floor.asset.clone()).or_insert_with(Totals::default);
                t.held = t.held.saturating_sub(qty_returned);
            }

            // Transfer succeeded: now safe to release reserved USDC back to sleeve capacity.
            {
                let usdc_id = self.params.usdc.clone();
                let t = self.totals.entry(usdc_id).or_insert_with(Totals::default);
                t.free += floor.reserved_usdc;
            }
            if let Some(sleeve) = self.sleeves.get_mut(&floor.sleeve) {
                sleeve.reserved_usdc = sleeve.reserved_usdc.saturating_sub(floor.reserved_usdc);
                sleeve.free_usdc += floor.reserved_usdc;
            }

            crate::events::emit_floor_expired(&crate::events::FloorExpiredEvent {
                floor_id,
                owner: floor.owner.to_string(),
                qty_returned: qty_returned.to_string(),
                unlocked_usdc: floor.reserved_usdc.to_string(),
            });
        } else {
            // Transfer failed: restore reserved and escrow.
            {
                let usdc_id = self.params.usdc.clone();
                let t = self.totals.entry(usdc_id).or_insert_with(Totals::default);
                t.reserved += floor.reserved_usdc;
            }
            {
                let t = self.totals.entry(floor.asset.clone()).or_insert_with(Totals::default);
                t.escrow += qty_returned;
            }
            if let Some(floor_mut) = self.floors.get_mut(&floor_id) {
                floor_mut.status = FloorStatus::Active;
            }
        }

        if let Some(t) = self.totals.get(&floor.asset) {
            t.assert_solvent(&floor.asset);
        }
        if let Some(t) = self.totals.get(&self.params.usdc.clone()) {
            t.assert_usdc_solvent();
        }
    }

    /// Callback after the USDC payout initiated by auto_protect / execute_floor_sell.
    #[private]
    pub fn on_auto_protect_sell_payout(
        &mut self,
        floor_id: u64,
        payout_usdc: U128,
        asset_qty: U128,
        reserved_usdc: U128,
    ) {
        let payout_usdc = payout_usdc.0;
        let asset_qty = asset_qty.0;
        let reserved_usdc = reserved_usdc.0;

        let success = matches!(
            env::promise_result_checked(0, usize::MAX),
            Ok(_)
        );

        let floor = match self.floors.get(&floor_id) {
            Some(f) => f.clone(),
            None => return,
        };

        near_sdk::require!(
            floor.status == FloorStatus::PayoutPending,
            "E_UNEXPECTED_STATUS: expected PayoutPending"
        );

        let usdc_id = self.params.usdc.clone();

        if success {
            // Finalize: deduct from held and pending
            {
                let t = self.totals.entry(usdc_id.clone()).or_insert_with(Totals::default);
                t.held = t.held.saturating_sub(payout_usdc);
                t.pending = t.pending.saturating_sub(payout_usdc);
            }
            // Asset: escrow → delivered
            {
                let t = self.totals.entry(floor.asset.clone()).or_insert_with(Totals::default);
                t.escrow = t.escrow.saturating_sub(asset_qty);
                t.delivered += asset_qty;
            }
            // Sleeve: track delivered, release surplus
            {
                if let Some(sleeve) = self.sleeves.get_mut(&floor.sleeve) {
                    let surplus = reserved_usdc.saturating_sub(payout_usdc);
                    sleeve.free_usdc += surplus;
                    let delivered = sleeve.delivered.entry(floor.asset.clone()).or_insert(0);
                    *delivered += asset_qty;
                }
            }
            // Mark floor Sold
            {
                let floor_mut = self.floors.get_mut(&floor_id).unwrap();
                floor_mut.status = FloorStatus::Sold;
                floor_mut.qty = 0;
            }

            crate::events::emit_floor_sold(&crate::events::FloorSoldEvent {
                floor_id,
                owner: floor.owner.to_string(),
                qty: asset_qty.to_string(),
                paid_usdc: payout_usdc.to_string(),
                by: "auto_protect".to_string(),
            });
        } else {
            // Payout failed — revert floor to Active so it can be retried.
            {
                let floor_mut = self.floors.get_mut(&floor_id).unwrap();
                floor_mut.status = FloorStatus::Active;
            }
            // Revert totals: move pending back to reserved
            {
                let t = self.totals.entry(usdc_id.clone()).or_insert_with(Totals::default);
                t.pending = t.pending.saturating_sub(payout_usdc);
                t.reserved += reserved_usdc;
            }
            // Restore sleeve reservation
            {
                if let Some(sleeve) = self.sleeves.get_mut(&floor.sleeve) {
                    sleeve.reserved_usdc += reserved_usdc;
                }
            }

            crate::events::emit_payout_failed(&crate::events::PayoutFailedEvent {
                floor_id: floor_id.to_string(),
                owner: floor.owner.to_string(),
                asset: usdc_id.clone(),
                amount: payout_usdc.to_string(),
                reason: "auto_protect mt_transfer failed".to_string(),
            });
        }

        if let Some(t) = self.totals.get(&floor.asset) {
            t.assert_solvent(&floor.asset);
        }
        if let Some(t) = self.totals.get(&self.params.usdc.clone()) {
            t.assert_usdc_solvent();
        }
    }

    /// Retry a payout for a floor in PayoutPending state (legacy credit path).
    /// Permissionless.
    pub fn retry_payout(&mut self, floor_id: u64) -> Promise {
        let floor = self.floors.get(&floor_id)
            .unwrap_or_else(|| env::panic_str("E_FLOOR_NOT_FOUND"));

        near_sdk::require!(
            floor.status == FloorStatus::PayoutPending,
            "E_FLOOR_NOT_PAYOUT_PENDING"
        );

        let owner = floor.owner.clone();
        let usdc_id = self.params.usdc.clone();
        let credit_key = (owner.clone(), usdc_id.clone());
        let credit_amount = self.credits.get(&credit_key).copied().unwrap_or(0);
        near_sdk::require!(credit_amount > 0, "E_NO_CREDIT: no pending credit for this floor owner");

        // Move credits → pending
        {
            let t = self.totals.entry(usdc_id.clone()).or_insert_with(Totals::default);
            t.credits = t.credits.saturating_sub(credit_amount);
            t.pending += credit_amount;
        }
        self.credits.remove(&credit_key);

        let intents_contract = self.params.intents.clone();
        ext_intents::ext(intents_contract)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_TRANSFER)
            .mt_transfer(owner, usdc_id, U128(credit_amount), None, Some("retry payout".to_string()))
            .then(
                ext_floors_self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_retry_payout(floor_id, U128(credit_amount)),
            )
    }

    #[private]
    pub fn on_retry_payout(&mut self, floor_id: u64, payout_usdc: U128) {
        let payout_usdc = payout_usdc.0;
        let success = matches!(
            env::promise_result_checked(0, usize::MAX),
            Ok(_)
        );

        let floor = match self.floors.get(&floor_id) {
            Some(f) => f.clone(),
            None => return,
        };

        let usdc_id = self.params.usdc.clone();
        let owner = floor.owner.clone();

        if success {
            // Payout succeeded
            {
                let t = self.totals.entry(usdc_id.clone()).or_insert_with(Totals::default);
                t.held = t.held.saturating_sub(payout_usdc);
                t.pending = t.pending.saturating_sub(payout_usdc);
            }
            {
                let floor_mut = self.floors.get_mut(&floor_id).unwrap();
                floor_mut.status = FloorStatus::Sold;
            }
            crate::events::emit_payout_retried(&crate::events::PayoutRetriedEvent {
                floor_id: floor_id.to_string(),
                owner: owner.to_string(),
                asset: usdc_id.clone(),
                amount: payout_usdc.to_string(),
                ok: true,
            });
        } else {
            // Still failed: put credits back
            {
                let t = self.totals.entry(usdc_id.clone()).or_insert_with(Totals::default);
                t.pending = t.pending.saturating_sub(payout_usdc);
                t.credits += payout_usdc;
            }
            let credit_key = (owner.clone(), usdc_id.clone());
            let existing = self.credits.get(&credit_key).copied().unwrap_or(0);
            self.credits.insert(credit_key, existing + payout_usdc);

            crate::events::emit_payout_retried(&crate::events::PayoutRetriedEvent {
                floor_id: floor_id.to_string(),
                owner: owner.to_string(),
                asset: usdc_id.clone(),
                amount: payout_usdc.to_string(),
                ok: false,
            });
        }

        if let Some(t) = self.totals.get(&self.params.usdc.clone()) {
            t.assert_usdc_solvent();
        }
    }
}

