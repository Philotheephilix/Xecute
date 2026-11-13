use near_sdk::store::{IterableMap, IterableSet, LookupMap, Vector};
use near_sdk::{near, AccountId, BorshStorageKey, PanicOnDefault};

mod admin;
mod assets;
mod errors;
mod events;
mod floors;
mod ledger;
mod migrate;
mod payouts;
mod quotes;
mod receivers;
mod sleeves;
mod state;
mod views;

pub use errors::FloorError;
pub use events::*;
pub use state::*;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Floors,
    FloorsByOwner,
    FloorsByOwnerInner { owner_hash: Vec<u8> },
    UsedQuotes,
    Sleeves,
    Credits,
    Totals,
    Unwinds,
    PendingChanges,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    version: state::StateVersion,
    params: state::Params,
    roles: state::Roles,
    pause: state::PauseFlags,
    floors: IterableMap<u64, state::Floor>,
    next_floor_id: u64,
    floors_by_owner: LookupMap<AccountId, IterableSet<u64>>,
    used_quotes: LookupMap<[u8; 32], u64>,
    sleeves: LookupMap<String, state::Sleeve>,
    credits: LookupMap<(AccountId, String), u128>,
    totals: LookupMap<String, state::Totals>,
    unwinds: IterableMap<u64, state::Unwind>,
    pending_changes: Vector<state::PendingChange>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        owner: AccountId,
        guardian: AccountId,
        quote_signers: Vec<[u8; 32]>,
        intents: AccountId,
        pyth: AccountId,
        platform_account: AccountId,
    ) -> Self {
        near_sdk::require!(!near_sdk::env::state_exists(), "Already initialized");
        near_sdk::require!(quote_signers.len() <= 2, "Max 2 quote signers");
        Self {
            version: state::StateVersion::V1,
            params: state::Params::new(intents, pyth, platform_account),
            roles: state::Roles::new(owner, guardian, quote_signers),
            pause: state::PauseFlags::default(),
            floors: IterableMap::new(StorageKey::Floors),
            next_floor_id: 0,
            floors_by_owner: LookupMap::new(StorageKey::FloorsByOwner),
            used_quotes: LookupMap::new(StorageKey::UsedQuotes),
            sleeves: LookupMap::new(StorageKey::Sleeves),
            credits: LookupMap::new(StorageKey::Credits),
            totals: LookupMap::new(StorageKey::Totals),
            unwinds: IterableMap::new(StorageKey::Unwinds),
            pending_changes: Vector::new(StorageKey::PendingChanges),
        }
    }

    pub fn get_version(&self) -> String {
        format!("{:?}", self.version)
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::receivers::{ceil_div_u128, floor_div_u128};
    use crate::state::{AssetConfig, Floor, FloorStatus, Sleeve, Totals};
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn owner() -> AccountId { accounts(0) }
    fn guardian() -> AccountId { accounts(1) }
    fn intents() -> AccountId { "intents.near".parse().unwrap() }
    fn pyth() -> AccountId { "pyth.near".parse().unwrap() }
    fn platform() -> AccountId { accounts(2) }
    fn user() -> AccountId { accounts(3) }

    fn test_contract() -> Contract {
        let context = VMContextBuilder::new()
            .predecessor_account_id(owner())
            .build();
        testing_env!(context);
        Contract {
            version: StateVersion::V1,
            params: Params::new(intents(), pyth(), platform()),
            roles: Roles::new(owner(), guardian(), vec![[0u8; 32]]),
            pause: PauseFlags::default(),
            floors: near_sdk::store::IterableMap::new(StorageKey::Floors),
            next_floor_id: 0,
            floors_by_owner: near_sdk::store::LookupMap::new(StorageKey::FloorsByOwner),
            used_quotes: near_sdk::store::LookupMap::new(StorageKey::UsedQuotes),
            sleeves: near_sdk::store::LookupMap::new(StorageKey::Sleeves),
            credits: near_sdk::store::LookupMap::new(StorageKey::Credits),
            totals: near_sdk::store::LookupMap::new(StorageKey::Totals),
            unwinds: near_sdk::store::IterableMap::new(StorageKey::Unwinds),
            pending_changes: near_sdk::store::Vector::new(StorageKey::PendingChanges),
        }
    }

    // -------------------------------------------------------------------------
    // Math tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_ceil_div() {
        // 100 * 3070890000 / 10^18 = 307.089 USDC → ceiling = 308 (in smallest units)
        // But let's use simpler numbers: qty=1, price=2000_000_000 (2000 USDC), dec=18
        // result = ceil(1 * 2000_000_000 / 10^18) = ceil(2e-9) = 1
        assert_eq!(ceil_div_u128(1, 2_000_000_000, 10u128.pow(18)), 1);

        // qty = 10^18 (1 whole token), price = 3070890000 (3070.89 USDC), dec=18
        // result = ceil(10^18 * 3070890000 / 10^18) = ceil(3070890000) = 3070890000
        assert_eq!(ceil_div_u128(10u128.pow(18), 3_070_890_000, 10u128.pow(18)), 3_070_890_000);

        // Rounding up: qty=3, price=10, divisor=4 → ceil(30/4) = ceil(7.5) = 8
        assert_eq!(ceil_div_u128(3, 10, 4), 8);

        // Exact: qty=4, price=10, divisor=4 → ceil(40/4) = 10
        assert_eq!(ceil_div_u128(4, 10, 4), 10);
    }

    #[test]
    fn test_floor_div() {
        // floor(3 * 10 / 4) = floor(7.5) = 7
        assert_eq!(floor_div_u128(3, 10, 4), 7);

        // floor(4 * 10 / 4) = 10
        assert_eq!(floor_div_u128(4, 10, 4), 10);

        // 1 ETH at $3070.89 → floor(10^18 * 3070890000 / 10^18) = 3070890000
        assert_eq!(floor_div_u128(10u128.pow(18), 3_070_890_000, 10u128.pow(18)), 3_070_890_000);
    }

    // -------------------------------------------------------------------------
    // Floor state tests
    // -------------------------------------------------------------------------

    fn insert_test_floor(contract: &mut Contract, expires_ns: u64) -> u64 {
        let floor_id = contract.next_floor_id;
        contract.next_floor_id += 1;

        let asset = "nep141:eth.omft.near".to_string();
        let floor = Floor {
            owner: user(),
            asset: asset.clone(),
            qty: 10u128.pow(18),
            floor_price_e6: 3_070_890_000,
            reserved_usdc: 3_070_890_000,
            sleeve: "majors".to_string(),
            fee_usdc: 100_000,
            opened_ns: 1_000_000_000,
            expires_ns,
            status: FloorStatus::Active,
        };
        contract.floors.insert(floor_id, floor);

        // Totals
        let t = contract.totals.entry(asset.clone()).or_insert_with(Totals::default);
        t.held += 10u128.pow(18);
        t.escrow += 10u128.pow(18);

        let usdc_id = contract.params.usdc.clone();
        let tu = contract.totals.entry(usdc_id).or_insert_with(Totals::default);
        tu.held += 3_070_890_000 + 100_000;
        tu.reserved += 3_070_890_000;
        tu.free += 100_000; // fee to sleeve

        // Sleeve
        let mut sleeve = Sleeve::new("majors".to_string());
        sleeve.reserved_usdc = 3_070_890_000;
        sleeve.free_usdc = 100_000;
        contract.sleeves.insert("majors".to_string(), sleeve);

        floor_id
    }

    #[test]
    fn test_get_version() {
        let contract = test_contract();
        assert_eq!(contract.get_version(), "V1");
    }

    #[test]
    fn test_get_floor_returns_none_for_missing() {
        let contract = test_contract();
        assert!(contract.get_floor(999).is_none());
    }

    #[test]
    fn test_get_floor_returns_view() {
        let mut contract = test_contract();
        let context = VMContextBuilder::new()
            .predecessor_account_id(owner())
            .block_timestamp(500_000_000)
            .build();
        testing_env!(context);

        let floor_id = insert_test_floor(&mut contract, 2_000_000_000);
        let view = contract.get_floor(floor_id).expect("floor should exist");
        assert_eq!(view.status, "Active");
        assert_eq!(view.owner, user().to_string());
    }

    #[test]
    fn test_list_floors_empty_for_unknown_owner() {
        let contract = test_contract();
        let floors = contract.list_floors(user(), None, None);
        assert!(floors.is_empty());
    }

    #[test]
    fn test_get_totals_returns_none_for_missing_asset() {
        let contract = test_contract();
        assert!(contract.get_totals("unknown".to_string()).is_none());
    }

    #[test]
    fn test_totals_assert_solvent_passes() {
        // A balanced totals struct should pass assert_solvent
        let mut t = Totals::default();
        t.held = 100;
        t.escrow = 60;
        t.delivered = 30;
        t.credits = 10;
        // 60 + 30 + 10 = 100 = held → solvent
        t.assert_solvent("test_asset");
    }

    #[test]
    #[should_panic(expected = "INVARIANT_VIOLATED")]
    fn test_totals_assert_solvent_fails() {
        let mut t = Totals::default();
        t.held = 50;
        t.escrow = 60; // escrow > held → insolvent
        t.assert_solvent("test_asset");
    }

    #[test]
    fn test_totals_assert_usdc_solvent_passes() {
        let mut t = Totals::default();
        t.held = 1000;
        t.reserved = 500;
        t.free = 300;
        t.platform = 100;
        t.credits = 100;
        // 500 + 300 + 100 + 100 = 1000 = held
        t.assert_usdc_solvent();
    }

    #[test]
    fn test_quote_hold_and_release() {
        let mut contract = test_contract();
        let quote_id = [1u8; 32];
        assert!(!contract.quote_is_used(&quote_id));
        contract.hold_quote(quote_id, 9999999);
        assert!(contract.quote_is_used(&quote_id));
        contract.release_quote(quote_id);
        assert!(!contract.quote_is_used(&quote_id));
    }

    #[test]
    #[should_panic(expected = "E_QUOTE_USED")]
    fn test_quote_double_hold_panics() {
        let mut contract = test_contract();
        let quote_id = [2u8; 32];
        contract.hold_quote(quote_id, 9999999);
        contract.hold_quote(quote_id, 9999999); // should panic
    }

    #[test]
    fn test_sleeve_view() {
        let mut contract = test_contract();
        let sleeve = Sleeve::new("majors".to_string());
        contract.sleeves.insert("majors".to_string(), sleeve);
        let view = contract.get_sleeve("majors".to_string()).expect("sleeve");
        assert_eq!(view.id, "majors");
        assert_eq!(view.free_usdc, "0");
    }
}
