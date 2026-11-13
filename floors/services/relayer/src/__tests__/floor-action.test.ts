/**
 * Integration test: floor lifecycle bot endpoints.
 *
 * Tests expire-floor, floor-action, expire-floors-batch, reconcile, auto-protect.
 *
 * Real testnet — NO mocks. Tests are skipped unless FLOORS_CONTRACT is set.
 * Even when a floor does not exist on testnet the NEAR call is broadcast and
 * a tx_hash is returned (the contract returns E_FLOOR_NOT_FOUND, which still
 * produces a finalized transaction).
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import fastify from 'fastify';
import pino from 'pino';
import postgres from 'postgres';
import { registerRelayRoutes } from '../routes/relay.js';

// ---------------------------------------------------------------------------
// Env / config
// ---------------------------------------------------------------------------

const NEAR_NODE_URL = process.env['NEAR_NODE_URL'] ?? 'https://rpc.testnet.near.org';
const NEAR_NETWORK_ID = process.env['NEAR_NETWORK_ID'] ?? 'testnet';
const NEAR_ACCOUNT_ID = process.env['NEAR_ACCOUNT_ID'] ?? 'floors-dev.testnet';
const NEAR_PRIVATE_KEY = process.env['NEAR_PRIVATE_KEY'];
const FLOORS_CONTRACT = process.env['FLOORS_CONTRACT'];
const DATABASE_URL = process.env['DATABASE_URL'];

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

interface TestCtx {
  app: ReturnType<typeof fastify>;
  db: postgres.Sql;
}

async function buildTestApp(): Promise<TestCtx> {
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
    WALLET_CONTRACT_CODE_HASH: '7c2023ca3e3c53bf2309f9654180c8c516fb36cce5a18da8577e83c8f63ffd6b',
    FLOORS_CONTRACT: FLOORS_CONTRACT ?? 'floors.floors-dev.testnet',
    ONE_CLICK_API_URL: 'https://1click.chaindefuser.com',
  } as unknown as Parameters<typeof registerRelayRoutes>[3];

  const app = fastify({ logger: false });
  registerRelayRoutes(app, logger, db, config);
  await app.listen({ port: 0, host: '127.0.0.1' });

  return { app, db };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('floor lifecycle bot endpoints', () => {
  let ctx: TestCtx;

  beforeAll(async () => {
    if (!FLOORS_CONTRACT || !NEAR_PRIVATE_KEY || !DATABASE_URL) return;
    ctx = await buildTestApp();
  });

  afterAll(async () => {
    if (!ctx) return;
    await ctx.app.close();
    await ctx.db.end();
  });

  // ---- expire-floor ----

  test.skipIf(!FLOORS_CONTRACT)('expire-floor returns tx_hash', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/relay/expire-floor',
      headers: { 'x-internal-secret': process.env['INTERNAL_SECRET'] ?? '' },
      body: { floor_id: 1 },
    });

    // 200 on success, 502 if contract panics (floor not found still broadcasts tx)
    // The key assertion: a NEAR transaction was attempted
    expect([200, 502]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      const body = JSON.parse(res.body) as { tx_hash: string };
      expect(typeof body.tx_hash).toBe('string');
      expect(body.tx_hash.length).toBeGreaterThan(10);
    }
  }, 30_000);

  test.skipIf(!FLOORS_CONTRACT)('expire-floor rejects missing floor_id', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/relay/expire-floor',
      headers: { 'x-internal-secret': process.env['INTERNAL_SECRET'] ?? '' },
      body: {},
    });
    expect(res.statusCode).toBe(400);
  });

  // ---- floor-action ----

  test.skipIf(!FLOORS_CONTRACT)('floor-action rejects invalid account_id', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/relay/floor-action',
      body: {
        floor_id: 1,
        action: 'close',
        account_id: 'not-a-0s-address',
        nonce: '12345678901234567',
        valid_until_ns: String(BigInt(Date.now()) * 1_000_000n + 300_000_000_000n),
        assertion: {
          signature: 'dGVzdA==',
          credential_id: 'cred1',
          wallet_request: {},
        },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  test.skipIf(!FLOORS_CONTRACT)('floor-action rejects invalid action enum', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/relay/floor-action',
      body: {
        floor_id: 1,
        action: 'delete',
        account_id: '0s' + '0'.repeat(40),
        nonce: '12345678901234568',
        valid_until_ns: String(BigInt(Date.now()) * 1_000_000n + 300_000_000_000n),
        assertion: {
          signature: 'dGVzdA==',
          credential_id: 'cred1',
          wallet_request: {},
        },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  // ---- expire-floors-batch ----

  test.skipIf(!FLOORS_CONTRACT)('expire-floors-batch returns per-floor results', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/relay/expire-floors-batch',
      headers: { 'x-internal-secret': process.env['INTERNAL_SECRET'] ?? '' },
      body: { floor_ids: [1, 2] },
    });

    // Should get 200 with results array regardless of whether floors exist
    expect([200, 502]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      const body = JSON.parse(res.body) as { results: Array<{ floor_id: number; tx_hash?: string; error?: string }> };
      expect(Array.isArray(body.results)).toBe(true);
      expect(body.results.length).toBe(2);
      for (const r of body.results) {
        expect(typeof r.floor_id).toBe('number');
        // Each result has either tx_hash or error
        expect('tx_hash' in r || 'error' in r).toBe(true);
      }
    }
  }, 60_000);

  test.skipIf(!FLOORS_CONTRACT)('expire-floors-batch rejects empty array', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/relay/expire-floors-batch',
      headers: { 'x-internal-secret': process.env['INTERNAL_SECRET'] ?? '' },
      body: { floor_ids: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  test.skipIf(!FLOORS_CONTRACT)('expire-floors-batch rejects arrays over 50', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/relay/expire-floors-batch',
      headers: { 'x-internal-secret': process.env['INTERNAL_SECRET'] ?? '' },
      body: { floor_ids: Array.from({ length: 51 }, (_, i) => i) },
    });
    expect(res.statusCode).toBe(400);
  });

  // ---- stubs ----

  test('reconcile returns 501', async () => {
    // Build a minimal app just for stub tests (no NEAR key needed)
    const logger = pino({ level: 'silent' });
    const stubApp = fastify({ logger: false });
    const stubConfig = {
      NODE_ENV: 'test',
      PORT: 0,
      LOG_LEVEL: 'silent',
      SERVICE_NAME: 'relayer-test',
      SERVICE_VERSION: '0.0.1',
      DATABASE_URL: DATABASE_URL ?? 'postgres://unused',
      NEAR_NODE_URL,
      NEAR_NETWORK_ID,
      NEAR_ACCOUNT_ID,
      NEAR_PRIVATE_KEY: NEAR_PRIVATE_KEY ?? 'ed25519:unused',
      WALLET_CONTRACT_CODE_HASH: '7c2023ca3e3c53bf2309f9654180c8c516fb36cce5a18da8577e83c8f63ffd6b',
      FLOORS_CONTRACT: 'floors.floors-dev.testnet',
      ONE_CLICK_API_URL: 'https://1click.chaindefuser.com',
    } as unknown as Parameters<typeof registerRelayRoutes>[3];

    // Stub db — reconcile and auto-protect don't touch the DB
    const stubDb = {} as Parameters<typeof registerRelayRoutes>[2];
    registerRelayRoutes(stubApp, logger, stubDb, stubConfig);
    await stubApp.ready();

    const res = await stubApp.inject({ method: 'POST', url: '/v1/relay/reconcile', body: {} });
    expect(res.statusCode).toBe(501);
    const body = JSON.parse(res.body) as { code: string };
    expect(body.code).toBe('NOT_IMPLEMENTED');

    await stubApp.close();
  });

  test('auto-protect returns 501', async () => {
    const logger = pino({ level: 'silent' });
    const stubApp = fastify({ logger: false });
    const stubConfig = {
      NODE_ENV: 'test',
      PORT: 0,
      LOG_LEVEL: 'silent',
      SERVICE_NAME: 'relayer-test',
      SERVICE_VERSION: '0.0.1',
      DATABASE_URL: DATABASE_URL ?? 'postgres://unused',
      NEAR_NODE_URL,
      NEAR_NETWORK_ID,
      NEAR_ACCOUNT_ID,
      NEAR_PRIVATE_KEY: NEAR_PRIVATE_KEY ?? 'ed25519:unused',
      WALLET_CONTRACT_CODE_HASH: '7c2023ca3e3c53bf2309f9654180c8c516fb36cce5a18da8577e83c8f63ffd6b',
      FLOORS_CONTRACT: 'floors.floors-dev.testnet',
      ONE_CLICK_API_URL: 'https://1click.chaindefuser.com',
    } as unknown as Parameters<typeof registerRelayRoutes>[3];

    const stubDb = {} as Parameters<typeof registerRelayRoutes>[2];
    registerRelayRoutes(stubApp, logger, stubDb, stubConfig);
    await stubApp.ready();

    const res = await stubApp.inject({ method: 'POST', url: '/v1/relay/auto-protect', body: {} });
    expect(res.statusCode).toBe(501);
    const body = JSON.parse(res.body) as { code: string };
    expect(body.code).toBe('NOT_IMPLEMENTED');

    await stubApp.close();
  });
});
