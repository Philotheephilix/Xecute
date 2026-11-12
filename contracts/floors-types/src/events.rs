use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FloorOpenedEvent {
    pub floor_id: u64,
    pub owner: String,
    pub asset: String,
    pub qty: String,
    pub floor_price_e6: String,
    pub reserved_usdc: String,
    pub expires_ns: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FloorClosedEvent {
    pub floor_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FloorSoldEvent {
    pub floor_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FloorExpiredEvent {
    pub floor_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FloorPayoutPendingEvent {
    pub floor_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ParamsQueuedEvent {
    pub apply_after_ns: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ParamsAppliedEvent {}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PausedEvent {
    pub feature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct UnpausedEvent {
    pub feature: String,
}
