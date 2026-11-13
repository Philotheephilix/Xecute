import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  signQuote,
  verifyQuote,
  serializeQuotePayload,
  generateQuoteId,
  derivePublicKey,
  type QuotePayload,
} from '../signing.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKeypair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privBytes = new Uint8Array(
    privateKey.export({ type: 'pkcs8', format: 'der' }).slice(16),
  );
  const pubBytes = new Uint8Array(
    publicKey.export({ type: 'spki', format: 'der' }).slice(12),
  );
  return { privateKey: privBytes, publicKey: pubBytes };
}

function makePayload(): QuotePayload {
  return {
    id: generateQuoteId(),
    owner: 'alice.floors.near',
    asset: 'ETH',
    qty: 500_000_000_000_000_000n, // 0.5 ETH in wei
    floor_price_e6: 2_400_000_000n, // $2400.00
    fee_usdc: 48_000_000n, // $48.00
    sleeve: 'majors_sleeve_v1',
    expires_at: BigInt(Math.floor(Date.now() / 1000) + 20),
  };
}

// ---------------------------------------------------------------------------
// generateQuoteId
// ---------------------------------------------------------------------------

describe('generateQuoteId', () => {
  it('returns a Uint8Array of 32 bytes', () => {
    const id = generateQuoteId();
    expect(id).toBeInstanceOf(Uint8Array);
    expect(id.length).toBe(32);
  });

  it('generates unique IDs each call', () => {
    const id1 = generateQuoteId();
    const id2 = generateQuoteId();
    expect(Buffer.from(id1).toString('hex')).not.toBe(Buffer.from(id2).toString('hex'));
  });
});

// ---------------------------------------------------------------------------
// serializeQuotePayload
// ---------------------------------------------------------------------------

describe('serializeQuotePayload', () => {
  it('returns a Uint8Array', () => {
    const payload = makePayload();
    const bytes = serializeQuotePayload(payload);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(32);
  });

  it('is deterministic for the same input', () => {
    const payload = makePayload();
    const a = serializeQuotePayload(payload);
    const b = serializeQuotePayload(payload);
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
  });

  it('produces different bytes when owner changes', () => {
    const p1 = makePayload();
    const p2 = { ...p1, owner: 'bob.floors.near' };
    const b1 = serializeQuotePayload(p1);
    const b2 = serializeQuotePayload(p2);
    expect(Buffer.from(b1).toString('hex')).not.toBe(Buffer.from(b2).toString('hex'));
  });

  it('encodes borsh string with 4-byte LE length prefix', () => {
    const payload = makePayload();
    // 'alice.floors.near' is 17 bytes
    const bytes = serializeQuotePayload(payload);
    // After 32-byte id, next 4 bytes should be 17 in LE
    const ownerLen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(32, true);
    expect(ownerLen).toBe('alice.floors.near'.length);
  });
});

// ---------------------------------------------------------------------------
// derivePublicKey
// ---------------------------------------------------------------------------

