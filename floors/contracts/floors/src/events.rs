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

// ---------------------------------------------------------------------------
// Floor lifecycle
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct FloorOpenedEvent {
    pub floor_id: u64,
    pub owner: String,
    pub asset: String,
    pub qty: String,
    pub floor_price_e6: String,
    pub reserved_usdc: String,
    pub expires_ns: String,
    /// Total fee charged to the buyer (backer share + platform share).
    pub fee_usdc: String,
    /// Platform portion of the fee.
    pub platform_fee_usdc: String,
    /// Unique quote id that was consumed to open this floor.
    pub quote_id: String,
}

#[derive(Serialize)]
pub struct FloorClosedEvent {
    pub floor_id: u64,
    /// Tokens returned to the owner.
    pub qty_returned: String,
    /// USDC unlocked from reservation back to the sleeve.
    pub unlocked_usdc: String,
}

#[derive(Serialize)]
pub struct FloorSoldEvent {
    pub floor_id: u64,
    /// USDC paid out to the owner.
    pub paid_usdc: String,
    /// Account that triggered the sell (owner or auto_protect_bot).
    pub by: String,
}

#[derive(Serialize)]
pub struct FloorExpiredEvent {
    pub floor_id: u64,
    /// Tokens returned to the owner after expiry.
    pub qty_returned: String,
    /// USDC unlocked from reservation back to the sleeve.
    pub unlocked_usdc: String,
}

#[derive(Serialize)]
pub struct FloorPayoutPendingEvent {
    pub floor_id: u64,
}

// ---------------------------------------------------------------------------
// Payout lifecycle
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct PayoutFailedEvent {
    pub floor_id: String,
    pub owner: String,
    pub asset: String,
    pub qty: String,
    pub reason: String,
}

#[derive(Serialize)]
pub struct PayoutRetriedEvent {
    pub floor_id: String,
    pub owner: String,
    pub asset: String,
    pub qty: String,
    pub tx_hash: String,
}

// ---------------------------------------------------------------------------
// Unwind lifecycle
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct UnwindStartedEvent {
    pub sleeve_id: String,
    pub asset: String,
    pub qty: String,
}

#[derive(Serialize)]
pub struct UnwindSettledEvent {
    pub sleeve_id: String,
    pub asset: String,
    pub usdc_received: String,
    pub epoch: u64,
}

#[derive(Serialize)]
pub struct UnwindShortEvent {
    pub sleeve_id: String,
    pub shortfall_usdc: String,
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ReconciledEvent {
    pub sleeve_id: String,
    pub epoch: u64,
    pub pnl_usdc: String,
}

#[derive(Serialize)]
pub struct ShortfallPausedEvent {
    pub sleeve_id: String,
    pub shortfall_usdc: String,
}

// ---------------------------------------------------------------------------
// Admin / param change lifecycle
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ParamsQueuedEvent {
    pub apply_after_ns: String,
}

#[derive(Serialize)]
pub struct ParamsAppliedEvent {}

#[derive(Serialize)]
pub struct ChangeQueuedEvent {
    pub change_type: String,
    pub value: String,
    pub apply_after: u64,
}

#[derive(Serialize)]
pub struct ChangeAppliedEvent {
    pub change_type: String,
    pub value: String,
}

// ---------------------------------------------------------------------------
// Pause / unpause
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct PausedEvent {
    pub feature: String,
}

#[derive(Serialize)]
pub struct UnpausedEvent {
    pub feature: String,
}

// ---------------------------------------------------------------------------
// Emit helpers
// ---------------------------------------------------------------------------

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

pub fn emit_payout_failed(e: &PayoutFailedEvent) {
    emit("payout_failed", e);
}

pub fn emit_payout_retried(e: &PayoutRetriedEvent) {
    emit("payout_retried", e);
}

pub fn emit_unwind_started(e: &UnwindStartedEvent) {
    emit("unwind_started", e);
}

pub fn emit_unwind_settled(e: &UnwindSettledEvent) {
    emit("unwind_settled", e);
}

pub fn emit_unwind_short(e: &UnwindShortEvent) {
    emit("unwind_short", e);
}

pub fn emit_reconciled(e: &ReconciledEvent) {
    emit("reconciled", e);
}

pub fn emit_shortfall_paused(e: &ShortfallPausedEvent) {
    emit("shortfall_paused", e);
}

pub fn emit_params_queued(e: &ParamsQueuedEvent) {
    emit("params_queued", e);
}

pub fn emit_params_applied(e: &ParamsAppliedEvent) {
    emit("params_applied", e);
}

pub fn emit_change_queued(e: &ChangeQueuedEvent) {
    emit("change_queued", e);
}

pub fn emit_change_applied(e: &ChangeAppliedEvent) {
    emit("change_applied", e);
}

pub fn emit_paused(e: &PausedEvent) {
    emit("paused", e);
}

pub fn emit_unpaused(e: &UnpausedEvent) {
    emit("unpaused", e);
}
