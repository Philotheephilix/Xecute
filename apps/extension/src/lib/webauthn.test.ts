/**
 * Unit tests for WebAuthn signing wrapper.
 *
 * Mocks navigator.credentials.get() and verifies:
 * - DER signature is converted to 64-byte r‖s
 * - Raw 64-byte signatures pass through unchanged
 * - Invalid signatures throw descriptive errors
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signWithPasskey, derToRaw } from './webauthn.js';

// ── DER helpers ───────────────────────────────────────────────────────────────

/**
 * Build a minimal valid DER-encoded ECDSA signature from r and s byte arrays.
 */
function buildDer(r: Uint8Array, s: Uint8Array): Uint8Array {
  const encodeInt = (bytes: Uint8Array): Uint8Array => {
    // Add leading zero if high bit is set (negative in DER)
    const needsPad = (bytes[0] ?? 0) >= 0x80;
    const len = bytes.length + (needsPad ? 1 : 0);
    const encoded = new Uint8Array(2 + len);
    encoded[0] = 0x02;
    encoded[1] = len;
    if (needsPad) {
      encoded[2] = 0x00;
      encoded.set(bytes, 3);
    } else {
      encoded.set(bytes, 2);
    }
    return encoded;
  };

  const rDer = encodeInt(r);
  const sDer = encodeInt(s);
  const total = rDer.length + sDer.length;

  const der = new Uint8Array(2 + total);
  der[0] = 0x30;
  der[1] = total;
  der.set(rDer, 2);
  der.set(sDer, 2 + rDer.length);

  return der;
}

// ── Mock credential factory ───────────────────────────────────────────────────
// jsdom does not implement WebAuthn globals, so we use plain objects
// that satisfy the duck-type checks in webauthn.ts.

function buildMockCredential(signatureBytes: Uint8Array, id = 'test-cred-id') {
  // Plain object that passes the duck-type check in webauthn.ts:
  // must have authenticatorData, clientDataJSON, and signature as ArrayBuffer
  const mockResponse = {
    authenticatorData: new Uint8Array(37).buffer,
    clientDataJSON: new TextEncoder().encode(
      JSON.stringify({ type: 'webauthn.get', challenge: 'test', origin: 'https://example.com' }),
    ).buffer,
    signature: signatureBytes.buffer,
  };

  return {
    id,
    type: 'public-key',
    response: mockResponse,
  } as unknown as PublicKeyCredential;
}

// ── Tests: derToRaw ───────────────────────────────────────────────────────────

describe('derToRaw', () => {
  it('converts standard DER to 64-byte r‖s', () => {
    const r = new Uint8Array(32).fill(0xaa);
    const s = new Uint8Array(32).fill(0xbb);
    const der = buildDer(r, s);

    const raw = derToRaw(der);

    expect(raw.length).toBe(64);
    expect(raw.slice(0, 32)).toEqual(r);
    expect(raw.slice(32, 64)).toEqual(s);
  });

  it('handles r with leading zero pad (high bit set)', () => {
    const r = new Uint8Array(32);
    r[0] = 0x80; // forces DER pad byte
    const s = new Uint8Array(32).fill(0x11);
    const der = buildDer(r, s);

    const raw = derToRaw(der);

    expect(raw.length).toBe(64);
    expect(raw[0]).toBe(0x80);
    expect(raw.slice(32, 64)).toEqual(s);
  });

  it('zero-pads short r to 32 bytes', () => {
    // r with leading zeros stripped (common in real WebAuthn)
    const rFull = new Uint8Array(32).fill(0x00);
    rFull[28] = 0x01;
    rFull[29] = 0x02;
    rFull[30] = 0x03;
    rFull[31] = 0x04;

    // Provide only the non-zero portion
    const rShort = rFull.slice(28);
    const s = new Uint8Array(32).fill(0x55);
    const der = buildDer(rShort, s);

    const raw = derToRaw(der);

    expect(raw.length).toBe(64);
    // r should be zero-padded back to 32 bytes in position 0..31
    expect(raw.slice(28, 32)).toEqual(rShort);
  });

  it('throws on invalid DER header', () => {
    const bad = new Uint8Array([0x99, 0x40]);
    expect(() => derToRaw(bad)).toThrow('Not a DER-encoded ECDSA signature');
  });

  it('throws if r tag is not 0x02', () => {
    // Build DER with wrong tag
    const bad = new Uint8Array([0x30, 0x04, 0x03, 0x01, 0xaa, 0x02, 0x01, 0xbb]);
    expect(() => derToRaw(bad)).toThrow('Expected INTEGER tag for r');
  });
});

// ── Tests: signWithPasskey ────────────────────────────────────────────────────

