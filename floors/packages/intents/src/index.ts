import { sha256 } from '@noble/hashes/sha256';

// ---------------------------------------------------------------------------
// Intent types
// ---------------------------------------------------------------------------

/** Token diff (swap) intent */
export interface TokenDiff {
  type: 'TokenDiff';
  diff: Record<string, string>; // asset_id → signed decimal string amount
}

/** Transfer with message (open floor) */
export interface Transfer {
  type: 'Transfer';
  receiver_id: string;
  amount: string;
  asset: string;
  msg: string;
}

/** Auth call */
export interface AuthCall {
  type: 'AuthCall';
  contract_id: string;
  method_name: string;
  args: string;             // base64 JSON
  attached_deposit: string;
  gas: string;
}

export type Intent = TokenDiff | Transfer | AuthCall;

// ---------------------------------------------------------------------------
// Payload / signed intent
// ---------------------------------------------------------------------------

export interface IntentPayload {
  message: string;       // JSON of intents array
  nonce: Uint8Array;     // 32 bytes
  recipient: string;     // "intents.near"
  callback_url?: string;
}

export interface SignedIntent {
  standard: 'nep413';
  payload: IntentPayload;
  public_key: string;
  signature: string;
}

// ---------------------------------------------------------------------------
// buildIntentsMessage
// ---------------------------------------------------------------------------

/**
 * Build the canonical JSON string for an array of intents.
 * Follows NEP-413 convention: JSON array, keys sorted, no trailing whitespace.
 */
export function buildIntentsMessage(intents: Intent[]): string {
  return JSON.stringify(intents);
}

// ---------------------------------------------------------------------------
// deriveChallenge  — sha256(nep413_prefix || borsh(payload))
// ---------------------------------------------------------------------------

// NEP-413 tag prefix (32-byte little-endian u256 = tag value 413)
// 413 as a 32-byte LE array
const NEP413_TAG = (() => {
  const buf = new Uint8Array(32);
  let v = 413;
  for (let i = 0; i < 4; i++) {
    buf[i] = v & 0xff;
    v >>>= 8;
  }
  return buf;
})();

function borshString(s: string): Uint8Array {
  const encoded = new TextEncoder().encode(s);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, encoded.length, true);
  return concat(len, encoded);
}

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

function borshOption(value: string | undefined): Uint8Array {
  if (value === undefined) return new Uint8Array([0]);
  return concat(new Uint8Array([1]), borshString(value));
}

/**
 * Borsh-encode an IntentPayload per NEP-413 spec:
 *   struct Payload {
 *     message: String,
 *     nonce: [u8; 32],
 *     recipient: String,
 *     callback_url: Option<String>,
 *   }
 */
function borshPayload(payload: IntentPayload): Uint8Array {
  return concat(
    borshString(payload.message),
    payload.nonce,
    borshString(payload.recipient),
    borshOption(payload.callback_url),
  );
}

/**
 * Derive the WebAuthn challenge from an IntentPayload.
 * challenge = sha256(NEP413_TAG || borsh(payload))
 */
export function deriveChallenge(payload: IntentPayload): Uint8Array {
  const serialized = concat(NEP413_TAG, borshPayload(payload));
  return sha256(serialized);
}

// ---------------------------------------------------------------------------
// WYSIWYS verifier
// ---------------------------------------------------------------------------

export interface SheetSummary {
  asset: string;
  qty: string;
  floor_bps?: number;
  receiver_id?: string;
}

/**
 * Verify a signed payload matches what was shown on the sheet.
 * Returns a list of mismatch descriptions; empty array = OK.
 */
export function verifyAgainstSheet(
  payload: IntentPayload,
  sheet: SheetSummary,
): string[] {
  const mismatches: string[] = [];

  let intents: unknown;
  try {
    intents = JSON.parse(payload.message) as unknown;
  } catch {
    return ['payload.message is not valid JSON'];
  }

  if (!Array.isArray(intents) || intents.length === 0) {
    return ['payload.message must be a non-empty JSON array of intents'];
  }

  // Look for asset / qty in Transfer or TokenDiff intents
  let foundAsset = false;
  let foundQty = false;
  let foundReceiver = false;

  for (const intent of intents) {
    if (typeof intent !== 'object' || intent === null) continue;
    const i = intent as Record<string, unknown>;

    if (i['type'] === 'Transfer') {
      const transfer = i as { type: string; asset?: unknown; amount?: unknown; receiver_id?: unknown };
      if (transfer.asset !== undefined) {
        foundAsset = true;
        if (transfer.asset !== sheet.asset) {
          mismatches.push(
            `Transfer.asset mismatch: expected "${sheet.asset}", got "${String(transfer.asset)}"`,
          );
        }
      }
      if (transfer.amount !== undefined) {
        foundQty = true;
        if (transfer.amount !== sheet.qty) {
          mismatches.push(
            `Transfer.amount mismatch: expected "${sheet.qty}", got "${String(transfer.amount)}"`,
          );
        }
      }
      if (sheet.receiver_id !== undefined && transfer.receiver_id !== undefined) {
        foundReceiver = true;
        if (transfer.receiver_id !== sheet.receiver_id) {
          mismatches.push(
            `Transfer.receiver_id mismatch: expected "${sheet.receiver_id}", got "${String(transfer.receiver_id)}"`,
          );
        }
      }
    }

    if (i['type'] === 'TokenDiff') {
      const td = i as { type: string; diff?: unknown };
      if (typeof td.diff === 'object' && td.diff !== null) {
        const diff = td.diff as Record<string, unknown>;
        const assetVal = diff[sheet.asset];
        if (assetVal !== undefined) {
          foundAsset = true;
          foundQty = true;
          if (assetVal !== sheet.qty) {
            mismatches.push(
              `TokenDiff[${sheet.asset}] mismatch: expected "${sheet.qty}", got "${String(assetVal)}"`,
            );
          }
        }
      }
    }
  }

  if (!foundAsset) {
    mismatches.push(`No intent found referencing asset "${sheet.asset}"`);
  }
  if (!foundQty) {
    mismatches.push(`No intent found referencing qty "${sheet.qty}"`);
  }
  if (sheet.receiver_id !== undefined && !foundReceiver) {
    mismatches.push(`No Transfer intent found with receiver_id "${sheet.receiver_id}"`);
  }

  return mismatches;
}
