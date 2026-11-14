use near_sdk::store::IterableMap;
use near_sdk::{near, AccountId, BorshStorageKey};
use std::collections::HashMap;

pub type AssetId = String;
pub type SleeveId = String;

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StateVersion {
    V1,
}

/// Per-asset configuration stored in Params.
#[near(serializers = [borsh, json])]
#[derive(Debug, Clone)]
pub struct AssetConfig {
    pub decimals: u8,
    pub min_qty: u128,
    pub max_qty: u128,
    pub max_open_floors: u32,
    pub pyth_price_id: [u8; 32],
    /// Allowed (floor_bps, duration_secs) product pairs. Empty = all allowed.
    pub allowed_products: Vec<(u32, u64)>,
    /// Maximum total reserved USDC across all open floors for this asset.
    pub max_open_floor_usdc: u128,
    /// Whether new floors for this asset are paused.
    pub paused: bool,
}

/// Unwind configuration stored in Params.
#[near(serializers = [borsh, json])]
#[derive(Debug, Clone)]
pub struct UnwindConfig {
    /// Minimum USDC received vs expected, in basis points (slippage protection).
    pub min_usdc_out_bps: u32,
    /// Account to send tokens to for unwind via 1Click.
    pub deposit_account: AccountId,
    /// Maximum tokens per unwind transaction.
    pub max_unwind_qty: u128,
    /// Minimum seconds between unwinds for the same sleeve.
    pub cooldown_secs: u32,
}

/// Per-sleeve configuration stored in Params.
#[near(serializers = [borsh, json])]
#[derive(Debug, Clone)]
pub struct SleeveConfig {
    pub max_utilization_bps: u32,
    pub per_asset_cap_bps: HashMap<AssetId, u32>,
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
    /// Per-asset configuration (decimals, qty limits, pyth feed id).
    pub assets: HashMap<AssetId, AssetConfig>,
    /// Per-sleeve configuration (utilization cap, per-asset share caps).
    pub sleeves: HashMap<SleeveId, SleeveConfig>,
    /// Unwind configuration (slippage, deposit account, caps, cooldown).
    pub unwind: UnwindConfig,
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
            assets: HashMap::new(),
            sleeves: HashMap::new(),
            unwind: UnwindConfig {
                min_usdc_out_bps: 9500, // 95% minimum USDC received
                deposit_account: "intents.near".parse().unwrap(),
                max_unwind_qty: u128::MAX,
                cooldown_secs: 3600,
            },
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone)]
pub struct Roles {
    pub owner: AccountId,
    pub guardian: AccountId,
    /// Legacy slot — kept for Borsh layout compatibility; use `quote_signer_keys` for keyed access.
    pub quote_signers: Vec<[u8; 32]>,
    pub auto_protect_bot: Option<AccountId>,
    pub unwind_bot: Option<AccountId>,
    /// Named admin accounts (owner always has admin rights too).
    pub admins: Vec<AccountId>,
    /// Named quote-signer keys: key_id → 32-byte Ed25519 public key.
    /// Key stored as string (e.g. "0", "1") matching the u8 key_id in FloorQuote.
    pub quote_signer_keys: HashMap<String, [u8; 32]>,
}

impl Roles {
    pub fn new(owner: AccountId, guardian: AccountId, quote_signers: Vec<[u8; 32]>) -> Self {
        Self {
            owner,
            guardian,
            quote_signers,
            auto_protect_bot: None,
            unwind_bot: None,
            admins: Vec::new(),
            quote_signer_keys: HashMap::new(),
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, Default)]
pub struct PauseFlags {
    pub global: bool,
    /// Pause opening new floors ("open_floors" scope).
    pub buy: bool,
    pub sell_to_floor: bool,
    /// Pause closing floors ("close_floors" scope).
    pub close: bool,
    /// Pause unwind operations ("unwind" scope).
    pub unwind: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FloorStatus {
    Active,
    PayoutPending,
    ClosePending,   // tokens transfer in-flight
    ExpirePending,  // expire transfer in-flight
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


/// BorshStorageKey for nested collections inside a Sleeve.
/// The sleeve_id is embedded so every sleeve gets a unique prefix.
#[derive(BorshStorageKey)]
#[near]
pub enum SleeveStorageKey {
    Delivered { sleeve_id: Vec<u8> },
}

/// Sleeve is stored in a LookupMap and contains on-chain collections,
/// so it uses Borsh only (IterableMap does not implement serde traits).
#[near(serializers = [borsh])]
#[derive(Debug)]
pub struct Sleeve {
    pub id: String,
    pub free_usdc: u128,
    pub reserved_usdc: u128,
    /// Tokens delivered to this sleeve in payout, keyed by asset id, not yet unwound.
    pub delivered: IterableMap<AssetId, u128>,
    /// Total LP shares outstanding for this sleeve (P3 outside depositors).
    pub shares_total: u128,
    /// Current reconciliation epoch (P3).
    pub epoch: u64,
}

impl Sleeve {
    pub fn new(id: String) -> Self {
        let prefix = SleeveStorageKey::Delivered {
            sleeve_id: id.as_bytes().to_vec(),
        };
        Self {
            id: id.clone(),
            free_usdc: 0,
            reserved_usdc: 0,
            delivered: IterableMap::new(prefix),
            shares_total: 0,
            epoch: 0,
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnwindStatus {
    Pending,
    Settled,
    Short,
}

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone)]
pub struct Unwind {
    pub id: u64,
    pub asset: String,
    pub sleeve_id: String,
    pub qty: u128,
    pub deposit_account: AccountId,
    pub min_usdc_out: u128,
    pub started_ns: u64,
    pub status: UnwindStatus,
    /// USDC balance of deposit_account captured BEFORE the unwind token transfer.
    /// on_unwind_settle computes proceeds = current_balance - pre_balance_e6 to
    /// avoid crediting pre-existing USDC in that account.
    pub pre_balance_e6: u128,
}

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone)]
pub struct PendingChange {
    /// Caller-supplied unique identifier for this change.
    pub change_id: String,
    pub kind: String,
    pub payload: String,
    pub queued_ns: u64,
    pub apply_after_ns: u64,
}
