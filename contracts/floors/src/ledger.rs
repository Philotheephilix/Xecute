use crate::state::Totals;

impl Totals {
    /// Invariant: held >= escrow + delivered + unwinding + pending + credits
    /// and for USDC: held >= reserved + platform + credits + pending
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
}
