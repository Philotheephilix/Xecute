/**
 * Integration test: NEP-616 smart account creation lifecycle.
 *
 * This test hits the real NEAR testnet (https://rpc.testnet.near.org).
 * NO mocks — every fetch, RPC call and account lookup is real.
 *
 * Steps exercised:
 *  1. Generate a fresh P-256 keypair
 *  2. Derive the deterministic 0s… account ID via NEP-616
 *  3. Call POST /v1/relay/create-account on a locally-started Fastify server
 *  4. Assert the account now exists on NEAR testnet via view_account RPC
 *  5. Assert idempotency: second call with same idempotency_key returns 200 + same body
 *
 * The relayer needs:
 *  NEAR_NODE_URL, NEAR_NETWORK_ID, NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY
 *  WALLET_CONTRACT_CODE_HASH (defaults to the known testnet hash)
 *  DATABASE_URL — a real Postgres instance with the relayer schema.
 *
 * If DATABASE_URL or NEAR_PRIVATE_KEY is not set the tests are skipped.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { p256 } from '@noble/curves/p256';
import fastify from 'fastify';
import pino from 'pino';
import postgres from 'postgres';
// ---------------------------------------------------------------------------
// Local imports (built from workspace — paths resolve via tsconfig paths)
// ---------------------------------------------------------------------------

import { nearAccountExists } from '../near-tx.js';
import { registerRelayRoutes } from '../routes/relay.js';

// ---------------------------------------------------------------------------
// Env / config
// ---------------------------------------------------------------------------

const NEAR_NODE_URL = process.env['NEAR_NODE_URL'] ?? 'https://rpc.testnet.near.org';
const NEAR_NETWORK_ID = process.env['NEAR_NETWORK_ID'] ?? 'testnet';
const NEAR_ACCOUNT_ID = process.env['NEAR_ACCOUNT_ID'] ?? 'floors-dev.testnet';
const NEAR_PRIVATE_KEY = process.env['NEAR_PRIVATE_KEY'];
const WALLET_CONTRACT_CODE_HASH =
  process.env['WALLET_CONTRACT_CODE_HASH'] ??
  '7c2023ca3e3c53bf2309f9654180c8c516fb36cce5a18da8577e83c8f63ffd6b';
const DATABASE_URL = process.env['DATABASE_URL'];

// ---------------------------------------------------------------------------
// Skip guard
// ---------------------------------------------------------------------------

const SKIP = !NEAR_PRIVATE_KEY || !DATABASE_URL;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a NEP-616 "0s…" address from a compressed P-256 public key.
 * Inlined to keep this test self-contained (no @floors/wallet import needed
 * from within the relayer test package — the wallet package is separate).
 */
import { keccak_256 } from '@noble/hashes/sha3';

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Odd-length hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function borshU32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
}

function borshU64(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, Number(v & 0xffffffffn), true);
  dv.setUint32(4, Number((v >> 32n) & 0xffffffffn), true);
  return b;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

function borshBytes(data: Uint8Array): Uint8Array {
  return concat(borshU32(data.length), data);
}

function encodeWalletState(pk: Uint8Array): Uint8Array {
  const nonces = concat(
    borshU32(3600),  // timeout: u32
    borshU64(0n),    // last_cleaned_at: u64
    borshU32(0),     // old BTreeMap empty
    borshU32(0),     // current BTreeMap empty
  );
  return concat(
    new Uint8Array([0x01]), // signature_enabled: true
    borshU32(0),            // subwallet_id: 0
    pk,                     // [u8;33] compressed SEC1 — no length prefix
    nonces,
    borshU32(0),            // extensions BTreeSet: empty
  );
}

function deriveAddress(compressedKey: Uint8Array, codeHashHex: string): string {
  const codeHash = hexToBytes(codeHashHex);
  const stateBytes = encodeWalletState(compressedKey);

  const emptyKey = new Uint8Array(0);
  const mapEntry = concat(borshBytes(emptyKey), borshBytes(stateBytes));
  const contractCode = concat(new Uint8Array([0x00]), codeHash);
  const v1 = concat(contractCode, borshU32(1), mapEntry);
  const stateInit = concat(new Uint8Array([0x00]), v1);

  const hash = keccak_256(stateInit);
  return '0s' + bytesToHex(hash.slice(12, 32));
}

// ---------------------------------------------------------------------------
// Fastify app factory (mirrors src/index.ts without DB migration)
// ---------------------------------------------------------------------------

interface TestApp {
  app: ReturnType<typeof fastify>;
  db: postgres.Sql;
  baseUrl: string;
}

