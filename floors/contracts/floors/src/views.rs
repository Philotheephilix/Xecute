use crate::state::{Floor, FloorStatus, Params, Sleeve, Totals};
use crate::{Contract, ContractExt};
use near_sdk::{near, AccountId};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// FloorView — JSON-serializable projection of Floor
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FloorView {
    pub floor_id: u64,
    pub owner: String,
    pub asset: String,
    pub qty: String,
    pub floor_price_e6: String,
    pub reserved_usdc: String,
    pub sleeve: String,
    pub fee_usdc: String,
    pub opened_ns: String,
    pub expires_ns: String,
    pub status: String,
}

impl FloorView {
    fn from_floor(floor_id: u64, floor: &Floor) -> Self {
        FloorView {
            floor_id,
            owner: floor.owner.to_string(),
            asset: floor.asset.clone(),
            qty: floor.qty.to_string(),
            floor_price_e6: floor.floor_price_e6.to_string(),
            reserved_usdc: floor.reserved_usdc.to_string(),
            sleeve: floor.sleeve.clone(),
            fee_usdc: floor.fee_usdc.to_string(),
            opened_ns: floor.opened_ns.to_string(),
            expires_ns: floor.expires_ns.to_string(),
            status: match floor.status {
                FloorStatus::Active => "Active".to_string(),
                FloorStatus::PayoutPending => "PayoutPending".to_string(),
                FloorStatus::Closed => "Closed".to_string(),
                FloorStatus::Sold => "Sold".to_string(),
                FloorStatus::Expired => "Expired".to_string(),
            },
        }
    }
}

// ---------------------------------------------------------------------------
// View methods
// ---------------------------------------------------------------------------

#[near]
impl Contract {
    /// Get a floor by its numeric ID.
    pub fn get_floor(&self, floor_id: u64) -> Option<FloorView> {
        self.floors.get(&floor_id).map(|f| FloorView::from_floor(floor_id, f))
    }

    /// List floors for an owner with optional pagination.
    /// `from`: floor_id (exclusive) to start after; `limit`: max results (default 50).
    pub fn list_floors(
        &self,
        owner: AccountId,
        from: Option<u64>,
        limit: Option<u32>,
    ) -> Vec<FloorView> {
        let limit = limit.unwrap_or(50).min(200) as usize;
        let from_id = from.unwrap_or(0);

        let owner_floors = match self.floors_by_owner.get(&owner) {
            Some(set) => set,
            None => return vec![],
        };

        owner_floors
            .iter()
            .copied()
            .filter(|id| *id > from_id)
            .take(limit)
            .filter_map(|id| {
                self.floors.get(&id).map(|f| FloorView::from_floor(id, f))
            })
            .collect()
    }

    /// Get the current params.
    pub fn get_params(&self) -> &Params {
        &self.params
    }

    /// Get a sleeve by its id.
    /// Note: Sleeve contains nested IterableMap which doesn't implement Serialize,
    /// so we return a simplified view.
    pub fn get_sleeve(&self, sleeve_id: String) -> Option<SleeveView> {
        self.sleeves.get(&sleeve_id).map(|s| SleeveView {
            id: s.id.clone(),
            free_usdc: s.free_usdc.to_string(),
            reserved_usdc: s.reserved_usdc.to_string(),
            shares_total: s.shares_total.to_string(),
            epoch: s.epoch,
        })
    }

    /// Get totals for a given asset id (token asset or USDC).
    pub fn get_totals(&self, asset: String) -> Option<&Totals> {
        self.totals.get(&asset)
    }

    /// Get the credit owed to an owner for a specific asset.
    pub fn get_credit(&self, owner: AccountId, asset: String) -> String {
        self.credits
            .get(&(owner, asset))
            .copied()
            .unwrap_or(0)
            .to_string()
    }
}

// ---------------------------------------------------------------------------
// SleeveView — JSON-serializable projection of Sleeve
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SleeveView {
    pub id: String,
    pub free_usdc: String,
    pub reserved_usdc: String,
    pub shares_total: String,
    pub epoch: u64,
}
