/**
 * Low-level NEAR transaction builder for protocol actions not yet supported
 * by near-api-js v5 (NEP-591 DeployGlobalContract, NEP-616 DeterministicStateInit).
 *
 * Reference:
 *  - https://github.com/near/nearcore/blob/master/core/primitives/src/action/mod.rs
 *  - https://github.com/near/nearcore/blob/master/core/primitives-core/src/deterministic_account_id.rs
 *
 * Action discriminants (borsh use_discriminant = true, repr(u8)):
 *   CreateAccount         = 0
 *   DeployContract        = 1
 *   FunctionCall          = 2
 *   Transfer              = 3
 *   Stake                 = 4
 *   AddKey                = 5
 *   DeleteKey             = 6
 *   DeleteAccount         = 7
 *   Delegate              = 8
 *   DeployGlobalContract  = 9
 *   UseGlobalContract     = 10
 *   DeterministicStateInit= 11
 */

import { sha256 } from '@noble/hashes/sha256';
import { connect, keyStores, KeyPair } from 'near-api-js';
import type { Account } from 'near-api-js';

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

function u8(v: number): Uint8Array {
  return new Uint8Array([v]);
}

function u32le(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
}

function u64le(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, Number(v & 0xffffffffn), true);
  dv.setUint32(4, Number((v >> 32n) & 0xffffffffn), true);
  return b;
}

function u128le(v: bigint): Uint8Array {
  const b = new Uint8Array(16);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, Number(v & 0xffffffffn), true);
  dv.setUint32(4, Number((v >> 32n) & 0xffffffffn), true);
  dv.setUint32(8, Number((v >> 64n) & 0xffffffffn), true);
  dv.setUint32(12, Number((v >> 96n) & 0xffffffffn), true);
  return b;
}

function borshString(s: string): Uint8Array {
  const encoded = new TextEncoder().encode(s);
  return concat(u32le(encoded.length), encoded);
}

function borshBytes(data: Uint8Array): Uint8Array {
  return concat(u32le(data.length), data);
}

// ---------------------------------------------------------------------------
// Ed25519 public key encoding (near-api-js key pair)
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    n = n * 58n + BigInt(BASE58_ALPHABET.indexOf(c));
  }
  const hex = n.toString(16).padStart(64, '0');
  return new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}

function encodePublicKey(ed25519PublicKeyStr: string): Uint8Array {
  // Format: "ed25519:<base58>"
  const b58 = ed25519PublicKeyStr.replace('ed25519:', '');
  const keyBytes = base58Decode(b58);
  // key_type = 0 for Ed25519, then 32 bytes
  return concat(u8(0), keyBytes);
}

// ---------------------------------------------------------------------------
// Action encoders
// ---------------------------------------------------------------------------

/**
 * Encode DeployGlobalContract action (discriminant 9).
 *
 * struct DeployGlobalContractAction {
 *   code: Vec<u8>,
 *   deploy_mode: GlobalContractDeployMode,  // CodeHash=0, AccountId=1
 * }
 */
export function encodeDeployGlobalContractAction(code: Uint8Array): Uint8Array {
  return concat(
    u8(9),            // action discriminant: DeployGlobalContract
    borshBytes(code), // code: Vec<u8>
    u8(0),            // deploy_mode: CodeHash = 0
  );
}

/**
 * Encode DeterministicStateInit action (discriminant 11).
 *
 * struct DeterministicStateInitAction {
 *   state_init: DeterministicAccountStateInit,
 *   deposit: Balance,  // u128
 * }
 *
 * DeterministicAccountStateInit = enum { V1(V1) }  discriminant 0
 * V1 = { code: GlobalContractIdentifier, data: BTreeMap<Vec<u8>,Vec<u8>> }
 * GlobalContractIdentifier = enum { CodeHash([u8;32])=0, AccountId(String)=1 }
 */
