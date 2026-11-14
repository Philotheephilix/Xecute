/**
 * Passkey utilities for Floors.
 * Wraps WebAuthn credential create/get and encodes keys as base58
 * for NEAR compatibility.
 */

// ── Hex encoding ─────────────────────────────────────────────────────────────

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Compressed P-256 key extraction ──────────────────────────────────────────

/**
 * Extract a 33-byte compressed SEC1 P-256 public key from a SubjectPublicKeyInfo blob.
 *
 * SubjectPublicKeyInfo (DER) structure for P-256:
 *   SEQUENCE {
 *     SEQUENCE { OID (id-ecPublicKey), OID (P-256) }
 *     BIT STRING { 0x00 [padding], 0x04 [uncompressed], X[32], Y[32] }
 *   }
 *
 * The uncompressed marker 0x04 is followed by 32 bytes X then 32 bytes Y.
 * We find the last occurrence of 0x04 (the point marker) where the remaining
 * length is exactly 65 bytes (1 + 32 + 32), then compress to 02/03 + X.
 */
export function extractCompressedP256Key(subjectPublicKeyInfo: Uint8Array): Uint8Array {
  // Find the uncompressed point marker 0x04 preceded by the BIT STRING padding byte.
  // The last 65 bytes of the SPKI blob are: 0x04 + X[32] + Y[32]
  const spki = subjectPublicKeyInfo;

  // Search backwards for 0x04 where it's followed by exactly 64 more bytes
  let markerIndex = -1;
  for (let i = spki.length - 65; i >= 0; i--) {
    if (spki[i] === 0x04 && i + 65 === spki.length) {
      markerIndex = i;
      break;
    }
  }

  if (markerIndex === -1) {
    throw new Error('Could not locate uncompressed P-256 point in SubjectPublicKeyInfo');
  }

  const x = spki.slice(markerIndex + 1, markerIndex + 33);
  const y = spki[markerIndex + 64];

  if (y === undefined) {
    throw new Error('Malformed P-256 SubjectPublicKeyInfo: Y coordinate missing');
  }

  const prefix = (y & 1) === 0 ? 0x02 : 0x03;
  const compressed = new Uint8Array(33);
  compressed[0] = prefix;
  compressed.set(x, 1);
  return compressed;
}

// ── DER to raw P-256 signature ──────────────────────────────────────────────

// P-256 curve order N
const P256_N = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');
const P256_HALF_N = P256_N / 2n;

function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

function bigIntToBytes32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * Convert a DER-encoded ECDSA signature (from WebAuthn) to raw 64-byte (r || s).
 * NEAR wallet contract expects 64-byte raw format with low-S normalization.
 */
export function derToRaw(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error('Not a DER sequence');
  let offset = 2;
  if (der[1]! > 0x80) offset += der[1]! - 0x80;

  if (der[offset] !== 0x02) throw new Error('Expected INTEGER tag for r');
  offset++;
  const rLen = der[offset]!;
  offset++;
  let r = der.slice(offset, offset + rLen);
  offset += rLen;

  if (der[offset] !== 0x02) throw new Error('Expected INTEGER tag for s');
  offset++;
  const sLen = der[offset]!;
  offset++;
  let s = der.slice(offset, offset + sLen);

  // Strip leading zero padding
  if (r.length === 33 && r[0] === 0x00) r = r.slice(1);
  if (s.length === 33 && s[0] === 0x00) s = s.slice(1);

  // Pad to 32 bytes each
  const raw = new Uint8Array(64);
  raw.set(r, 32 - r.length);

  // Low-S normalization: if s > N/2, replace with N - s
  let sVal = bytesToBigInt(s);
  if (sVal > P256_HALF_N) {
    sVal = P256_N - sVal;
  }
  raw.set(bigIntToBytes32(sVal), 32);

  return raw;
}

// ── Base58 encoding ──────────────────────────────────────────────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';

  // Count leading zeros
  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte !== 0) break;
    leadingZeros++;
  }

  // Convert big-endian bytes to base58 digits
  const digits: number[] = [0];

  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] ?? 0) << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  // Build result: leading '1's + encoded digits (skip trailing zeros from digits array)
  let result = '1'.repeat(leadingZeros);

  // digits is little-endian; reverse and skip leading zeros (which are trailing zeros here)
  let skipZeros = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = digits[i] ?? 0;
    if (skipZeros && d === 0) continue;
    skipZeros = false;
    result += BASE58_ALPHABET[d];
  }

  return result;
}

// ── Public key extraction ────────────────────────────────────────────────────

function extractPublicKey(response: AuthenticatorAttestationResponse): Uint8Array {
  const rawKey = response.getPublicKey();
  if (!rawKey) {
    throw new Error('Authenticator did not return a public key');
  }
  return new Uint8Array(rawKey);
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface PasskeyCreationResult {
  credentialId: string;
  publicKey: string; // base58-encoded
  rawPublicKey: Uint8Array;
}

export interface PasskeyAssertion {
  credentialId: string;
  signature: Uint8Array;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
}

// ── Create passkey ───────────────────────────────────────────────────────────

export async function createPasskey(name?: string): Promise<PasskeyCreationResult> {
  const displayName = name?.trim() || 'Floors User';
  const credential = await navigator.credentials.create({
    publicKey: {
      rp: {
        name: 'Floors',
        id: window.location.hostname,
      },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: displayName,
        displayName,
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' as const },   // ES256 / P-256
      ],
      authenticatorSelection: {
        residentKey: 'required' as const,
        userVerification: 'required' as const,
      },
      attestation: 'none' as const,
      timeout: 60000,
    },
  });

  if (!credential || credential.type !== 'public-key') {
    throw new Error('WebAuthn credential creation failed or returned wrong type');
  }

  const pkCredential = credential as PublicKeyCredential;
  const response = pkCredential.response as AuthenticatorAttestationResponse;

  const rawPublicKey = extractPublicKey(response);
  const publicKey = encodeBase58(rawPublicKey);

  // Encode credential ID as base64url
  const credentialId = btoa(
    String.fromCharCode(...new Uint8Array(pkCredential.rawId)),
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return { credentialId, publicKey, rawPublicKey };
}

// ── Sign with passkey ────────────────────────────────────────────────────────

export async function signWithPasskey(
  challenge: Uint8Array,
  credentialId: string,
): Promise<PasskeyAssertion> {
  // Decode base64url credential ID back to ArrayBuffer
  const allowCredentials =
    credentialId !== undefined && credentialId !== ''
      ? [
          {
            id: Uint8Array.from(
              atob(credentialId.replace(/-/g, '+').replace(/_/g, '/')),
              (c) => c.charCodeAt(0),
            ),
            type: 'public-key' as const,
          },
        ]
      : [];

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials,
      userVerification: 'required' as const,
      timeout: 60000,
    },
  });

  if (!assertion || assertion.type !== 'public-key') {
    throw new Error('WebAuthn assertion failed or returned wrong type');
  }

  const pkAssertion = assertion as PublicKeyCredential;
  const response = pkAssertion.response as AuthenticatorAssertionResponse;

  return {
    credentialId,
    signature: new Uint8Array(response.signature),
    authenticatorData: new Uint8Array(response.authenticatorData),
    clientDataJSON: new Uint8Array(response.clientDataJSON),
  };
}
