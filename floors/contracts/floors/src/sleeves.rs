use crate::receivers::PythPrice;
use crate::state::{Sleeve, Totals};
use crate::{Contract, ContractExt};
use near_sdk::{near, env};

#[near]
impl Contract {
    /// Create a sleeve runtime entry and optionally seed it with USDC.
    ///
    /// This is an admin-only bootstrap method for testnet. It creates the
    /// `Sleeve` in the on-chain `LookupMap` so that `mt_on_transfer` can
    /// find it. The `initial_usdc_e6` is credited as `free_usdc` on the
    /// sleeve **and** added to USDC totals (held + free) so the solvency
    /// invariant holds.
    ///
    /// For production, sleeve funding will happen via actual USDC deposits.
    /// For testnet, call this once per sleeve after `init_params`.
    ///
    /// Panics if the sleeve already exists in runtime state.
    pub fn init_sleeve(&mut self, sleeve_id: String, initial_usdc_e6: Option<String>) {
        self.assert_admin();

        // Sleeve must be configured in params
        near_sdk::require!(
            self.params.sleeves.contains_key(&sleeve_id),
            "E_BAD_MSG: sleeve_id not found in params.sleeves"
        );

        // Must not already exist in runtime state
        near_sdk::require!(
            self.sleeves.get(&sleeve_id).is_none(),
            "E_BAD_MSG: sleeve already exists in runtime state"
        );

        let usdc_amount: u128 = initial_usdc_e6
            .as_deref()
            .unwrap_or("0")
            .parse()
            .unwrap_or_else(|_| env::panic_str("E_BAD_MSG: invalid initial_usdc_e6"));

        let mut sleeve = Sleeve::new(sleeve_id.clone());
        sleeve.free_usdc = usdc_amount;
        self.sleeves.insert(sleeve_id.clone(), sleeve);

        // Update USDC totals so solvency invariant holds
        if usdc_amount > 0 {
            let usdc_id = self.params.usdc.clone();
            let t = self.totals.entry(usdc_id).or_insert_with(Totals::default);
            t.held += usdc_amount;
            t.free += usdc_amount;
        }

        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"floors\",\"version\":\"1.0.0\",\"event\":\"sleeve_initialized\",\"data\":{{\"sleeve_id\":\"{}\",\"initial_usdc_e6\":\"{}\"}}}}",
            sleeve_id, usdc_amount
        ));
    }

    // -----------------------------------------------------------------------
    // Embedded mock Pyth oracle (testnet only)
    //
    // When params.pyth points to the contract itself, the cross-contract call
    // becomes a local call. These methods implement the Pyth oracle interface
    // so the contract can serve as its own price oracle for testnet.
    // -----------------------------------------------------------------------

    /// Set a mock price for a feed. Admin only. Testnet bootstrap.
    pub fn set_mock_price(&mut self, feed_id: String, price: i64, expo: i32) {
        self.assert_admin();
        let publish_time = env::block_timestamp(); // nanoseconds
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"floors\",\"version\":\"1.0.0\",\"event\":\"mock_price_set\",\"data\":{{\"feed_id\":\"{}\",\"price\":{},\"expo\":{},\"publish_time\":{}}}}}",
            feed_id, price, expo, publish_time
        ));
        // Store price in a simple JSON log for the callback to find.
        // We use the existing state: store in used_quotes with a special prefix.
        // Actually, simpler: just store it as a contract view.
        // The mock_prices are stored via env::storage_write.
        let key = format!("mock_price:{}", feed_id);
        let value = serde_json::to_vec(&PythPrice { price, expo, publish_time }).unwrap();
        env::storage_write(key.as_bytes(), &value);
    }

    /// Mock Pyth oracle view: get_price_no_older_than.
    /// Returns the stored mock price if it exists and is fresh enough.
    pub fn get_price_no_older_than(&self, price_id: String, age: u32) -> Option<PythPrice> {
        let key = format!("mock_price:{}", price_id);
        let data = env::storage_read(key.as_bytes())?;
        let entry: PythPrice = serde_json::from_slice(&data).ok()?;
        let now_ns = env::block_timestamp();
        let age_ns = u64::from(age) * 1_000_000_000;
        if now_ns.saturating_sub(entry.publish_time) <= age_ns {
            Some(entry)
        } else {
            None
        }
    }
}
