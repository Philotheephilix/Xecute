// ---------------------------------------------------------------------------
// Ed25519 signing for Floors floor quotes
//
// Signed message = UTF8("FLOORS_QUOTE/V1") || borsh(QuotePayload)
// Uses Node.js built-in crypto — no external signing library needed.
// ---------------------------------------------------------------------------

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// QuotePayload definition (matches Rust contract Borsh layout)
// ---------------------------------------------------------------------------

// NOTE: expires_at is Unix seconds (not nanoseconds).
// The on-chain FloorQuote.expires_at_ns field is nanoseconds, but the signing
// payload uses seconds for compactness. The Rust validate_quote_sig must match.
export interface QuotePayload {
  /** 32 bytes random quote ID */
  id: Uint8Array;
  /** NEAR account ID of the floor buyer */
  owner: string;
  /** Asset ticker e.g. "ETH" */
  asset: string;
  /** Token quantity (u128 little-endian 16 bytes) */
  qty: bigint;
  /** Floor price in USDC e6 (u128 little-endian 16 bytes) */
  floor_price_e6: bigint;
  /** Fee in USDC e6 (u128 little-endian 16 bytes) */
  fee_usdc: bigint;
  /** Sleeve identifier e.g. "majors_sleeve_v1" */
  sleeve: string;
  /** Unix timestamp (u64 little-endian 8 bytes) */
  expires_at: bigint;
}

// ---------------------------------------------------------------------------
// Minimal Borsh serializer for QuotePayload
//
// Borsh spec: https://borsh.io/
// - u8: 1 byte
// - u32: 4 bytes LE (used for string/array length)
// - u64: 8 bytes LE
// - u128: 16 bytes LE
// - string: u32 length + UTF-8 bytes
// - fixed bytes: raw bytes (no length prefix)
// ---------------------------------------------------------------------------

function writeU32LE(view: DataView, offset: number, value: number): number {
  view.setUint32(offset, value, true);
  return offset + 4;
}

function writeU64LE(buf: Uint8Array, offset: number, value: bigint): number {
  const lo = value & 0xffffffffn;
  const hi = (value >> 32n) & 0xffffffffn;
  const view = new DataView(buf.buffer, buf.byteOffset);
  view.setUint32(offset, Number(lo), true);
  view.setUint32(offset + 4, Number(hi), true);
  return offset + 8;
}

function writeU128LE(buf: Uint8Array, offset: number, value: bigint): number {
  // Write 16 bytes little-endian
  let v = value;
  for (let i = 0; i < 16; i++) {
    buf[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return offset + 16;
}

function encodeBorshString(s: string): Uint8Array {
  const utf8 = new TextEncoder().encode(s);
  const buf = new Uint8Array(4 + utf8.length);
  const view = new DataView(buf.buffer);
  writeU32LE(view, 0, utf8.length);
  buf.set(utf8, 4);
  return buf;
}

/**
 * Serialize a QuotePayload to Borsh bytes.
 *
 * Layout (in order):
 *   id:             [u8; 32]
 *   owner:          String (u32 len + bytes)
 *   asset:          String (u32 len + bytes)
 *   qty:            u128
 *   floor_price_e6: u128
 *   fee_usdc:       u128
 *   sleeve:         String (u32 len + bytes)
 *   expires_at:     u64
 */
export function serializeQuotePayload(payload: QuotePayload): Uint8Array {
  const ownerBytes = encodeBorshString(payload.owner);
  const assetBytes = encodeBorshString(payload.asset);
  const sleeveBytes = encodeBorshString(payload.sleeve);

  const totalLen =
    32 + // id
    ownerBytes.length +
    assetBytes.length +
    16 + // qty u128
    16 + // floor_price_e6 u128
    16 + // fee_usdc u128
    sleeveBytes.length +
    8; // expires_at u64

  const buf = new Uint8Array(totalLen);
  let offset = 0;

  // id: fixed 32 bytes
  buf.set(payload.id, offset);
  offset += 32;

  // owner: borsh string
  buf.set(ownerBytes, offset);
  offset += ownerBytes.length;

  // asset: borsh string
  buf.set(assetBytes, offset);
  offset += assetBytes.length;

  // qty: u128
  offset = writeU128LE(buf, offset, payload.qty);

  // floor_price_e6: u128
  offset = writeU128LE(buf, offset, payload.floor_price_e6);

  // fee_usdc: u128
  offset = writeU128LE(buf, offset, payload.fee_usdc);

  // sleeve: borsh string
  buf.set(sleeveBytes, offset);
  offset += sleeveBytes.length;

  // expires_at: u64
  offset = writeU64LE(buf, offset, payload.expires_at);

  return buf;
}

// ---------------------------------------------------------------------------
// Message construction
// ---------------------------------------------------------------------------

const PREFIX = new TextEncoder().encode('FLOORS_QUOTE/V1');

function buildMessage(payload: QuotePayload): Uint8Array {
  const serialized = serializeQuotePayload(payload);
  const msg = new Uint8Array(PREFIX.length + serialized.length);
  msg.set(PREFIX, 0);
  msg.set(serialized, PREFIX.length);
  return msg;
}

// ---------------------------------------------------------------------------
// Sign / verify
// ---------------------------------------------------------------------------

/**
 * Sign a QuotePayload with an Ed25519 private key.
 * @param payload        - the quote to sign
 * @param privateKeyBytes - raw 32-byte Ed25519 private key seed
 * @returns 64-byte Ed25519 signature
 */
export function signQuote(payload: QuotePayload, privateKeyBytes: Uint8Array): Uint8Array {
  if (privateKeyBytes.length !== 32) {
    throw new RangeError(`Ed25519 private key must be 32 bytes, got ${privateKeyBytes.length}`);
  }
  const message = buildMessage(payload);

  // Import the 32-byte seed as a Node.js Ed25519 key object via PKCS8 DER
  // PKCS8 prefix for Ed25519: 30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20 <32 bytes seed>
  const pkcs8Header = Buffer.from('302e020100300506032b657004220420', 'hex');
  const pkcs8Der = Buffer.concat([pkcs8Header, Buffer.from(privateKeyBytes)]);
  const privateKey = createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });

  const sigBuffer = sign(null, message, privateKey);
  return new Uint8Array(sigBuffer);
}