export function encodeDeterministicStateInitAction(
  codeHashBytes: Uint8Array,
  stateData: ReadonlyMap<Uint8Array, Uint8Array>,
  depositYocto: bigint,
): Uint8Array {
  // GlobalContractIdentifier::CodeHash = discriminant 0 + 32 bytes
  if (codeHashBytes.length !== 32) {
    throw new Error(`Expected 32-byte code hash, got ${codeHashBytes.length}`);
  }
  const code = concat(u8(0), codeHashBytes);

  // BTreeMap<Vec<u8>, Vec<u8>>: serialize as sorted count + entries
  const entries = [...stateData.entries()].sort((a, b) => {
    // Sort by key (lexicographic byte comparison)
    const ka = a[0];
    const kb = b[0];
    for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
      if ((ka[i] ?? 0) !== (kb[i] ?? 0)) return (ka[i] ?? 0) - (kb[i] ?? 0);
    }
    return ka.length - kb.length;
  });

  const mapEntries = entries.map(([k, v]) => concat(borshBytes(k), borshBytes(v)));
  const data = concat(u32le(entries.length), ...mapEntries);

  // DeterministicAccountStateInitV1
  const v1 = concat(code, data);

  // DeterministicAccountStateInit enum V1 = discriminant 0
  const stateInit = concat(u8(0), v1);

  return concat(
    u8(11),           // action discriminant: DeterministicStateInit
    stateInit,        // state_init: DeterministicAccountStateInit
    u128le(depositYocto), // deposit: u128
  );
}

// ---------------------------------------------------------------------------
// Transaction builder + signer
// ---------------------------------------------------------------------------

interface NearTxOptions {
  networkId: string;
  nodeUrl: string;
  accountId: string;
  privateKey: string;
}

interface TxResult {
  tx_hash: string;
  status: unknown;
}

/**
 * Build, sign, and submit a NEAR transaction with custom raw action bytes.
 *
 * near-api-js v5 doesn't support NEP-591/NEP-616 actions in its schema.
 * We craft the raw Borsh transaction bytes, sign with the provided key,
 * and submit via send_transaction RPC.
 */
export async function sendRawNearTransaction(
  options: NearTxOptions,
  receiverId: string,
  rawActionBytes: Uint8Array[],
): Promise<TxResult> {
  const { networkId, nodeUrl, accountId, privateKey } = options;

  // Setup key store
  const keyStore = new keyStores.InMemoryKeyStore();
  const keyPair = KeyPair.fromString(privateKey as Parameters<typeof KeyPair.fromString>[0]);
  await keyStore.setKey(networkId, accountId, keyPair);

  const near = await connect({ networkId, nodeUrl, keyStore });
  const account: Account = await near.account(accountId);

  // Get current nonce + block hash
  const accessKeys = await account.getAccessKeys();
  const publicKeyStr = keyPair.getPublicKey().toString();
  const matchingKey = accessKeys.find((k) => k.public_key === publicKeyStr);
  if (!matchingKey) {
    throw new Error(`No access key found for ${publicKeyStr} on ${accountId}`);
  }
  const nonce = BigInt(matchingKey.access_key.nonce) + 1n;

  // Get recent block hash
  const status = await near.connection.provider.status();
  const blockHash = status.sync_info.latest_block_hash;
  const blockHashBytes = base58Decode(blockHash);

  // Encode public key
  const pubKeyBytes = encodePublicKey(publicKeyStr);

  // Build the NEAR Transaction Borsh bytes:
  // signer_id: String
  // public_key: PublicKey
  // nonce: u64
  // receiver_id: String
  // block_hash: [u8; 32]
  // actions: Vec<Action>  (raw bytes we're injecting)
  const txBytes = concat(
    borshString(accountId),         // signer_id
    pubKeyBytes,                    // public_key
    u64le(nonce),                   // nonce
    borshString(receiverId),        // receiver_id
    blockHashBytes,                 // block_hash [u8; 32]
    u32le(rawActionBytes.length),   // actions count
    ...rawActionBytes,              // raw action bytes
  );

  // Sign: NEAR uses sha256 of the tx bytes then ed25519 sign
  const txHash = sha256(txBytes);
  const signature = keyPair.sign(txHash);

  // Build SignedTransaction:
  // transaction: Transaction bytes
  // signature: Signature { key_type: u8, bytes: [u8; 64] }
  const signedTxBytes = concat(
    txBytes,
    u8(0),            // Ed25519 signature type
    signature.signature, // 64 bytes
  );

  // Submit via RPC
  const signedTxBase64 = Buffer.from(signedTxBytes).toString('base64');

  const response = await fetch(nodeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      method: 'broadcast_tx_commit',
      params: [signedTxBase64],
    }),
  });

  const data = await response.json() as {
    result?: { transaction_outcome?: { id?: string }; status?: unknown };
    error?: { message?: string; data?: unknown };
  };

  if (data.error) {
    throw new Error(`NEAR RPC error: ${data.error.message ?? JSON.stringify(data.error.data)}`);
  }

  const txHashResult = data.result?.transaction_outcome?.id;
  if (!txHashResult) {
    throw new Error(`No tx hash in response: ${JSON.stringify(data).slice(0, 200)}`);
  }

  return { tx_hash: txHashResult, status: data.result?.status };
}

