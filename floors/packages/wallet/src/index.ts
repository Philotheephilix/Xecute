import sha3 from 'js-sha3';
const { sha3_256 } = sha3;

// ---------------------------------------------------------------------------
// Types — Contract RequestMessage format (w_execute_signed)
// ---------------------------------------------------------------------------

/** Payload for a function_call action inside a NearPromise. */
export interface FunctionCallPayload {
  function_name: string;
  args: string;             // base64-encoded raw bytes
  deposit?: string;         // yoctoNEAR decimal; default "0"
  gas?: string;             // gas decimal; default "0" (serde default)
  gas_weight?: number;      // default 1
}

/** A single action inside a NearPromise. */
export interface NearActionJSON {
  action: 'function_call';
  payload: FunctionCallPayload;
}

/** A single outgoing promise in the Request. */
export interface NearPromiseJSON {
  receiver_id: string;
  refund_to?: string;       // optional AccountId
  actions: NearActionJSON[];
}

/** The Request struct (internal ops + external promises). */
export interface RequestJSON {
  internal?: never[];       // WalletOp — unused in our flow
  external?: NearPromiseJSON[];
}

/**
 * The contract's RequestMessage — the `msg` parameter for `w_execute_signed`.
 * JSON shape matches the Rust serde representation exactly.
 */
export interface RequestMessage {
  pay_for_gas?: boolean;    // default false; omitted in JSON when false
  chain_id: string;         // e.g. "testnet"
  signer_id: string;        // e.g. "0s..."
  nonce: number;            // u32
  created_at: string;       // RFC-3339 timestamp
  timeout_secs: number;     // seconds (u32)
  request: RequestJSON;
}

// ---------------------------------------------------------------------------
// Types — Legacy WalletRequest (kept for backward compat)
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
// RequestMessage Borsh serialization (contract format)
// ---------------------------------------------------------------------------

function borshBool(v: boolean): Uint8Array {
  return new Uint8Array([v ? 1 : 0]);
}

function borshU32(v: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, v >>> 0, true);
  return buf;
}

function borshU128(v: bigint): Uint8Array {
  const lo = v & ((1n << 64n) - 1n);
  const hi = v >> 64n;
  return concat(borshU64(lo), borshU64(hi));
}

function borshBytes(b: Uint8Array): Uint8Array {
  return concat(borshU32(b.length), b);
}

function borshOption<T>(v: T | null | undefined, fn: (val: T) => Uint8Array): Uint8Array {
  if (v === null || v === undefined) return new Uint8Array([0]);
  return concat(new Uint8Array([1]), fn(v));
}

function borshVec<T>(arr: T[], fn: (item: T) => Uint8Array): Uint8Array {
  return concat(borshU32(arr.length), ...arr.map(fn));
}

/** Borsh NearToken = u128 little-endian (yoctoNEAR). */
function borshNearToken(yocto: string | undefined): Uint8Array {
  return borshU128(BigInt(yocto ?? '0'));
}

/** Borsh Gas = u64 little-endian. */
function borshGas(gas: string | undefined): Uint8Array {
  return borshU64(BigInt(gas ?? '0'));
}

/**
 * Borsh-serialize a FunctionCall.
 * Layout: function_name(String) + args(Vec<u8>) + deposit(u128) + gas(u64) + gas_weight(u64)
 *
 * NOTE: `args` in JSON is base64-encoded; Borsh expects raw bytes.
 */
function borshFunctionCall(fc: FunctionCallPayload): Uint8Array {
  // Decode base64 args to raw bytes
  const argsRaw = fc.args
    ? Uint8Array.from(atob(fc.args), (c) => c.charCodeAt(0))
    : new Uint8Array(0);

  return concat(
    borshString(fc.function_name),
    borshBytes(argsRaw),
    borshNearToken(fc.deposit),
    borshGas(fc.gas),
    borshU64(BigInt(fc.gas_weight ?? 1)),
  );
}

/**
 * Borsh-serialize a NearAction enum.
 * Layout: discriminant(u8) + payload
 *   FunctionCall = 2
 */
function borshNearAction(action: NearActionJSON): Uint8Array {
  if (action.action === 'function_call') {
    return concat(new Uint8Array([2]), borshFunctionCall(action.payload));
  }
  throw new Error(`Unsupported NearAction variant: ${action.action}`);
}

/**
 * Borsh-serialize a NearPromise.
 * Layout: receiver_id(String) + refund_to(Option<String>) + actions(Vec<NearAction>)
 */
function borshNearPromise(promise: NearPromiseJSON): Uint8Array {
  return concat(
    borshString(promise.receiver_id),
    borshOption(promise.refund_to ?? null, borshString),
    borshVec(promise.actions, borshNearAction),
  );
}

/**
 * Borsh-serialize a Request.
 * Layout: internal(Vec<WalletOp>) + external(Vec<NearPromise>)
 */
function borshRequest(req: RequestJSON): Uint8Array {
  const internal = req.internal ?? [];
  const external = req.external ?? [];
  return concat(
    borshVec(internal, () => { throw new Error('WalletOp serialization not implemented'); }),
    borshVec(external, borshNearPromise),
  );
}

/**
 * Borsh-serialize a RequestMessage (the msg for `w_execute_signed`).
 *
 * Layout:
 *   pay_for_gas(bool) + chain_id(String) + signer_id(String) + nonce(u32)
 *   + created_at(u64 nanoseconds) + timeout(u32 seconds) + request(Request)
 */
export function borshRequestMessage(msg: RequestMessage): Uint8Array {
  const createdAtMs = new Date(msg.created_at).getTime();
  const createdAtNs = BigInt(createdAtMs) * 1_000_000n;

  return concat(
    borshBool(msg.pay_for_gas ?? false),
    borshString(msg.chain_id),
    borshString(msg.signer_id),
    borshU32(msg.nonce),
    borshU64(createdAtNs),
    borshU32(msg.timeout_secs),
    borshRequest(msg.request),
  );
}

/**
 * Compute the canonical hash of a RequestMessage:
 *
 *   SHA3-256(b"NEAR_WALLET_CONTRACT/V1" || borsh(msg))
 *
 * This is the challenge that must be signed via WebAuthn for `w_execute_signed`.
 */
export function hashRequestMessage(msg: RequestMessage): Uint8Array {
  const body = borshRequestMessage(msg);
  const payload = concat(PREFIX, body);
  const hashHex = sha3_256(payload);
  const result = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    result[i] = parseInt(hashHex.slice(i * 2, i * 2 + 2), 16);
  }
  return result;
}

/**
 * Build a RequestMessage for `w_execute_signed` with a fresh random nonce
 * and a created_at timestamp set 60 seconds in the past (for block lag).
 */
export function buildRequestMessage(
  chainId: string,
  signerId: string,
  external: NearPromiseJSON[],
  timeoutSecs: number = 3600,
): RequestMessage {
  // Random u32 nonce
  const nonce = crypto.getRandomValues(new Uint32Array(1))[0]!;

  // Set created_at 60 seconds in the past to account for block timestamp lag
  const createdAt = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  return {
    chain_id: chainId,
    signer_id: signerId,
    nonce,
    created_at: createdAt,
    timeout_secs: timeoutSecs,
    request: {
      external,
    },
  };
}

// ---------------------------------------------------------------------------
// validateWalletRequest (legacy)
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
