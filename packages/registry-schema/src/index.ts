import { z } from 'zod';
import { ed25519 } from '@noble/curves/ed25519';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const TokenSchema = z.object({
  asset_id: z.string(),          // "nep141:eth.omft.near"
  ticker: z.string(),            // "ETH"
  name: z.string(),
  decimals: z.number().int(),
  display_decimals: z.number().int(),
  pyth_feed: z.string(),
  eligible: z.boolean(),
  products: z.array(
    z.object({
      floor_bps: z.number().int(),
      duration_secs: z.number().int(),
    }),
  ),
});

export type Token = z.infer<typeof TokenSchema>;

export const RegistrySchema = z.object({
  version: z.number().int(),
  published_at_ns: z.string(),
  tokens: z.array(TokenSchema),
  sig: z.string(), // base64 Ed25519 over SHA256(canonical JSON without sig field)
});

export type Registry = z.infer<typeof RegistrySchema>;

// ---------------------------------------------------------------------------
// Canonical JSON — stable serialisation for signing
// ---------------------------------------------------------------------------

/**
 * Produce canonical JSON of the registry for signing.
 * Excludes the `sig` field.
 */
function canonicalJson(registry: Registry): string {
  const { sig: _sig, ...rest } = registry;
  void _sig;
  return JSON.stringify(rest);
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Verify the Ed25519 signature over SHA-256(canonical JSON without sig field).
 *
 * @param registry  - The parsed registry object
 * @param publicKey - Raw 32-byte Ed25519 public key
 */
export function verifyRegistry(registry: Registry, publicKey: Uint8Array): boolean {
  try {
    const canonical = canonicalJson(registry);
    const message = new TextEncoder().encode(canonical);

    // SHA-256 the canonical JSON
    const hashBuf = sha256Sync(message);

    // Decode base64 signature
    const sigBytes = base64Decode(registry.sig);
    if (sigBytes.length !== 64) return false;

    return ed25519.verify(sigBytes, hashBuf, publicKey);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// SHA-256 (pure JS, no Node dependency — uses SubtleCrypto synchronously via
// a pre-computed Uint8Array path using @noble/hashes if available, otherwise
// we import it dynamically to keep the module ESM-compatible)
// ---------------------------------------------------------------------------

// We use a synchronous sha256 from @noble/hashes which is a peer dep of @noble/curves
import { sha256 } from '@noble/hashes/sha256';

function sha256Sync(data: Uint8Array): Uint8Array {
  return sha256(data);
}

// ---------------------------------------------------------------------------
// Base64 decode
// ---------------------------------------------------------------------------

function base64Decode(b64: string): Uint8Array {
  // Support both standard and URL-safe base64
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Re-export helper for signing (used in tests)
// ---------------------------------------------------------------------------

export { canonicalJson as _canonicalJson };
