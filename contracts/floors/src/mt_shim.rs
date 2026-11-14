//! NEP-245 multi-token shim for testnet self-referencing deployment.
//!
//! On testnet `params.intents == floors-dev.testnet` (the contract itself),
//! so every `ext_intents::mt_transfer(...)` call lands here. This module
//! translates NEP-245 calls into NEP-141 `ft_transfer` / `ft_balance_of`
//! on the underlying token contract whose account is encoded in the
//! `nep141:<account>` token id.
//!
//! Special case: when receiver_id == current_account_id (self-transfer),
//! NEP-141 ft_transfer panics with "Sender and receiver should be different".
//! In this case we skip the ft_transfer and return a no-op promise, since the
//! tokens are already in the right account.

use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId, NearToken, Promise};

use crate::{Contract, ContractExt};

// ---------------------------------------------------------------------------
// External NEP-141 interface
// ---------------------------------------------------------------------------

#[near_sdk::ext_contract(ext_ft)]
pub trait Ft {
    fn ft_transfer(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
    );

    fn ft_balance_of(&self, account_id: AccountId) -> U128;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Strip the `nep141:` prefix and parse the remainder as an AccountId.
fn parse_nep141_token(token_id: &str) -> AccountId {
    let raw = token_id
        .strip_prefix("nep141:")
        .unwrap_or_else(|| env::panic_str("E_BAD_TOKEN_ID: expected nep141: prefix"));
    raw.parse::<AccountId>()
        .unwrap_or_else(|_| env::panic_str("E_BAD_TOKEN_ID: invalid account in token_id"))
}

// ---------------------------------------------------------------------------
// NEP-245 shim methods
// ---------------------------------------------------------------------------

#[near]
impl Contract {
    /// NEP-245 `mt_transfer` shim.
    ///
    /// Translates to `ft_transfer` on the underlying NEP-141 token contract
    /// identified by the `nep141:<account>` token id.
    ///
    /// When `receiver_id` is the current contract (self-transfer), skips
    /// the ft_transfer (NEP-141 panics on sender == receiver) and returns
    /// a no-op promise that always succeeds.
    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        _approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    ) -> Promise {
        let token_contract = parse_nep141_token(&token_id);

        // Self-transfer: tokens already sit in this contract's account on the
        // token contract, so there's nothing to move. Return a no-op promise
        // that resolves immediately so the chained callback sees success.
        // We call a view method on ourselves (which always succeeds) rather
        // than spawning a cross-contract call that would not complete before
        // the callback fires.
        if receiver_id == env::current_account_id() {
            // A self-call that returns immediately — the callback will see
            // promise_result_checked(0) == Ok(...)
            return Promise::new(env::current_account_id());
        }

        ext_ft::ext(token_contract)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(near_sdk::Gas::from_tgas(10))
            .ft_transfer(receiver_id, amount, memo)
    }

    /// NEP-245 `mt_balance_of` shim.
    ///
    /// Forwards to `ft_balance_of` on the underlying NEP-141 token contract.
    pub fn mt_balance_of(
        &self,
        account_id: AccountId,
        token_id: String,
    ) -> Promise {
        let token_contract = parse_nep141_token(&token_id);

        ext_ft::ext(token_contract)
            .with_static_gas(near_sdk::Gas::from_tgas(5))
            .ft_balance_of(account_id)
    }
}
