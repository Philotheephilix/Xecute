use crate::{Contract, ContractExt};
use near_sdk::{near, AccountId};
use serde::Serialize;

/// JSON-friendly view of Params.
#[derive(Serialize)]
pub struct ParamsView {
    pub intents: String,
    pub pyth: String,
    pub usdc: String,
    pub platform_fee_bps: u16,
    pub platform_account: String,
    pub pyth_max_age_secs: u32,
    pub pyth_tolerance_bps: u16,
    pub quote_ttl_max_secs: u32,
    pub min_floor_usdc: String,
}

/// JSON-friendly view of Roles.
#[derive(Serialize)]
pub struct RolesView {
    pub owner: String,
    pub guardian: String,
    pub admins: Vec<String>,
    pub quote_signer_keys: std::collections::HashMap<String, String>,
    pub auto_protect_bot: Option<String>,
    pub unwind_bot: Option<String>,
}

/// JSON-friendly view of PauseFlags.
#[derive(Serialize)]
pub struct PauseView {
    pub global: bool,
    pub open_floors: bool,
    pub close_floors: bool,
    pub sell_to_floor: bool,
    pub unwind: bool,
}

/// JSON-friendly view of an Unwind.
#[derive(Serialize)]
pub struct UnwindView {
    pub id: String,
    pub asset: String,
    pub qty: String,
    pub deposit_account: String,
    pub min_usdc_out: String,
    pub started_ns: String,
    pub status: String,
}

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

    /// Get contract params.
    pub fn get_params(&self) -> ParamsView {
        ParamsView {
            intents: self.params.intents.to_string(),
            pyth: self.params.pyth.to_string(),
            usdc: self.params.usdc.clone(),
            platform_fee_bps: self.params.platform_fee_bps,
            platform_account: self.params.platform_account.to_string(),
            pyth_max_age_secs: self.params.pyth_max_age_secs,
            pyth_tolerance_bps: self.params.pyth_tolerance_bps,
            quote_ttl_max_secs: self.params.quote_ttl_max_secs,
            min_floor_usdc: self.params.min_floor_usdc.to_string(),
        }
    }

    /// Get roles.
    pub fn get_roles(&self) -> RolesView {
        let quote_signer_keys = self.roles.quote_signer_keys
            .iter()
            .map(|(k, v)| {
                let hex = v.iter().map(|b| format!("{:02x}", b)).collect::<String>();
                (k.clone(), hex)
            })
            .collect();
        RolesView {
            owner: self.roles.owner.to_string(),
            guardian: self.roles.guardian.to_string(),
            admins: self.roles.admins.iter().map(|a| a.to_string()).collect(),
            quote_signer_keys,
            auto_protect_bot: self.roles.auto_protect_bot.as_ref().map(|a| a.to_string()),
            unwind_bot: self.roles.unwind_bot.as_ref().map(|a| a.to_string()),
        }
    }

    /// Get pause flags.
    pub fn get_pause(&self) -> PauseView {
        PauseView {
            global: self.pause.global,
            open_floors: self.pause.buy,
            close_floors: self.pause.close,
            sell_to_floor: self.pause.sell_to_floor,
            unwind: self.pause.unwind,
        }
    }

    /// Get available USDC capacity for an asset/sleeve combination.
    /// Returns sleeve.free_usdc as a string, or None if sleeve not found.
    pub fn get_capacity(&self, _asset: String, sleeve_id: String) -> Option<String> {
        self.sleeves.get(&sleeve_id).map(|s| s.free_usdc.to_string())
    }

    /// Paginated list of unwinds.
    pub fn get_unwinds(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<UnwindView> {
        let from = from_index.unwrap_or(0) as usize;
        let lim = limit.unwrap_or(50) as usize;
        self.unwinds
            .iter()
            .skip(from)
            .take(lim)
            .map(|(_id, u)| UnwindView {
                id: u.id.to_string(),
                asset: u.asset.clone(),
                qty: u.qty.to_string(),
                deposit_account: u.deposit_account.to_string(),
                min_usdc_out: u.min_usdc_out.to_string(),
                started_ns: u.started_ns.to_string(),
                status: format!("{:?}", u.status),
            })
            .collect()
    }

    /// Get credit balance for (owner, asset). Returns "0" if none.
    pub fn get_credit(&self, owner: AccountId, asset: String) -> String {
        self.credits
            .get(&(owner, asset))
            .copied()
            .unwrap_or(0)
            .to_string()
    }
}
