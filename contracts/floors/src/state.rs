use near_sdk::{near, AccountId};

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StateVersion {
    V1,
}

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone)]
pub struct Params {
    pub intents: AccountId,
    pub pyth: AccountId,
    pub usdc: String,
    pub platform_fee_bps: u16,
    pub platform_account: AccountId,
    pub pyth_max_age_secs: u32,
    pub pyth_tolerance_bps: u16,
    pub quote_ttl_max_secs: u32,
    pub min_floor_usdc: u128,
    pub auto_protect_window_secs: u32,
    pub payout_gas: u64,
    pub expire_batch_max: u16,
}

impl Params {
    pub fn new(intents: AccountId, pyth: AccountId, platform_account: AccountId) -> Self {
        Self {
            intents,
            pyth,
            usdc: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
                .to_string(),
            platform_fee_bps: 417,
            platform_account,
            pyth_max_age_secs: 60,
            pyth_tolerance_bps: 100,
            quote_ttl_max_secs: 60,
            min_floor_usdc: 10_000_000,
            auto_protect_window_secs: 900,
            payout_gas: 15_000_000_000_000,
            expire_batch_max: 50,
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone)]
pub struct Roles {
    pub owner: AccountId,
    pub guardian: AccountId,
    pub quote_signers: Vec<[u8; 32]>,
    pub auto_protect_bot: Option<AccountId>,
    pub unwind_bot: Option<AccountId>,
}

impl Roles {
    pub fn new(owner: AccountId, guardian: AccountId, quote_signers: Vec<[u8; 32]>) -> Self {
        Self {
            owner,
            guardian,
            quote_signers,
            auto_protect_bot: None,
            unwind_bot: None,
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, Default)]
pub struct PauseFlags {
    pub global: bool,
    pub buy: bool,
    pub sell_to_floor: bool,
    pub close: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FloorStatus {
    Active,
    PayoutPending,
    Closed,
    Sold,
    Expired,
}

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone)]
pub struct Floor {
    pub owner: AccountId,
    pub asset: String,
    pub qty: u128,
    pub floor_price_e6: u128,
    pub reserved_usdc: u128,
    pub sleeve: String,
    pub fee_usdc: u128,
    pub opened_ns: u64,
    pub expires_ns: u64,
    pub status: FloorStatus,
}

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, Default)]
pub struct Totals {
    pub held: u128,
    pub escrow: u128,
    pub delivered: u128,
    pub unwinding: u128,
    pub reserved: u128,
    pub free: u128,
    pub platform: u128,
    pub credits: u128,
    pub pending: u128,
}

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone)]
pub struct Sleeve {
    pub id: String,
    pub free_usdc: u128,
    pub reserved_usdc: u128,
}

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone)]
pub struct Unwind {
    pub id: u64,
    pub asset: String,
    pub qty: u128,
    pub started_ns: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone)]
pub struct PendingChange {
    pub kind: String,
    pub payload: String,
    pub queued_ns: u64,
    pub apply_after_ns: u64,
}