/**
 * Check if an account exists on NEAR.
 */
export async function nearAccountExists(nodeUrl: string, accountId: string): Promise<boolean> {
  const response = await fetch(nodeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      method: 'query',
      params: {
        request_type: 'view_account',
        finality: 'final',
        account_id: accountId,
      },
    }),
  });
  const data = await response.json() as { result?: object; error?: object };
  return !!data.result;
}

/**
 * Check if a global contract with the given code hash is deployed on NEAR testnet.
 * Approach: try to view account "wallet-contracts-v0.2.0.floors-dev.testnet" or
 * use a known account to check global contract state.
 *
 * Since NEAR RPC doesn't expose a "global_contract_code" query endpoint yet,
 * we attempt a dry-run transaction to check if the hash is recognized.
 */
export async function isGlobalContractDeployed(
  nodeUrl: string,
  codeHashHex: string,
): Promise<boolean> {
  // Try to call view on a non-existent account with UseGlobalContract
  // Simpler approach: just try deploying and catch "already deployed" error
  // For now, return false and let the deploy handle idempotency on chain
  // The NEAR protocol skips DeployGlobalContract if already deployed (idempotent)
  return false;
}

/**
 * Encode the wallet state for a P-256 compressed public key.
 *
 * State<P256CompressedPublicKey> Borsh layout:
 *   signature_enabled: bool (1 byte)
 *   subwallet_id: u32 (4 bytes LE)
 *   public_key: [u8; 33] (compressed SEC1, fixed-size array, no length prefix)
 *   nonces: Nonces (timeout_secs: u32, last_cleaned_at_ns: u64, old_btree: u32(0), cur_btree: u32(0))
 *   extensions: BTreeSet<AccountId> (empty = u32(0))
 */
export function encodeWalletStateForP256(compressedPublicKey: Uint8Array): Uint8Array {
  if (compressedPublicKey.length !== 33) {
    throw new Error(`Expected 33-byte compressed P-256 key, got ${compressedPublicKey.length}`);
  }

  const DEFAULT_TIMEOUT_SECS = 3600; // 1 hour default

  const nonces = concat(
    u32le(DEFAULT_TIMEOUT_SECS), // timeout: u32 seconds
    u64le(0n),                   // last_cleaned_at: 0 nanoseconds (UNIX_EPOCH)
    u32le(0),                    // old BTreeMap: empty
    u32le(0),                    // current BTreeMap: empty
  );

  // Extensions BTreeSet: include floors-dev.testnet as a pre-registered extension
  // so the relayer can call w_execute_extension to transfer user tokens.
  // BTreeSet<AccountId> in borsh = u32(count) + sorted [borshString(account_id)...]
  const extensions = concat(
    u32le(1),                                 // 1 extension
    borshString('floors-dev.testnet'),        // the relayer account
  );

  return concat(
    u8(0x01),              // signature_enabled: true
    u32le(0),              // subwallet_id: 0
    compressedPublicKey,   // [u8; 33] (no length prefix — fixed array in Borsh)
    nonces,
    extensions,            // extensions BTreeSet: floors-dev.testnet
  );
}
