/**
 * WebAuthn passkey signing wrapper.
 *
 * Wraps navigator.credentials.get() for signing Floors intent payloads.
 * Returns signature as raw 64-byte r‖s (not DER-encoded).
 */

export interface PasskeyAssertion {
  /** Raw authenticator data bytes */
  authenticatorData: Uint8Array;
  /** Client data JSON bytes */
  clientDataJSON: Uint8Array;
  /** Raw 64-byte r‖s signature (NOT DER) */
  signature: Uint8Array;
  /** Base64URL-encoded credential ID */
  credentialId: string;
}

/**
 * Converts a DER-encoded ECDSA signature to raw 64-byte r‖s format.
 *
 * DER structure: 0x30 [total-len] 0x02 [r-len] [r] 0x02 [s-len] [s]
 * Output: 32-byte r (big-endian, zero-padded) ‖ 32-byte s (big-endian, zero-padded)
 */
export function derToRaw(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) {
    throw new Error('Not a DER-encoded ECDSA signature');
  }

  let offset = 2; // skip 0x30 + total-length

  // r
  if (der[offset] !== 0x02) {
    throw new Error('Expected INTEGER tag for r');
  }
  offset++;
  const rLen = der[offset++] as number;
  // Skip leading zero byte if present (sign padding)
  const rStart = der[offset] === 0x00 ? offset + 1 : offset;
  const rEnd = offset + rLen;
  const rBytes = der.slice(rStart, rEnd);
  offset = rEnd;

  // s
  if (der[offset] !== 0x02) {
    throw new Error('Expected INTEGER tag for s');
  }
  offset++;
  const sLen = der[offset++] as number;
  const sStart = der[offset] === 0x00 ? offset + 1 : offset;
  const sEnd = offset + sLen;
  const sBytes = der.slice(sStart, sEnd);

  // Pad to 32 bytes each
  const raw = new Uint8Array(64);
  raw.set(rBytes, 32 - rBytes.length);
  raw.set(sBytes, 64 - sBytes.length);

  return raw;
}

/**
 * Sign an intent payload with a passkey.
 *
 * @param challenge - Raw bytes to sign (will be used as WebAuthn challenge)
 * @param credentialId - Optional specific credential to use
 * @returns PasskeyAssertion with 64-byte r‖s signature
 */
export async function signWithPasskey(
  challenge: Uint8Array,
  credentialId?: string,
): Promise<PasskeyAssertion> {
  const allowCredentials: PublicKeyCredentialDescriptor[] =
    credentialId !== undefined
      ? [
          {
            id: Uint8Array.from(atob(credentialId), (c) => c.charCodeAt(0)),
            type: 'public-key' as const,
          },
        ]
      : [];

  const credential = await navigator.credentials.get({
    publicKey: {
      challenge,
      timeout: 60_000,
      userVerification: 'required',
      allowCredentials,
      rpId: globalThis.location?.hostname ?? 'localhost',
    },
  });

  if (!credential || credential.type !== 'public-key') {
    throw new Error('navigator.credentials.get() did not return a public-key credential');
  }

  const response = (credential as PublicKeyCredential).response;
  // Duck-type check: response must have the assertion fields
  if (
    !response ||
    !('authenticatorData' in response) ||
    !('clientDataJSON' in response) ||
    !('signature' in response)
  ) {
    throw new Error('Credential response is not an AuthenticatorAssertionResponse');
  }

  const assertionResponse = response as AuthenticatorAssertionResponse;
  const rawSig = new Uint8Array(assertionResponse.signature);

  // Convert DER → raw r‖s
  let signature: Uint8Array;
  try {
    signature = derToRaw(rawSig);
  } catch {
    // Already raw (e.g. in test mocks that return 64-byte signatures directly)
    if (rawSig.length === 64) {
      signature = rawSig;
    } else {
      throw new Error(
        `Unexpected signature format: length=${rawSig.length}, first byte=0x${rawSig[0]?.toString(16) ?? '??'}`,
      );
    }
  }

  // Validate: must be exactly 64 bytes
  if (signature.length !== 64) {
    throw new Error(
      `Signature must be 64 bytes (r‖s), got ${signature.length}`,
    );
  }

  return {
    authenticatorData: new Uint8Array(assertionResponse.authenticatorData),
    clientDataJSON: new Uint8Array(assertionResponse.clientDataJSON),
    signature,
    credentialId: (credential as PublicKeyCredential).id,
  };
}
