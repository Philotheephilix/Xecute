use near_sdk::env;
use serde::Serialize;

const STANDARD: &str = "floors";
const VERSION: &str = "1.0.0";

fn emit<T: Serialize>(event: &str, data: &T) {
    let json = serde_json::to_string(data).unwrap_or_default();
    env::log_str(&format!(
        r#"EVENT_JSON:{{"standard":"{STANDARD}","version":"{VERSION}","event":"{event}","data":[{json}]}}"#
    ));
}

#[derive(Serialize)]
pub struct FloorOpenedEvent {
    pub floor_id: u64,
    pub owner: String,
    pub asset: String,
    pub qty: String,
    pub floor_price_e6: String,
    pub reserved_usdc: String,
    pub expires_ns: String,
}

#[derive(Serialize)]
pub struct FloorClosedEvent {
    pub floor_id: u64,
}

#[derive(Serialize)]
pub struct FloorSoldEvent {
    pub floor_id: u64,
}

#[derive(Serialize)]
pub struct FloorExpiredEvent {
    pub floor_id: u64,
}

#[derive(Serialize)]
pub struct FloorPayoutPendingEvent {
    pub floor_id: u64,
}

#[derive(Serialize)]
pub struct ParamsQueuedEvent {
    pub apply_after_ns: String,
}

#[derive(Serialize)]
pub struct ParamsAppliedEvent {}

#[derive(Serialize)]
pub struct PausedEvent {
    pub feature: String,
}

#[derive(Serialize)]
pub struct UnpausedEvent {
    pub feature: String,
}

pub fn emit_floor_opened(e: &FloorOpenedEvent) {
    emit("floor_opened", e);
}

pub fn emit_floor_closed(e: &FloorClosedEvent) {
    emit("floor_closed", e);
}

pub fn emit_floor_sold(e: &FloorSoldEvent) {
    emit("floor_sold", e);
}

pub fn emit_floor_expired(e: &FloorExpiredEvent) {
    emit("floor_expired", e);
}

pub fn emit_floor_payout_pending(e: &FloorPayoutPendingEvent) {
    emit("floor_payout_pending", e);
}

pub fn emit_params_queued(e: &ParamsQueuedEvent) {
    emit("params_queued", e);
}

pub fn emit_params_applied(e: &ParamsAppliedEvent) {
    emit("params_applied", e);
}

pub fn emit_paused(e: &PausedEvent) {
    emit("paused", e);
}

pub fn emit_unpaused(e: &UnpausedEvent) {
    emit("unpaused", e);
}
