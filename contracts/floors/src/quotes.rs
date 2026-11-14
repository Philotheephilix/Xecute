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

// ---------------------------------------------------------------------------
// Canonical signing message builder
// ---------------------------------------------------------------------------

/// Build the canonical message bytes for a QuotePayload.
///
/// Message layout (matches TypeScript signing.ts QuotePayload):
///   b"FLOORS_QUOTE/V1"  (15 bytes, no length prefix)
///   id[32]             (32 bytes raw)
///   owner              (4-byte LE length + UTF-8 bytes)
///   asset              (4-byte LE length + UTF-8 bytes)
///   qty                (16 bytes LE u128)
///   floor_price_e6     (16 bytes LE u128)
///   fee_usdc           (16 bytes LE u128)
///   sleeve             (4-byte LE length + UTF-8 bytes)
///   expires_at         (8 bytes LE u64 — Unix seconds, not nanoseconds)
///
/// This is the single canonical format used both on-chain (via quote_signing_message
/// in receivers.rs) and in tests.
pub fn build_quote_message(
    quote_id: &[u8; 32],
    owner: &str,
    asset: &str,
    qty: u128,
    floor_price_e6: u128,
    fee_usdc: u128,
    sleeve: &str,
    expires_at: u64,
) -> Vec<u8> {
    let mut msg = Vec::new();

    // Prefix (15 bytes, no length prefix)
    msg.extend_from_slice(b"FLOORS_QUOTE/V1");

    // id: 32 bytes raw (no length prefix)
    msg.extend_from_slice(quote_id);

    // Borsh string: 4-byte LE length + UTF-8 bytes
    write_borsh_string(&mut msg, owner);
    write_borsh_string(&mut msg, asset);

    // u128: 16 bytes LE
    msg.extend_from_slice(&qty.to_le_bytes());
    msg.extend_from_slice(&floor_price_e6.to_le_bytes());
    msg.extend_from_slice(&fee_usdc.to_le_bytes());

    write_borsh_string(&mut msg, sleeve);

    // u64: 8 bytes LE (Unix seconds)
    msg.extend_from_slice(&expires_at.to_le_bytes());

    msg
}

#[inline(always)]
fn write_borsh_string(buf: &mut Vec<u8>, s: &str) {
    let bytes = s.as_bytes();
    let len = bytes.len() as u32;
    buf.extend_from_slice(&len.to_le_bytes());
    buf.extend_from_slice(bytes);
}
