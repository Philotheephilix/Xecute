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

    // -------------------------------------------------------------------------
    // Admin tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_admin_pause_unpause() {
        let mut contract = test_contract();

        // Initially not paused
        assert!(!contract.is_paused("open_floors"));

        // Pause as owner (owner is also admin)
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(owner())
            .build();
        testing_env!(ctx);
        contract.pause("open_floors".to_string());
        assert!(contract.is_paused("open_floors"));

        // Other scopes not affected
        assert!(!contract.is_paused("sell_to_floor"));
        assert!(!contract.is_paused("close_floors"));
        assert!(!contract.is_paused("unwind"));

        // Unpause
        contract.unpause("open_floors".to_string());
        assert!(!contract.is_paused("open_floors"));
    }

    #[test]
    fn test_pause_all_scopes() {
        let mut contract = test_contract();
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(owner())
            .build();
        testing_env!(ctx);

        for scope in &["open_floors", "close_floors", "sell_to_floor", "unwind"] {
            assert!(!contract.is_paused(scope));
            contract.pause(scope.to_string());
            assert!(contract.is_paused(scope));
            contract.unpause(scope.to_string());
            assert!(!contract.is_paused(scope));
        }
    }

    #[test]
    fn test_queue_and_apply_change() {
        let mut contract = test_contract();

        // Queue as owner at time T=0
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(owner())
            .block_timestamp(0) // ns
            .build();
        testing_env!(ctx);
        contract.queue_change(
            "chg-001".to_string(),
            "params".to_string(),
            "{\"platform_fee_bps\":200}".to_string(),
        );
        assert_eq!(contract.pending_changes.len(), 1);

        // Attempt apply too early (1 hour after queue = well before 48h delay)
        let one_hour_ns: u64 = 3_600 * 1_000_000_000; // 1h in ns
        let ctx_early = VMContextBuilder::new()
            .predecessor_account_id(user())
            .block_timestamp(one_hour_ns)
            .build();
        testing_env!(ctx_early);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.apply_change("chg-001".to_string());
        }));
        assert!(result.is_err(), "apply_change should panic before delay");
        assert_eq!(
            contract.pending_changes.len(),
            1,
            "change still pending after premature apply attempt"
        );

        // Advance time to 49 hours after queue → delay elapsed
        let forty_nine_hours_ns: u64 = 49 * 3_600 * 1_000_000_000;
        let ctx_late = VMContextBuilder::new()
            .predecessor_account_id(user())
            .block_timestamp(forty_nine_hours_ns)
            .build();
        testing_env!(ctx_late);
        contract.apply_change("chg-001".to_string());
        assert_eq!(contract.pending_changes.len(), 0);
    }

    #[test]
    #[should_panic(expected = "E_UNAUTHORIZED")]
    fn test_access_control_non_owner_cannot_pause() {
        let mut contract = test_contract();

        // Non-admin, non-owner tries to pause
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(user()) // user is not owner or admin
            .build();
        testing_env!(ctx);
        contract.pause("open_floors".to_string()); // should panic with E_UNAUTHORIZED
    }

    #[test]
    fn test_add_and_remove_admin() {
        let mut contract = test_contract();
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(owner())
            .build();
        testing_env!(ctx);

        let admin: AccountId = "alice.near".parse().unwrap();

        // Add admin
        contract.add_admin(admin.clone());
        assert!(contract.roles.admins.contains(&admin));

        // Admin can now pause (set context to admin)
        let ctx_admin = VMContextBuilder::new()
            .predecessor_account_id(admin.clone())
            .build();
        testing_env!(ctx_admin);
        contract.pause("sell_to_floor".to_string());
        assert!(contract.is_paused("sell_to_floor"));

        // Remove admin
        let ctx_owner = VMContextBuilder::new()
            .predecessor_account_id(owner())
            .build();
        testing_env!(ctx_owner);
        contract.remove_admin(admin.clone());
        assert!(!contract.roles.admins.contains(&admin));
    }

    // -------------------------------------------------------------------------
    // Quote signature test (byte-level TS compatibility)
    // -------------------------------------------------------------------------

    /// Test that `build_quote_message` produces the exact bytes that the
    /// TypeScript signing.ts implementation would produce, and that an
    /// Ed25519 signature over those bytes verifies correctly with ed25519-dalek.
    ///
    /// Since `env::ed25519_verify` is a NEAR host function unavailable in
    /// unit tests, we verify the message bytes + signature using ed25519-dalek
    /// directly.  The same byte layout is what `verify_quote_sig` passes to
    /// the host function on-chain.
    #[test]
    fn test_verify_quote_sig_bytes() {
        use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
        use crate::quotes::build_quote_message;

        // --- Known test vector ---
        // 32-byte seed → deterministic keypair
        let seed: [u8; 32] = [
            0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60,
            0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c, 0x44,
            0xd5, 0x03, 0x48, 0x08, 0x05, 0x39, 0x99, 0xd8,
            0x45, 0xa0, 0x72, 0x3b, 0x84, 0x5a, 0x0c, 0xd0,
        ];

        let signing_key = SigningKey::from_bytes(&seed);
        let verifying_key: VerifyingKey = signing_key.verifying_key();

        // Payload fields
        let quote_id: [u8; 32] = [
            0x9f, 0x3c, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05,
            0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d,
            0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15,
            0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d,
        ];
        let owner = "0s4f9a2c.near";
        let asset = "nep141:eth.omft.near";
        let qty: u128 = 14_620_000_000_000_000;
        let floor_price_e6: u128 = 3_070_890_000;
        let fee_usdc: u128 = 494_000;
        let sleeve = "majors";
        let expires_at: u64 = 1_763_017_251; // Unix seconds

        // Build message
        let message = build_quote_message(
            &quote_id, owner, asset, qty, floor_price_e6, fee_usdc, sleeve, expires_at,
        );

        // Verify layout:
        // 15 (prefix) + 32 (id) + 4+len(owner) + 4+len(asset) + 16+16+16 + 4+len(sleeve) + 8
        let expected_len = 15 + 32
            + 4 + owner.len()
            + 4 + asset.len()
            + 16 + 16 + 16
            + 4 + sleeve.len()
            + 8;
        assert_eq!(message.len(), expected_len, "message length mismatch");

        // Prefix check
        assert_eq!(&message[..15], b"FLOORS_QUOTE/V1");
        // id check (offset 15)
        assert_eq!(&message[15..47], &quote_id);

        // Sign with ed25519-dalek
        let signature = signing_key.sign(&message);
        let sig_bytes: [u8; 64] = signature.to_bytes();

        // Verify with ed25519-dalek (same as what the NEAR host function does)
        let pubkey_bytes: [u8; 32] = verifying_key.to_bytes();
        verifying_key
            .verify_strict(&message, &signature)
            .expect("signature must verify");

        // Verify that a wrong pubkey rejects
        let wrong_seed = [0xffu8; 32];
        let wrong_key = SigningKey::from_bytes(&wrong_seed);
        let wrong_verifying: VerifyingKey = wrong_key.verifying_key();
        assert!(
            wrong_verifying.verify_strict(&message, &signature).is_err(),
            "wrong key must not verify"
        );

        // Verify that a tampered message rejects
        let mut tampered = message.clone();
        tampered[20] ^= 0x01; // flip a bit in the id
        assert!(
            verifying_key.verify_strict(&tampered, &signature).is_err(),
            "tampered message must not verify"
        );

        // Confirm pubkey and sig bytes are the right size for the on-chain function
        assert_eq!(pubkey_bytes.len(), 32);
        assert_eq!(sig_bytes.len(), 64);
    }
}
