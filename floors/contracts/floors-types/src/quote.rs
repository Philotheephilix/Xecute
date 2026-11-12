use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FloorQuote {
    pub v: u8,
    pub id: String,
    pub owner: String,
    pub asset: String,
    pub qty: String,
    pub floor_bps: u16,
    pub duration_secs: u32,
    pub floor_price_e6: String,
    pub fee_usdc: String,
    pub sleeve: String,
    pub pyth_feed: String,
    pub expires_at_ns: String,
    pub key_id: u8,
}
