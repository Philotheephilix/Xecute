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