/**
 * Verify an Ed25519 signature over a QuotePayload.
 * @param payload        - the quote that was signed
 * @param sig            - 64-byte Ed25519 signature
 * @param publicKeyBytes - raw 32-byte Ed25519 public key
 * @returns true if valid
 */
export function verifyQuote(
  payload: QuotePayload,
  sig: Uint8Array,
  publicKeyBytes: Uint8Array,
): boolean {
  if (publicKeyBytes.length !== 32) {
    throw new RangeError(`Ed25519 public key must be 32 bytes, got ${publicKeyBytes.length}`);
  }
  if (sig.length !== 64) return false;

  const message = buildMessage(payload);

  // Import raw 32-byte public key via SubjectPublicKeyInfo DER
  // SPKI prefix for Ed25519: 30 2a 30 05 06 03 2b 65 70 03 21 00 <32 bytes key>
  const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
  const spkiDer = Buffer.concat([spkiHeader, Buffer.from(publicKeyBytes)]);
  const publicKey = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });

  try {
    return verify(null, message, publicKey, Buffer.from(sig));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Key loading from environment
// ---------------------------------------------------------------------------

/**
 * Load the Ed25519 private key from RISK_SIGNING_KEY_HEX env var.
 * Returns the 32-byte seed.
 */
export function loadSigningKey(): Uint8Array {
  const hex = process.env['RISK_SIGNING_KEY_HEX'];
  if (!hex || hex.length !== 64) {
    throw new Error(
      'RISK_SIGNING_KEY_HEX must be set to a 64-character hex string (32-byte Ed25519 seed)',
    );
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/**
 * Derive the public key bytes from a private key seed.
 * Useful for exposing the public key for on-chain registration.
 */
export function derivePublicKey(privateKeyBytes: Uint8Array): Uint8Array {
  if (privateKeyBytes.length !== 32) {
    throw new RangeError(`Ed25519 private key must be 32 bytes, got ${privateKeyBytes.length}`);
  }
  const pkcs8Header = Buffer.from('302e020100300506032b657004220420', 'hex');
  const pkcs8Der = Buffer.concat([pkcs8Header, Buffer.from(privateKeyBytes)]);
  const privateKey = createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });
  const publicKeyDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  // Strip 12-byte SPKI prefix to get raw 32-byte key
  return new Uint8Array(publicKeyDer.slice(12));
}

/**
 * Generate a new random 32-byte Ed25519 seed.
 */
export function generateQuoteId(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}
