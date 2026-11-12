use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise,
};

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Balances,
    Registered,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockFt {
    name: String,
    symbol: String,
    decimals: u8,
    total_supply: u128,
    balances: LookupMap<AccountId, u128>,
    registered: LookupMap<AccountId, bool>,
}

#[near]
impl MockFt {
    /// Deploy with initial mint to `env::predecessor_account_id()`.
    #[init]
    pub fn new(name: String, symbol: String, decimals: u8, total_supply: U128) -> Self {
        let caller = env::predecessor_account_id();
        let supply: u128 = total_supply.into();
        let mut balances = LookupMap::new(StorageKey::Balances);
        let mut registered = LookupMap::new(StorageKey::Registered);
        balances.insert(caller.clone(), supply);
        registered.insert(caller, true);
        Self {
            name,
            symbol,
            decimals,
            total_supply: supply,
            balances,
            registered,
        }
    }

    // --- NEP-141 core ---

    pub fn ft_transfer(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        #[allow(unused_variables)] memo: Option<String>,
    ) {
        let sender = env::predecessor_account_id();
        let amt: u128 = amount.into();
        require!(amt > 0, "Amount must be positive");
        let sender_bal = self.balances.get(&sender).copied().unwrap_or(0);
        require!(sender_bal >= amt, "Insufficient balance");
        self.balances.insert(sender, sender_bal - amt);
        let receiver_bal = self.balances.get(&receiver_id).copied().unwrap_or(0);
        self.balances.insert(receiver_id, receiver_bal + amt);
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.balances.get(&account_id).copied().unwrap_or(0).into()
    }

    pub fn ft_total_supply(&self) -> U128 {
        self.total_supply.into()
    }

    // --- NEP-145 storage registration ---

    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        #[allow(unused_variables)] registration_only: Option<bool>,
    ) -> serde_json::Value {
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        if !self.registered.contains_key(&account) {
            self.registered.insert(account.clone(), true);
            if !self.balances.contains_key(&account) {
                self.balances.insert(account, 0);
            }
        }
        serde_json::json!({
            "total": NearToken::from_yoctonear(0).as_yoctonear().to_string(),
            "available": NearToken::from_yoctonear(0).as_yoctonear().to_string(),
        })
    }

    pub fn storage_unregister(&mut self, #[allow(unused_variables)] force: Option<bool>) -> bool {
        let account = env::predecessor_account_id();
        let bal = self.balances.get(&account).copied().unwrap_or(0);
        require!(bal == 0, "Non-zero balance; burn first");
        self.registered.remove(&account);
        self.balances.remove(&account);
        true
    }

    /// Mint tokens to any account (no-auth, test helper only).
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        let amt: u128 = amount.into();
        let bal = self.balances.get(&account_id).copied().unwrap_or(0);
        self.balances.insert(account_id.clone(), bal + amt);
        self.total_supply += amt;
        if !self.registered.contains_key(&account_id) {
            self.registered.insert(account_id, true);
        }
    }
}

#[near]
impl MockFt {
    /// Stub ft_transfer_call — transfers then returns without callback (test-only).
    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        #[allow(unused_variables)] msg: String,
    ) -> Promise {
        self.ft_transfer(receiver_id.clone(), amount, memo);
        Promise::new(receiver_id)
    }
}
