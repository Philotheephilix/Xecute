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

export async function createPasskey(): Promise<PasskeyCreationResult> {
  const credential = await navigator.credentials.create({
    publicKey: {
      rp: {
        name: 'Floors',
        id: window.location.hostname,
      },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: 'user',
        displayName: 'User',
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' as const },   // ES256
        { alg: -8, type: 'public-key' as const },   // EdDSA
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
  const rawId = Uint8Array.from(
    atob(credentialId.replace(/-/g, '+').replace(/_/g, '/')),
    (c) => c.charCodeAt(0),
  );

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [
        {
          id: rawId,
          type: 'public-key' as const,
        },
      ],
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
