use crate::Contract;

impl Contract {
    /// Mark a quote as used. Panics with E_QUOTE_USED if already held.
    /// Stores the quote's expiry (in nanoseconds) so we can prune old entries.
    pub(crate) fn hold_quote(&mut self, quote_id: [u8; 32], expires_ns: u64) {
        near_sdk::require!(
            !self.used_quotes.contains_key(&quote_id),
            "E_QUOTE_USED: quote already consumed"
        );
        self.used_quotes.insert(quote_id, expires_ns);
    }

    /// Release a quote that was held but the open ultimately failed.
    pub(crate) fn release_quote(&mut self, quote_id: [u8; 32]) {
        self.used_quotes.remove(&quote_id);
    }

    /// Check whether a quote has already been used (without inserting).
    pub(crate) fn quote_is_used(&self, quote_id: &[u8; 32]) -> bool {
        self.used_quotes.contains_key(quote_id)
    }
}