describe('signWithPasskey', () => {
  const originalCredentials = globalThis.navigator?.credentials;

  beforeEach(() => {
    // Ensure navigator.credentials.get is mockable
    if (!globalThis.navigator) {
      (globalThis as Record<string, unknown>).navigator = {};
    }
    if (!globalThis.navigator.credentials) {
      Object.defineProperty(globalThis.navigator, 'credentials', {
        value: { get: vi.fn() },
        configurable: true,
        writable: true,
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 64-byte r‖s signature and original DER from DER response', async () => {
    const r = new Uint8Array(32).fill(0xde);
    const s = new Uint8Array(32).fill(0xad);
    const der = buildDer(r, s);
    const credential = buildMockCredential(der, 'cred-abc');

    vi.spyOn(navigator.credentials, 'get').mockResolvedValue(credential);

    const challenge = new Uint8Array([1, 2, 3, 4]);
    const result = await signWithPasskey(challenge);

    expect(result.signature.length).toBe(64);
    expect(result.signature.slice(0, 32)).toEqual(r);
    expect(result.signature.slice(32, 64)).toEqual(s);
    expect(result.credentialId).toBe('cred-abc');
    // signatureDer should preserve the original DER bytes
    expect(result.signatureDer).toEqual(der);
  });

  it('passes through 64-byte raw signature unchanged and preserves DER', async () => {
    // Mock already returns a 64-byte raw signature (as in some test setups)
    const raw64 = new Uint8Array(64);
    for (let i = 0; i < 64; i++) raw64[i] = i;

    const credential = buildMockCredential(raw64, 'cred-raw');
    vi.spyOn(navigator.credentials, 'get').mockResolvedValue(credential);

    const result = await signWithPasskey(new Uint8Array([5, 6, 7]));

    expect(result.signature.length).toBe(64);
    expect(result.signature).toEqual(raw64);
    // signatureDer preserves original bytes even when they're raw
    expect(result.signatureDer).toEqual(raw64);
  });

  it('passes the challenge to navigator.credentials.get', async () => {
    const r = new Uint8Array(32).fill(0x01);
    const s = new Uint8Array(32).fill(0x02);
    const der = buildDer(r, s);
    const credential = buildMockCredential(der);

    const getSpy = vi
      .spyOn(navigator.credentials, 'get')
      .mockResolvedValue(credential);

    const challenge = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);
    await signWithPasskey(challenge);

    expect(getSpy).toHaveBeenCalledOnce();
    const callArg = getSpy.mock.calls[0]?.[0] as CredentialRequestOptions;
    expect(callArg.publicKey?.challenge).toEqual(challenge);
  });

  it('filters allowCredentials when credentialId provided', async () => {
    const r = new Uint8Array(32).fill(0x11);
    const s = new Uint8Array(32).fill(0x22);
    const der = buildDer(r, s);
    const credential = buildMockCredential(der, 'specific-cred');

    const getSpy = vi
      .spyOn(navigator.credentials, 'get')
      .mockResolvedValue(credential);

    // credentialId must be base64-encoded
    const credId = btoa('specific-cred');
    await signWithPasskey(new Uint8Array([1]), credId);

    const callArg = getSpy.mock.calls[0]?.[0] as CredentialRequestOptions;
    expect(callArg.publicKey?.allowCredentials).toHaveLength(1);
  });

  it('accepts base64url credential IDs (with - and _ chars)', async () => {
    const r = new Uint8Array(32).fill(0x11);
    const s = new Uint8Array(32).fill(0x22);
    const der = buildDer(r, s);
    const credential = buildMockCredential(der, 'b64url-cred');

    const getSpy = vi
      .spyOn(navigator.credentials, 'get')
      .mockResolvedValue(credential);

    // Build a base64url credential ID the same way createPasskeyInline does:
    // btoa → replace + with -, / with _, strip =
    const rawBytes = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa]);
    const credId = btoa(String.fromCharCode(...rawBytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    // This would throw "The string to be decoded is not correctly encoded"
    // before the fix, because atob() does not accept base64url characters
    await signWithPasskey(new Uint8Array([1]), credId);

    const callArg = getSpy.mock.calls[0]?.[0] as CredentialRequestOptions;
    expect(callArg.publicKey?.allowCredentials).toHaveLength(1);
    // Verify the decoded bytes match the original
    const decoded = callArg.publicKey?.allowCredentials?.[0]?.id;
    expect(new Uint8Array(decoded as ArrayBuffer)).toEqual(rawBytes);
  });

  it('uses empty allowCredentials when no credentialId given', async () => {
    const r = new Uint8Array(32).fill(0x33);
    const s = new Uint8Array(32).fill(0x44);
    const der = buildDer(r, s);
    const credential = buildMockCredential(der);

    const getSpy = vi
      .spyOn(navigator.credentials, 'get')
      .mockResolvedValue(credential);

    await signWithPasskey(new Uint8Array([9]));

    const callArg = getSpy.mock.calls[0]?.[0] as CredentialRequestOptions;
    expect(callArg.publicKey?.allowCredentials).toEqual([]);
  });

  it('throws when navigator.credentials.get rejects', async () => {
    vi.spyOn(navigator.credentials, 'get').mockRejectedValue(
      new Error('NotAllowedError'),
    );

    await expect(
      signWithPasskey(new Uint8Array([1, 2])),
    ).rejects.toThrow('NotAllowedError');
  });
});