describe('derivePublicKey', () => {
  it('derives matching public key from private key', () => {
    const { privateKey, publicKey } = makeKeypair();
    const derived = derivePublicKey(privateKey);
    expect(Buffer.from(derived).toString('hex')).toBe(
      Buffer.from(publicKey).toString('hex'),
    );
  });

  it('throws for wrong-length private key', () => {
    expect(() => derivePublicKey(new Uint8Array(16))).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// signQuote / verifyQuote — round-trip
// ---------------------------------------------------------------------------

describe('signQuote + verifyQuote', () => {
  it('produces a 64-byte signature', () => {
    const { privateKey } = makeKeypair();
    const payload = makePayload();
    const sig = signQuote(payload, privateKey);
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);
  });

  it('verifies a valid signature', () => {
    const { privateKey, publicKey } = makeKeypair();
    const payload = makePayload();
    const sig = signQuote(payload, privateKey);
    expect(verifyQuote(payload, sig, publicKey)).toBe(true);
  });

  it('rejects a signature from a different keypair', () => {
    const kp1 = makeKeypair();
    const kp2 = makeKeypair();
    const payload = makePayload();
    const sig = signQuote(payload, kp1.privateKey);
    expect(verifyQuote(payload, sig, kp2.publicKey)).toBe(false);
  });

  it('rejects when one byte of the signature is mutated', () => {
    const { privateKey, publicKey } = makeKeypair();
    const payload = makePayload();
    const sig = signQuote(payload, privateKey);
    // Flip a byte in the middle of the signature
    const corrupted = new Uint8Array(sig);
    const byte31 = corrupted[31];
    if (byte31 !== undefined) corrupted[31] = byte31 ^ 0x01;
    expect(verifyQuote(payload, corrupted, publicKey)).toBe(false);
  });

  it('rejects when the owner field is mutated', () => {
    const { privateKey, publicKey } = makeKeypair();
    const payload = makePayload();
    const sig = signQuote(payload, privateKey);
    const tampered = { ...payload, owner: 'mallory.near' };
    expect(verifyQuote(tampered, sig, publicKey)).toBe(false);
  });

  it('rejects when the fee is mutated', () => {
    const { privateKey, publicKey } = makeKeypair();
    const payload = makePayload();
    const sig = signQuote(payload, privateKey);
    const tampered = { ...payload, fee_usdc: payload.fee_usdc + 1n };
    expect(verifyQuote(tampered, sig, publicKey)).toBe(false);
  });

  it('rejects when the floor price is mutated', () => {
    const { privateKey, publicKey } = makeKeypair();
    const payload = makePayload();
    const sig = signQuote(payload, privateKey);
    const tampered = { ...payload, floor_price_e6: payload.floor_price_e6 - 1_000_000n };
    expect(verifyQuote(tampered, sig, publicKey)).toBe(false);
  });

  it('rejects when expires_at is mutated', () => {
    const { privateKey, publicKey } = makeKeypair();
    const payload = makePayload();
    const sig = signQuote(payload, privateKey);
    const tampered = { ...payload, expires_at: payload.expires_at + 3600n };
    expect(verifyQuote(tampered, sig, publicKey)).toBe(false);
  });

  it('same payload signed twice gives different-but-both-valid signatures (Ed25519 is deterministic)', () => {
    const { privateKey, publicKey } = makeKeypair();
    const payload = makePayload();
    const sig1 = signQuote(payload, privateKey);
    const sig2 = signQuote(payload, privateKey);
    // Ed25519 is deterministic (RFC 8032) — same payload → same sig
    expect(Buffer.from(sig1).toString('hex')).toBe(Buffer.from(sig2).toString('hex'));
    // Both verify
    expect(verifyQuote(payload, sig1, publicKey)).toBe(true);
    expect(verifyQuote(payload, sig2, publicKey)).toBe(true);
  });

  it('throws for a 16-byte private key (wrong length)', () => {
    const payload = makePayload();
    expect(() => signQuote(payload, new Uint8Array(16))).toThrow(RangeError);
  });

  it('returns false for a 32-byte (too short) signature', () => {
    const { publicKey } = makeKeypair();
    const payload = makePayload();
    expect(verifyQuote(payload, new Uint8Array(32), publicKey)).toBe(false);
  });

  it('different assets produce different signatures', () => {
    const { privateKey, publicKey } = makeKeypair();
    const p1 = makePayload();
    const p2 = { ...p1, asset: 'SOL' };
    const sig1 = signQuote(p1, privateKey);
    const sig2 = signQuote(p2, privateKey);
    expect(Buffer.from(sig1).toString('hex')).not.toBe(Buffer.from(sig2).toString('hex'));
    // Each sig only verifies against its own payload
    expect(verifyQuote(p1, sig1, publicKey)).toBe(true);
    expect(verifyQuote(p2, sig2, publicKey)).toBe(true);
    expect(verifyQuote(p1, sig2, publicKey)).toBe(false);
    expect(verifyQuote(p2, sig1, publicKey)).toBe(false);
  });
});
