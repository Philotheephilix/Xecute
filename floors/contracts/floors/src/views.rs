use crate::{Contract, ContractExt};
use near_sdk::{near, AccountId};
use serde::Serialize;

/// JSON-friendly view of a Floor (no non-serializable types).
#[derive(Serialize)]
pub struct FloorView {
    pub floor_id: u64,
    pub owner: String,
    pub asset: String,
    pub qty: String,
    pub floor_price_e6: String,
    pub reserved_usdc: String,
    pub fee_usdc: String,
    pub sleeve: String,
    pub opened_ns: String,
    pub expires_ns: String,
    pub status: String,
}

/// JSON-friendly view of Totals.
#[derive(Serialize)]
pub struct TotalsView {
    pub held: String,
    pub escrow: String,
    pub delivered: String,
    pub unwinding: String,
    pub reserved: String,
    pub free: String,
    pub platform: String,
    pub credits: String,
    pub pending: String,
}

/// JSON-friendly view of a Sleeve.
#[derive(Serialize)]
pub struct SleeveView {
    pub id: String,
    pub free_usdc: String,
    pub reserved_usdc: String,
}

#[near]
impl Contract {
    /// Get a single floor by id. Returns None if not found.
    pub fn get_floor(&self, floor_id: u64) -> Option<FloorView> {
        self.floors.get(&floor_id).map(|f| FloorView {
            floor_id,
            owner: f.owner.to_string(),
            asset: f.asset.clone(),
            qty: f.qty.to_string(),
            floor_price_e6: f.floor_price_e6.to_string(),
            reserved_usdc: f.reserved_usdc.to_string(),
            fee_usdc: f.fee_usdc.to_string(),
            sleeve: f.sleeve.clone(),
            opened_ns: f.opened_ns.to_string(),
            expires_ns: f.expires_ns.to_string(),
            status: format!("{:?}", f.status),
        })
    }

    /// List floors for an owner, optionally paginated.
    pub fn list_floors(
        &self,
        owner: AccountId,
        from_index: Option<u64>,
        limit: Option<u64>,
    ) -> Vec<FloorView> {
        let ids = match self.floors_by_owner.get(&owner) {
            Some(set) => set,
            None => return vec![],
        };
        let from = from_index.unwrap_or(0) as usize;
        let lim = limit.unwrap_or(50) as usize;
        ids.iter()
            .skip(from)
            .take(lim)
            .filter_map(|id| self.get_floor(*id))
            .collect()
    }

    /// Get totals for a token id. Returns None if never touched.
    pub fn get_totals(&self, token_id: String) -> Option<TotalsView> {
        self.totals.get(&token_id).map(|t| TotalsView {
            held: t.held.to_string(),
            escrow: t.escrow.to_string(),
            delivered: t.delivered.to_string(),
            unwinding: t.unwinding.to_string(),
            reserved: t.reserved.to_string(),
            free: t.free.to_string(),
            platform: t.platform.to_string(),
            credits: t.credits.to_string(),
            pending: t.pending.to_string(),
        })
    }

    /// Get a sleeve view by id. Returns None if not found.
    pub fn get_sleeve(&self, sleeve_id: String) -> Option<SleeveView> {
        self.sleeves.get(&sleeve_id).map(|s| SleeveView {
            id: s.id.clone(),
            free_usdc: s.free_usdc.to_string(),
            reserved_usdc: s.reserved_usdc.to_string(),
        })
    }
}
