import { keccak_256 } from '@noble/hashes/sha3';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Wallet contract v0.2.0 (webauthn-p256 variant) code hash (SHA-256 of WASM bytes).
 * This is the global contract hash used with NEP-591/NEP-616 StateInit.
 *
 * ADR-0003 pins to wallet-contracts-v0.2.0 (commit 930902e from near/intents repo).
 * Variant: defuse-wallet --features="contract,webauthn-p256" --release
 * Built with: cargo build -p defuse-wallet --target wasm32-unknown-unknown
 *             --no-default-features --features="contract,webauthn-p256" --release
 *
 * To re-derive: sha256 of the compiled WASM binary.
 * Note: This must be deployed as a global contract on testnet via DeployGlobalContract action
 *       (NEP-591) before accounts can be created with this hash.
 */
export const WALLET_CONTRACT_CODE_HASH_HEX =
  '0945dbdfca98628565f0ec5ae43e4ca3c7b92399a704457abcf034c460b12ffa';

/**
 * Default nonce timeout in seconds (u32) — 1 hour, matching wallet contract default.
 */
const DEFAULT_TIMEOUT_SECS = 3600;

// ---------------------------------------------------------------------------
// Borsh helpers (self-contained, no external borsh lib)
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

function borshU32(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, value, true);
  return buf;
}

function borshU64(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  const lo = Number(value & 0xffffffffn);
  const hi = Number((value >> 32n) & 0xffffffffn);
  view.setUint32(0, lo, true);
  view.setUint32(4, hi, true);
  return buf;
}

function borshBytes(data: Uint8Array): Uint8Array {
  return concat(borshU32(data.length), data);
}

function borshString(s: string): Uint8Array {
  const encoded = new TextEncoder().encode(s);
  return concat(borshU32(encoded.length), encoded);
}

// ---------------------------------------------------------------------------
// Borsh-encode Nonces struct
//
// struct Nonces {
//   timeout:        u32  (seconds, via DurationSeconds<u32>)
//   last_cleaned_at: u64 (nanoseconds, via TimestampNanoSeconds<u64>)
//   old:  BitMap<BTreeMap<u32,u32>>  (transparent → BTreeMap → empty = u32(0))
//   current: BitMap<BTreeMap<u32,u32>> (transparent → BTreeMap → empty = u32(0))
// }
// ---------------------------------------------------------------------------
function borshNonces(): Uint8Array {
  return concat(
    borshU32(DEFAULT_TIMEOUT_SECS),   // timeout: u32 seconds
    borshU64(0n),                      // last_cleaned_at: 0 nanoseconds (UNIX_EPOCH)
    borshU32(0),                       // old BTreeMap: empty (count = 0)
    borshU32(0),                       // current BTreeMap: empty (count = 0)
  );
}

// ---------------------------------------------------------------------------
// Borsh-encode State<P256CompressedPublicKey>
//
// struct State<PubKey> {  (BorshSerialize field order)
//   signature_enabled: bool (1 byte: 0x01)
//   subwallet_id: u32
//   public_key: PubKey  (for P256CompressedPublicKey = [u8; 33])
//   nonces: Nonces
//   extensions: BTreeSet<AccountId>  (empty = u32(0))
// }
// ---------------------------------------------------------------------------
function borshState(compressedPublicKey: Uint8Array): Uint8Array {
  if (compressedPublicKey.length !== 33) {
    throw new Error(
      `Expected 33-byte compressed P-256 public key, got ${compressedPublicKey.length} bytes`,
    );
  }
  // Extensions BTreeSet: include floors-dev.testnet as a pre-registered extension
  // so the relayer can call w_execute_extension to transfer user tokens.
  // BTreeSet<AccountId> in borsh = u32(count) + sorted [borshString(account_id)...]
  const extensions = concat(
    borshU32(1),                            // 1 extension
    borshString('floors-dev.testnet'),      // the relayer account
  );

  return concat(
    new Uint8Array([0x01]),    // signature_enabled: true
    borshU32(0),               // subwallet_id: 0 (DEFAULT_SUBWALLET_ID)
    compressedPublicKey,       // [u8; 33] compressed SEC1 (no length prefix — fixed array)
    borshNonces(),             // nonces
    extensions,                // extensions BTreeSet: floors-dev.testnet
  );
}

// ---------------------------------------------------------------------------
// Borsh-encode StateInit V1 (NEP-616)
//
// enum StateInit {
//   V1(StateInitV1),   // discriminant 0 (u8)
// }
//
// struct StateInitV1 {
//   code: ContractCode,
//   data: BTreeMap<Vec<u8>, Vec<u8>>,
// }
//
// enum ContractCode {
//   GlobalCodeHash(CryptoHash),  // discriminant 0 (u8), CryptoHash = [u8; 32]
//   GlobalAccountId(AccountId),  // discriminant 1
// }
//
// BTreeMap<Vec<u8>, Vec<u8>> with single entry { b"" => borsh(state) }:
//   count: u32(1)
//   entry[0]: key = borshBytes(b"") = [0,0,0,0], value = borshBytes(borshState(...))
// ---------------------------------------------------------------------------
function borshStateInit(codeHashBytes: Uint8Array, stateBytes: Uint8Array): Uint8Array {
  if (codeHashBytes.length !== 32) {
    throw new Error(`Expected 32-byte code hash, got ${codeHashBytes.length}`);
  }

  // BTreeMap entry: empty key → state value
  const emptyKey = new Uint8Array(0);
  const mapEntry = concat(borshBytes(emptyKey), borshBytes(stateBytes));
  const mapLen = borshU32(1); // 1 entry

  // ContractCode::GlobalCodeHash = discriminant 0 + 32 bytes
  const contractCode = concat(new Uint8Array([0x00]), codeHashBytes);

  // StateInitV1 = code + data
  const v1 = concat(contractCode, mapLen, mapEntry);

  // StateInit::V1 = discriminant 0 + V1
  return concat(new Uint8Array([0x00]), v1);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive NEP-616 deterministic account ID from a P-256 public key.
 *
 * @param compressedPublicKey  33-byte SEC1 compressed P-256 public key (with leading tag byte)
 * @param codeHashHex          32-byte wallet contract code hash as hex string (64 hex chars)
 * @returns "0s" + hex(keccak256(borsh(StateInit))[12..32])  — 42-char string
 */
export function deriveAddress(
  compressedPublicKey: Uint8Array,
  codeHashHex: string = WALLET_CONTRACT_CODE_HASH_HEX,
): string {
  const codeHash = hexToBytes(codeHashHex);
  const stateBytes = borshState(compressedPublicKey);
  const stateInitBytes = borshStateInit(codeHash, stateBytes);

  const hash = keccak_256(stateInitBytes);
  // Take bytes [12..32] = 20 bytes
  const addressBytes = hash.slice(12, 32);
  return '0s' + bytesToHex(addressBytes);
}

/**
 * Encode the wallet State bytes for a given compressed P-256 public key.
 * Used to construct the `data` field of StateInit when creating the account.
 */
export function encodeWalletState(compressedPublicKey: Uint8Array): Uint8Array {
  return borshState(compressedPublicKey);
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Odd-length hex string');
  const result = new Uint8Array(hex.length / 2);
  for (let i = 0; i < result.length; i++) {
    result[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return result;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
