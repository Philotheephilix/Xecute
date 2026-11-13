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
// Signature verification
// ---------------------------------------------------------------------------

/// Verify an Ed25519 signature over the canonical FLOORS_QUOTE/V1 payload.
///
/// Message layout (matches TypeScript signing.ts QuotePayload):
///   b"FLOORS_QUOTE/V1"  (15 bytes, no length prefix)
///   id[32]             (32 bytes raw, no length prefix — it's a fixed array)
///   owner              (4-byte LE length + UTF-8 bytes)
///   asset              (4-byte LE length + UTF-8 bytes)
///   qty                (16 bytes LE u128)
///   floor_price_e6     (16 bytes LE u128)
///   fee_usdc           (16 bytes LE u128)
///   sleeve             (4-byte LE length + UTF-8 bytes)
///   expires_at         (8 bytes LE u64 — Unix seconds, not nanoseconds)
///
/// Uses `near_sdk::env::ed25519_verify` (NEAR host function).
pub fn verify_quote_sig(
    quote_id: &[u8; 32],
    owner: &str,
    asset: &str,
    qty: u128,
    floor_price_e6: u128,
    fee_usdc: u128,
    sleeve: &str,
    expires_at: u64, // Unix seconds
    sig: &[u8; 64],
    pubkey: &[u8; 32],
) -> bool {
    let message = build_quote_message(
        quote_id,
        owner,
        asset,
        qty,
        floor_price_e6,
        fee_usdc,
        sleeve,
        expires_at,
    );
    near_sdk::env::ed25519_verify(sig, &message, pubkey)
}

/// Build the canonical message bytes for a QuotePayload.
/// Exposed separately so tests can compute the expected bytes without
/// going through `env::ed25519_verify`.
pub(crate) fn build_quote_message(
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
