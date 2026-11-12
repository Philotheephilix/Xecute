#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FloorError {
    NotIntents,
    NotOwner,
    NotGuardian,
    Paused,
    QuoteExpired,
    QuoteUsed,
    QuoteSigInvalid,
    AssetNotAllowed,
    ProductNotAllowed,
    SleeveInsufficient,
    PythStale,
    PythMissing,
    PriceViolation,
    FloorNotFound,
    FloorNotActive,
    NotFloorOwner,
    CapExceeded,
    BelowMinimum,
    AlreadyInitialized,
}

impl FloorError {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::NotIntents => "E_NOT_INTENTS",
            Self::NotOwner => "E_NOT_OWNER",
            Self::NotGuardian => "E_NOT_GUARDIAN",
            Self::Paused => "E_PAUSED",
            Self::QuoteExpired => "E_QUOTE_EXPIRED",
            Self::QuoteUsed => "E_QUOTE_USED",
            Self::QuoteSigInvalid => "E_QUOTE_SIG_INVALID",
            Self::AssetNotAllowed => "E_ASSET_NOT_ALLOWED",
            Self::ProductNotAllowed => "E_PRODUCT_NOT_ALLOWED",
            Self::SleeveInsufficient => "E_SLEEVE_INSUFFICIENT",
            Self::PythStale => "E_PYTH_STALE",
            Self::PythMissing => "E_PYTH_MISSING",
            Self::PriceViolation => "E_PRICE_VIOLATION",
            Self::FloorNotFound => "E_FLOOR_NOT_FOUND",
            Self::FloorNotActive => "E_FLOOR_NOT_ACTIVE",
            Self::NotFloorOwner => "E_NOT_FLOOR_OWNER",
            Self::CapExceeded => "E_CAP_EXCEEDED",
            Self::BelowMinimum => "E_BELOW_MINIMUM",
            Self::AlreadyInitialized => "E_ALREADY_INITIALIZED",
        }
    }
}
