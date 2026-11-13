use crate::state::Totals;

impl Totals {
    /// Token-side invariant:
    /// held == escrow + delivered + credits + pending
    /// (unwinding tokens have already left `held` when sent to 1Click)
    pub fn assert_solvent(&self, asset: &str) {
        let token_side = self
            .escrow
            .saturating_add(self.delivered)
            .saturating_add(self.credits)
            .saturating_add(self.pending);
        near_sdk::require!(
            self.held >= token_side,
            format!(
                "INVARIANT_VIOLATED: {asset} held={} < escrow+delivered+credits+pending={}",
                self.held, token_side
            )
        );
    }

    /// USDC-side invariant:
    /// held_usdc == reserved_usdc + free_total_usdc + platform_usdc + credits_usdc + pending_usdc
    ///
    /// Call this on the USDC Totals entry.
    /// - `reserved`  = sum of all active floors' reserved_usdc (tracked in Totals::reserved)
    /// - `free`      = sleeve.free_usdc summed across all sleeves (tracked in Totals::free)
    /// - `platform`  = fees accumulated for platform (Totals::platform)
    /// - `credits`   = sum of credits[(owner, usdc)] for failed payouts (Totals::credits)
    /// - `pending`   = sum of in-flight USDC transfers (Totals::pending)
    pub fn assert_usdc_solvent(&self) {
        let usdc_side = self
            .reserved
            .saturating_add(self.free)
            .saturating_add(self.platform)
            .saturating_add(self.credits)
            .saturating_add(self.pending);
        near_sdk::require!(
            self.held == usdc_side,
            format!(
                "INVARIANT_VIOLATED: usdc held={} != reserved+free+platform+credits+pending={}  \
                 (reserved={} free={} platform={} credits={} pending={})",
                self.held,
                usdc_side,
                self.reserved,
                self.free,
                self.platform,
                self.credits,
                self.pending,
            )
        );
    }
}
