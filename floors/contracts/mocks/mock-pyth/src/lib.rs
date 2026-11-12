use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Prices,
}

/// A price entry stored in the mock oracle.
#[near(serializers = [borsh, json])]
#[derive(Debug, Clone)]
pub struct MockPrice {
    pub price: i64,
    pub expo: i32,
    pub publish_time: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockPyth {
    admin: AccountId,
    prices: LookupMap<String, MockPrice>,
}

#[near]
impl MockPyth {
    #[init]
    pub fn new() -> Self {
        Self {
            admin: env::predecessor_account_id(),
            prices: LookupMap::new(StorageKey::Prices),
        }
    }

    /// Set or update a price feed. Admin only.
    pub fn set_price(&mut self, feed_id: String, price: i64, expo: i32, publish_time_ns: u64) {
        require!(env::predecessor_account_id() == self.admin, "E_NOT_ADMIN");
        self.prices.insert(
            feed_id,
            MockPrice {
                price,
                expo,
                publish_time: publish_time_ns,
            },
        );
    }

    /// Returns `None` if feed missing or older than `age` seconds.
    pub fn get_price_no_older_than(&self, price_id: String, age: u32) -> Option<MockPrice> {
        let entry = self.prices.get(&price_id)?;
        let now_ns = env::block_timestamp();
        let age_ns = u64::from(age) * 1_000_000_000;
        if now_ns.saturating_sub(entry.publish_time) <= age_ns {
            Some(entry.clone())
        } else {
            None
        }
    }
}
