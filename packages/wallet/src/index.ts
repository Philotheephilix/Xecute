import { sha3_256 } from 'js-sha3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExternalCall {
  receiver_id: string;
  method_name: string;
  args: string;             // base64 JSON
  attached_near?: string;   // yoctoNEAR decimal string
  gas?: string;             // gas decimal string
}

export interface WalletRequest {
  nonce: string;            // u64 decimal
  valid_until_ns: string;   // absolute nanosecond timestamp
  external: ExternalCall[];
}

// ---------------------------------------------------------------------------
// Allowed receivers
// ---------------------------------------------------------------------------

export const ALLOWED_RECEIVERS = [
  'intents.near',
  'passkeys-registry.near',
  'floors.near',
] as const;

export type AllowedReceiver = (typeof ALLOWED_RECEIVERS)[number];

// ---------------------------------------------------------------------------
// Borsh helpers
// ---------------------------------------------------------------------------

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function borshString(s: string): Uint8Array {
  const encoded = new TextEncoder().encode(s);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, encoded.length, true);
  return concat(len, encoded);
}

function borshU64(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  // Write as little-endian u64
  const lo = Number(value & 0xffffffffn);
  const hi = Number((value >> 32n) & 0xffffffffn);
  view.setUint32(0, lo, true);
  view.setUint32(4, hi, true);
  return buf;
}

function borshOptionString(s: string | undefined): Uint8Array {
  if (s === undefined) return new Uint8Array([0]);
  return concat(new Uint8Array([1]), borshString(s));
}

function borshExternalCall(call: ExternalCall): Uint8Array {
  return concat(
    borshString(call.receiver_id),
    borshString(call.method_name),
    borshString(call.args),
    borshOptionString(call.attached_near),
    borshOptionString(call.gas),
  );
}

function borshExternalCalls(calls: ExternalCall[]): Uint8Array {
  const lenBuf = new Uint8Array(4);
  new DataView(lenBuf.buffer).setUint32(0, calls.length, true);
  return concat(lenBuf, ...calls.map(borshExternalCall));
}

function borshWalletRequest(req: WalletRequest): Uint8Array {
  return concat(
    borshU64(BigInt(req.nonce)),
    borshU64(BigInt(req.valid_until_ns)),
    borshExternalCalls(req.external),
  );
}

// ---------------------------------------------------------------------------
// PREFIX
// ---------------------------------------------------------------------------

const PREFIX = new TextEncoder().encode('NEAR_WALLET_CONTRACT/V1');

// ---------------------------------------------------------------------------
// buildWalletRequest
// ---------------------------------------------------------------------------

const DEFAULT_VALID_FOR_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Build a WalletRequest with a fresh random nonce and an expiry.
 */
export function buildWalletRequest(
  external: ExternalCall[],
  validForMs: number = DEFAULT_VALID_FOR_MS,
): WalletRequest {
  // Random u64 nonce using crypto
  const nonceBytes = new Uint8Array(8);
  crypto.getRandomValues(nonceBytes);
  const view = new DataView(nonceBytes.buffer);
  const nonce =
    (BigInt(view.getUint32(0, true)) | (BigInt(view.getUint32(4, true)) << 32n)) &
    0xffffffffffffffffn;

  const validUntilNs = BigInt(Date.now() + validForMs) * 1_000_000n;

  return {
    nonce: nonce.toString(),
    valid_until_ns: validUntilNs.toString(),
    external,
  };
}

/**
 * Hash a wallet request.
 * hash = SHA3-256("NEAR_WALLET_CONTRACT/V1" || borsh(WalletRequest))
 */
export function hashWalletRequest(req: WalletRequest): Uint8Array {
  const body = borshWalletRequest(req);
  const payload = concat(PREFIX, body);
  const hashHex = sha3_256(payload);
  // Convert hex string to Uint8Array
  const result = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    result[i] = parseInt(hashHex.slice(i * 2, i * 2 + 2), 16);
  }
  return result;
}

// ---------------------------------------------------------------------------
// validateWalletRequest
// ---------------------------------------------------------------------------

/**
 * Validate a WalletRequest.
 * Returns a list of violation descriptions; empty = OK.
 */
export function validateWalletRequest(req: WalletRequest): string[] {
  const violations: string[] = [];

  // Validate nonce is a valid u64
  try {
    const n = BigInt(req.nonce);
    if (n < 0n || n > 0xffffffffffffffffn) {
      violations.push(`nonce out of u64 range: ${req.nonce}`);
    }
  } catch {
    violations.push(`nonce is not a valid integer: ${req.nonce}`);
  }

  // Validate valid_until_ns
  try {
    const v = BigInt(req.valid_until_ns);
    if (v < 0n) {
      violations.push(`valid_until_ns must be non-negative`);
    }
    // Check not already expired
    const nowNs = BigInt(Date.now()) * 1_000_000n;
    if (v < nowNs) {
      violations.push(`wallet request is expired (valid_until_ns=${req.valid_until_ns})`);
    }
  } catch {
    violations.push(`valid_until_ns is not a valid integer: ${req.valid_until_ns}`);
  }

  // Validate external calls
  if (req.external.length === 0) {
    violations.push('external calls array is empty');
  }

  for (let i = 0; i < req.external.length; i++) {
    const call = req.external[i];
    if (call === undefined) continue;
    const allowed: readonly string[] = ALLOWED_RECEIVERS;
    if (!allowed.includes(call.receiver_id)) {
      violations.push(
        `external[${i}].receiver_id "${call.receiver_id}" is not in allowed receivers`,
      );
    }
    if (!call.method_name) {
      violations.push(`external[${i}].method_name is empty`);
    }
    if (call.attached_near !== undefined) {
      try {
        const v = BigInt(call.attached_near);
        if (v < 0n) violations.push(`external[${i}].attached_near must be non-negative`);
      } catch {
        violations.push(`external[${i}].attached_near is not a valid integer`);
      }
    }
    if (call.gas !== undefined) {
      try {
        const v = BigInt(call.gas);
        if (v < 0n) violations.push(`external[${i}].gas must be non-negative`);
      } catch {
        violations.push(`external[${i}].gas is not a valid integer`);
      }
    }
  }

  return violations;
}