async function buildTestApp(): Promise<TestApp> {
  const db = postgres(DATABASE_URL as string, { max: 3 });

  const logger = pino({ level: 'silent' });

  const config = {
    NODE_ENV: 'testnet',
    PORT: 0,
    LOG_LEVEL: 'silent',
    SERVICE_NAME: 'relayer-test',
    SERVICE_VERSION: '0.0.1',
    DATABASE_URL: DATABASE_URL as string,
    NEAR_NODE_URL,
    NEAR_NETWORK_ID,
    NEAR_ACCOUNT_ID,
    NEAR_PRIVATE_KEY: NEAR_PRIVATE_KEY as string,
    WALLET_CONTRACT_CODE_HASH,
    ONE_CLICK_API_URL: 'https://1click.chaindefuser.com',
  } as unknown as Parameters<typeof registerRelayRoutes>[3];

  const app = fastify({ logger: false });

  // Register JSON body parser (Fastify v5 has it built-in)
  registerRelayRoutes(app, logger, db, config);

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Unexpected address type');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return { app, db, baseUrl };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('create-account integration (real testnet)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    if (SKIP) return;
    ctx = await buildTestApp();
  });

  afterAll(async () => {
    if (!ctx) return;
    await ctx.app.close();
    await ctx.db.end();
  });

  it('should be skipped when env vars are missing', () => {
    if (!SKIP) {
      // Not skipped — just a guard so the suite runs at all.
      expect(NEAR_PRIVATE_KEY).toBeTruthy();
      expect(DATABASE_URL).toBeTruthy();
    } else {
      // Soft-skip: print a warning and pass.
      console.warn('Skipping create-account integration: NEAR_PRIVATE_KEY or DATABASE_URL not set');
      expect(true).toBe(true);
    }
  });

  it('should create a new smart account on testnet and verify via RPC', async () => {
    if (SKIP) return;

    // ---- 1. Generate fresh P-256 keypair ----
    const privKey = p256.utils.randomPrivateKey();
    const compressedKey = p256.getPublicKey(privKey, true); // 33 bytes, compressed
    expect(compressedKey.length).toBe(33);

    // ---- 2. Derive NEP-616 address ----
    const accountId = deriveAddress(compressedKey, WALLET_CONTRACT_CODE_HASH);
    expect(accountId).toMatch(/^0s[0-9a-f]{40}$/);

    // Sanity: account should NOT exist before we create it
    // (Fresh key → no collision expected; skip check to avoid long RPC calls
    //  in the happy path — the create-account endpoint checks this itself)

    // ---- 3. Call create-account endpoint ----
    const idempotencyKey = crypto.randomUUID();
    const resp = await fetch(`${ctx.baseUrl}/v1/relay/create-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: accountId,
        public_key_hex: bytesToHex(compressedKey),
        idempotency_key: idempotencyKey,
      }),
    });

    expect(resp.status).toBe(201);
    const body = await resp.json() as { account_id: string; status: string; tx_hash: string };
    expect(body.account_id).toBe(accountId);
    expect(body.status).toBe('created');
    expect(typeof body.tx_hash).toBe('string');
    expect(body.tx_hash.length).toBeGreaterThan(10);

    // ---- 4. Verify account exists on NEAR testnet ----
    // NEAR testnet finalizes quickly; poll for up to 20 s
    let exists = false;
    for (let i = 0; i < 40; i++) {
      exists = await nearAccountExists(NEAR_NODE_URL, accountId);
      if (exists) break;
      await new Promise<void>((r) => setTimeout(r, 500));
    }
    expect(exists).toBe(true);

    // ---- 5. Idempotency: second call returns 200 with same body ----
    const resp2 = await fetch(`${ctx.baseUrl}/v1/relay/create-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: accountId,
        public_key_hex: bytesToHex(compressedKey),
        idempotency_key: idempotencyKey, // same key
      }),
    });

    expect(resp2.status).toBe(200);
    const body2 = await resp2.json() as { account_id: string; status: string; tx_hash: string };
    expect(body2.account_id).toBe(accountId);
    expect(body2.tx_hash).toBe(body.tx_hash);
  }, 60_000);

  it('should return 200 with status=exists for an already-existing account', async () => {
    if (SKIP) return;

    // Use the account we know exists from the previous live deploy
    const knownAccountId = '0s46235f0b85456057a8752b074066f624eea65fcb';
    const exists = await nearAccountExists(NEAR_NODE_URL, knownAccountId);

    if (!exists) {
      // Known account may have been cleaned up; skip gracefully
      console.warn(`Known account ${knownAccountId} not found on testnet, skipping`);
      return;
    }

    // Use a valid 33-byte placeholder key (the actual key doesn't matter here;
    // the endpoint checks NEAR first and short-circuits if the account exists)
    const dummyKey = new Uint8Array(33);
    dummyKey[0] = 0x02; // valid compressed SEC1 prefix

    const resp = await fetch(`${ctx.baseUrl}/v1/relay/create-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: knownAccountId,
        public_key_hex: bytesToHex(dummyKey),
        idempotency_key: crypto.randomUUID(),
      }),
    });

    expect(resp.status).toBe(200);
    const body = await resp.json() as { account_id: string; status: string; tx_hash: null };
    expect(body.account_id).toBe(knownAccountId);
    expect(body.status).toBe('exists');
    expect(body.tx_hash).toBeNull();
  }, 15_000);

  it('should reject invalid account_id format', async () => {
    if (SKIP) return;

    const resp = await fetch(`${ctx.baseUrl}/v1/relay/create-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: 'floors-dev.testnet', // not a 0s... address
        public_key_hex: '02' + '00'.repeat(32),
        idempotency_key: crypto.randomUUID(),
      }),
    });

    expect(resp.status).toBe(400);
  }, 10_000);

  it('should reject invalid public_key_hex (wrong length)', async () => {
    if (SKIP) return;

    const resp = await fetch(`${ctx.baseUrl}/v1/relay/create-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: '0s' + '0'.repeat(40),
        public_key_hex: 'deadbeef', // too short
        idempotency_key: crypto.randomUUID(),
      }),
    });

    expect(resp.status).toBe(400);
  }, 10_000);
});
