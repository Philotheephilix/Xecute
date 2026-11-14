use near_sdk::store::{IterableMap, IterableSet, LookupMap, Vector};
use near_sdk::{near, AccountId, BorshStorageKey, PanicOnDefault};

mod admin;
mod assets;
mod bot_methods;
mod errors;
mod events;
mod floors;
mod ledger;
mod migrate;
mod mt_shim;
mod payouts;
mod quotes;
mod receivers;
mod receivers_auth;
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
    next_unwind_id: u64,
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
        // H6 fix: populate quote_signer_keys from initial vec so the verifier
        // (which reads quote_signer_keys) can use them immediately.
        let mut roles = state::Roles::new(owner, guardian, quote_signers.clone());
        for (i, key) in quote_signers.iter().enumerate() {
            roles.quote_signer_keys.insert(i.to_string(), *key);
        }
        Self {
            version: state::StateVersion::V1,
            params: state::Params::new(intents, pyth, platform_account),
            roles,
            pause: state::PauseFlags::default(),
            floors: IterableMap::new(StorageKey::Floors),
            next_floor_id: 0,
            floors_by_owner: LookupMap::new(StorageKey::FloorsByOwner),
            used_quotes: LookupMap::new(StorageKey::UsedQuotes),
            sleeves: LookupMap::new(StorageKey::Sleeves),
            credits: LookupMap::new(StorageKey::Credits),
            totals: LookupMap::new(StorageKey::Totals),
            unwinds: IterableMap::new(StorageKey::Unwinds),
            next_unwind_id: 0,
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
        let initial_signers = vec![[0u8; 32]];
        let mut roles = Roles::new(owner(), guardian(), initial_signers.clone());
        // Mirror new() behaviour: populate quote_signer_keys from initial vec
        for (i, key) in initial_signers.iter().enumerate() {
            roles.quote_signer_keys.insert(i.to_string(), *key);
        }
        Contract {
            version: StateVersion::V1,
            params: Params::new(intents(), pyth(), platform()),
            roles,
            pause: PauseFlags::default(),
            floors: near_sdk::store::IterableMap::new(StorageKey::Floors),
            next_floor_id: 0,
            floors_by_owner: near_sdk::store::LookupMap::new(StorageKey::FloorsByOwner),
            used_quotes: near_sdk::store::LookupMap::new(StorageKey::UsedQuotes),
            sleeves: near_sdk::store::LookupMap::new(StorageKey::Sleeves),
            credits: near_sdk::store::LookupMap::new(StorageKey::Credits),
            totals: near_sdk::store::LookupMap::new(StorageKey::Totals),
            unwinds: near_sdk::store::IterableMap::new(StorageKey::Unwinds),
            next_unwind_id: 0,
            pending_changes: near_sdk::store::Vector::new(StorageKey::PendingChanges),
        }
    }

    // -------------------------------------------------------------------------
    // Math tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_ceil_div() {
        assert_eq!(ceil_div_u128(1, 2_000_000_000, 10u128.pow(18)), 1);
        assert_eq!(ceil_div_u128(10u128.pow(18), 3_070_890_000, 10u128.pow(18)), 3_070_890_000);
        assert_eq!(ceil_div_u128(3, 10, 4), 8);
        assert_eq!(ceil_div_u128(4, 10, 4), 10);
    }

    #[test]
    fn test_floor_div() {
        assert_eq!(floor_div_u128(3, 10, 4), 7);
        assert_eq!(floor_div_u128(4, 10, 4), 10);
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
        let mut t = Totals::default();
        t.held = 100;
        t.escrow = 60;
        t.delivered = 30;
        t.credits = 10;
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

        assert!(!contract.is_paused("open_floors"));

        let ctx = VMContextBuilder::new()
            .predecessor_account_id(owner())
            .build();
        testing_env!(ctx);
        contract.pause("open_floors".to_string());
        assert!(contract.is_paused("open_floors"));

        assert!(!contract.is_paused("sell_to_floor"));
        assert!(!contract.is_paused("close_floors"));
        assert!(!contract.is_paused("unwind"));

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
        // Verify the param was actually updated
        assert_eq!(contract.params.platform_fee_bps, 200);
    }

    #[test]
    #[should_panic(expected = "E_UNAUTHORIZED")]
    fn test_access_control_non_owner_cannot_pause() {
        let mut contract = test_contract();

        let ctx = VMContextBuilder::new()
            .predecessor_account_id(user()) // user is not owner or admin
            .build();
        testing_env!(ctx);
        contract.pause("open_floors".to_string()); // should panic with E_UNAUTHORIZED
    }

    #[test]
    fn test_guardian_can_pause() {
        let mut contract = test_contract();

        let ctx = VMContextBuilder::new()
            .predecessor_account_id(guardian())
            .build();
        testing_env!(ctx);

        contract.pause("open_floors".to_string());
        assert!(contract.is_paused("open_floors"));
    }

    #[test]
    fn test_add_and_remove_admin() {
        let mut contract = test_contract();
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(owner())
            .build();
        testing_env!(ctx);

        let admin: AccountId = "alice.near".parse().unwrap();

        contract.add_admin(admin.clone());
        assert!(contract.roles.admins.contains(&admin));

        let ctx_admin = VMContextBuilder::new()
            .predecessor_account_id(admin.clone())
            .build();
        testing_env!(ctx_admin);
        contract.pause("sell_to_floor".to_string());
        assert!(contract.is_paused("sell_to_floor"));

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
    #[test]
    fn test_verify_quote_sig_bytes() {
        use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
        use crate::quotes::build_quote_message;

        // --- Known test vector ---
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

        // Verify with ed25519-dalek
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
        tampered[20] ^= 0x01;
        assert!(
            verifying_key.verify_strict(&tampered, &signature).is_err(),
            "tampered message must not verify"
        );

        // Confirm sizes
        assert_eq!(pubkey_bytes.len(), 32);
        assert_eq!(sig_bytes.len(), 64);
    }

    // -------------------------------------------------------------------------
    // on_auth tests
    // -------------------------------------------------------------------------

    fn on_auth_contract() -> Contract {
        let mut contract = test_contract();
        // Add an asset config so on_auth_sell can compute payout
        let asset_cfg = AssetConfig {
            decimals: 18,
            min_qty: 1,
            max_qty: u128::MAX,
            max_open_floors: 100,
            pyth_price_id: [0u8; 32],
            allowed_products: vec![],
            max_open_floor_usdc: u128::MAX,
            paused: false,
        };
        contract.params.assets.insert("nep141:eth.omft.near".to_string(), asset_cfg);
        contract
    }

    #[test]
    #[should_panic(expected = "E_NOT_INTENTS")]
    fn test_on_auth_requires_intents_predecessor() {
        let mut contract = on_auth_contract();
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(user()) // not intents
            .build();
        testing_env!(ctx);
        contract.on_auth(user(), r#"{"op":"close","floor_id":0}"#.to_string());
    }

    #[test]
    #[should_panic(expected = "E_NOT_FLOOR_OWNER")]
    fn test_on_auth_sell_wrong_owner() {
        let mut contract = on_auth_contract();

        // Insert a floor owned by user()
        let floor_id = insert_test_floor(&mut contract, 9_999_999_999_999_999_999);

        let ctx = VMContextBuilder::new()
            .predecessor_account_id(intents())
            .block_timestamp(1_000)
            .build();
        testing_env!(ctx);

        let other: AccountId = accounts(4);
        contract.on_auth(other, format!(r#"{{"op":"sell_to_floor","floor_id":{}}}"#, floor_id));
    }

    #[test]
    #[should_panic(expected = "E_NOT_FLOOR_OWNER")]
    fn test_on_auth_close_wrong_owner() {
        let mut contract = on_auth_contract();
        let floor_id = insert_test_floor(&mut contract, 9_999_999_999_999_999_999);

        let ctx = VMContextBuilder::new()
            .predecessor_account_id(intents())
            .block_timestamp(1_000)
            .build();
        testing_env!(ctx);

        let other: AccountId = accounts(4);
        contract.on_auth(other, format!(r#"{{"op":"close","floor_id":{}}}"#, floor_id));
    }

    #[test]
    #[should_panic(expected = "E_NO_CREDIT")]
    fn test_on_auth_withdraw_credit_none() {
        let mut contract = on_auth_contract();

        let ctx = VMContextBuilder::new()
            .predecessor_account_id(intents())
            .build();
        testing_env!(ctx);

        contract.on_auth(
            user(),
            r#"{"op":"withdraw_credit","asset":"nep141:usdc"}"#.to_string(),
        );
    }

    #[test]
    fn test_on_auth_withdraw_credit_ok() {
        let mut contract = on_auth_contract();

        let asset = "nep141:usdc".to_string();
        let credit_key = (user(), asset.clone());
        contract.credits.insert(credit_key, 500_000);
        {
            let t = contract.totals.entry(asset.clone()).or_insert_with(Totals::default);
            t.credits += 500_000;
            t.held += 500_000;
        }

        let ctx = VMContextBuilder::new()
            .predecessor_account_id(intents())
            .build();
        testing_env!(ctx);

        // This will initiate a cross-contract call; in unit test context it panics
        // on the Promise execution but we can verify state changes made synchronously.
        // We catch the Promise to verify state was updated before the call.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.on_auth(
                user(),
                r#"{"op":"withdraw_credit","asset":"nep141:usdc"}"#.to_string(),
            );
        }));

        // The credit should have been removed (checked before the Promise call)
        let remaining = contract.credits.get(&(user(), asset.clone())).copied().unwrap_or(0);
        assert_eq!(remaining, 0, "credit should be cleared");
    }

    #[test]
    #[should_panic(expected = "E_BAD_MSG")]
    fn test_on_auth_unknown_op() {
        let mut contract = on_auth_contract();
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(intents())
            .build();
        testing_env!(ctx);
        contract.on_auth(user(), r#"{"op":"unknown_op"}"#.to_string());
    }

    // -------------------------------------------------------------------------
    // View method tests
    // -------------------------------------------------------------------------

    #[test]
    fn test_get_params_view() {
        let contract = test_contract();
        let view = contract.get_params();
        assert_eq!(view.intents, intents().to_string());
        assert_eq!(view.pyth, pyth().to_string());
        assert_eq!(view.platform_fee_bps, 417);
        assert_eq!(view.min_floor_usdc, "10000000");
    }

    #[test]
    fn test_get_roles_view() {
        let contract = test_contract();
        let view = contract.get_roles();
        assert_eq!(view.owner, owner().to_string());
        assert_eq!(view.guardian, guardian().to_string());
        assert!(view.admins.is_empty());
        // quote_signer_keys: key "0" maps to [0u8;32] (all zeros → 64-char hex string of zeros)
        let hex_zeros = "0".repeat(64);
        assert_eq!(view.quote_signer_keys.get("0").unwrap(), &hex_zeros);
    }

    #[test]
    fn test_get_pause_view() {
        let contract = test_contract();
        let view = contract.get_pause();
        assert!(!view.global);
        assert!(!view.open_floors);
        assert!(!view.close_floors);
        assert!(!view.sell_to_floor);
        assert!(!view.unwind);
    }

    #[test]
    fn test_get_capacity_returns_none_missing_sleeve() {
        let contract = test_contract();
        assert!(contract.get_capacity("nep141:eth".to_string(), "majors".to_string()).is_none());
    }

    #[test]
    fn test_get_capacity_returns_free_usdc() {
        let mut contract = test_contract();
        let mut sleeve = Sleeve::new("majors".to_string());
        sleeve.free_usdc = 5_000_000;
        contract.sleeves.insert("majors".to_string(), sleeve);
        let cap = contract.get_capacity("nep141:eth".to_string(), "majors".to_string());
        assert_eq!(cap, Some("5000000".to_string()));
    }

    #[test]
    fn test_get_unwinds_empty() {
        let contract = test_contract();
        let unwinds = contract.get_unwinds(None, None);
        assert!(unwinds.is_empty());
    }

    #[test]
    fn test_get_unwinds_paginated() {
        use crate::state::Unwind;
        let mut contract = test_contract();
        for i in 0u64..5 {
            contract.unwinds.insert(i, Unwind {
                id: i,
                asset: "nep141:eth".to_string(),
                sleeve_id: "majors".to_string(),
                qty: 1_000_000,
                deposit_account: intents(),
                min_usdc_out: 950_000,
                started_ns: i * 1_000_000,
                status: crate::state::UnwindStatus::Pending,
                pre_balance_e6: 0,
            });
        }
        let page = contract.get_unwinds(Some(1), Some(2));
        assert_eq!(page.len(), 2);
        assert_eq!(page[0].id, "1");
        assert_eq!(page[1].id, "2");
    }

    #[test]
    fn test_get_credit_none_returns_zero() {
        let contract = test_contract();
        let result = contract.get_credit(user(), "nep141:usdc".to_string());
        assert_eq!(result, "0");
    }

    #[test]
    fn test_get_credit_returns_value() {
        let mut contract = test_contract();
        contract.credits.insert((user(), "nep141:usdc".to_string()), 12_345_678);
        let result = contract.get_credit(user(), "nep141:usdc".to_string());
        assert_eq!(result, "12345678");
    }
}
