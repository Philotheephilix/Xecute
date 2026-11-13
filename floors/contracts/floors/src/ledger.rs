use crate::state::Totals;

impl Totals {
    /// Invariant: held >= escrow + delivered + unwinding + pending + credits
    pub fn assert_solvent(&self, asset: &str) {
        let token_side = self
            .escrow
            .saturating_add(self.delivered)
            .saturating_add(self.unwinding)
            .saturating_add(self.pending)
            .saturating_add(self.credits);
        near_sdk::require!(
            self.held >= token_side,
            format!(
                "INVARIANT_VIOLATED: {asset} held={} < escrow+delivered+unwinding+pending+credits={}",
                self.held, token_side
            )
        );
    }

    /// Invariant for USDC: held >= reserved + free + platform + credits + pending
    pub fn assert_usdc_solvent(&self) {
        let usdc_side = self
            .reserved
            .saturating_add(self.free)
            .saturating_add(self.platform)
            .saturating_add(self.credits)
            .saturating_add(self.pending);
        near_sdk::require!(
            self.held >= usdc_side,
            format!(
                "INVARIANT_VIOLATED: USDC held={} < reserved+free+platform+credits+pending={}",
                self.held, usdc_side
            )
        );
    }
}
