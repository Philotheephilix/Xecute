/**
 * Integration tests for floor-related endpoints:
 *  - POST /v1/quotes (with and without floor param)
 *  - GET /v1/suggestions
 *  - POST /v1/actions
 *  - POST /v1/sell
 *
 * Tests call the real API (no mocks).
 * Risk-dependent tests soft-skip if RISK_URL env var is not set.
 * DB-dependent tests use a minimal in-memory stub that satisfies the postgres.Sql interface.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, createLogger } from '@floors/shared-server';
import type { BaseConfig } from '@floors/shared-server';
import { registerQuoteRoutes } from '../routes/quotes.js';
import { registerActionsRoutes } from '../routes/actions.js';
import { registerSuggestionsRoutes } from '../routes/suggestions.js';
import type postgres from 'postgres';

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

const TEST_CONFIG: BaseConfig = {
  NODE_ENV: 'local',
  PORT: 3098,
  LOG_LEVEL: 'error',
  SERVICE_NAME: 'api-floors-test',
  SERVICE_VERSION: '0.0.1',
  DATABASE_URL: 'postgres://floors:floors@localhost:5432/floors_test',
};

// ---------------------------------------------------------------------------
// Minimal postgres stub — returns a status_id for INSERT queries
// ---------------------------------------------------------------------------

function makeDbStub(): postgres.Sql {
  // Minimal tagged-template stub: returns rows with a fake status_id for
  // INSERT ... RETURNING status_id; empty array otherwise.
  const stub = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const sql = strings.join('?');
    if (/returning\s+status_id/i.test(sql)) {
      return Promise.resolve([{ status_id: '00000000-0000-0000-0000-000000000042' }]);
    }
    return Promise.resolve([]);
  };
  // Attach the json helper that postgres.Sql has
  stub.json = (v: unknown) => v;
  return stub as unknown as postgres.Sql;
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

let app: FastifyInstance;

const RISK_URL = process.env['RISK_URL'];

beforeAll(async () => {
  const logger = createLogger({
    service: TEST_CONFIG.SERVICE_NAME,
    version: TEST_CONFIG.SERVICE_VERSION,
    level: TEST_CONFIG.LOG_LEVEL,
  });

  app = await createApp(TEST_CONFIG, logger);

  const db = makeDbStub();
  const relayerUrl = 'http://localhost:19999'; // guaranteed unreachable — fire-and-forget

  registerQuoteRoutes(app, RISK_URL ?? 'http://localhost:19998');
  registerActionsRoutes(app, db, relayerUrl);
  registerSuggestionsRoutes(app, db);

  await app.ready();
});

afterAll(async () => {
  if (app !== undefined) {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// POST /v1/quotes — without floor
// ---------------------------------------------------------------------------

describe('POST /v1/quotes without floor', () => {
  it('returns 200 with quote fields and no floor', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: {
        asset: 'ETH',
        qty: '1000000000000000000',
        account_id: '0s' + 'a'.repeat(40),
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      quote_id: string;
      asset: string;
      qty: string;
      floor?: unknown;
    };
    expect(body.quote_id).toBeDefined();
    expect(typeof body.quote_id).toBe('string');
    expect(body.floor).toBeUndefined();
  });

  it('returns 400 VALIDATION_ERROR when asset is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: {
        qty: '1000000000000000000',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// POST /v1/quotes — with floor (requires risk service)
// ---------------------------------------------------------------------------

describe('POST /v1/quotes with floor', () => {
  it.skipIf(!RISK_URL)('returns 200 with floor fields when risk service is running', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: {
        asset: 'ETH',
        qty: '1000000000000000000',
        account_id: '0s' + 'a'.repeat(40),
        floor: {
          bps: 500,
          duration_secs: 86400,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      quote_id: string;
      floor: {
        quote_id: string;
        floor_price_e6: string;
        fee_usdc: string;
        sleeve: string;
        sig: string;
        key_id: string;
        expires_at_ns: string;
        floor_bps: number;
        duration_secs: number;
      };
    };
    expect(body.quote_id).toBeDefined();
    expect(body.floor).toBeDefined();
    expect(body.floor.floor_price_e6).toBeDefined();
    expect(body.floor.sig).toBeDefined();
    expect(body.floor.floor_bps).toBe(500);
    expect(body.floor.duration_secs).toBe(86400);
  });

  it('returns 503 FLOOR_QUOTE_UNAVAILABLE when risk engine is unreachable', async () => {
    // The app is registered with http://localhost:19998 (guaranteed unreachable)
    // unless RISK_URL is set. Skip if RISK_URL is set (risk service is running).
    if (RISK_URL) return;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: {
        asset: 'ETH',
        qty: '1000000000000000000',
        account_id: '0s' + 'a'.repeat(40),
        floor: {
          bps: 500,
          duration_secs: 86400,
        },
      },
    });

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe('FLOOR_QUOTE_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------
// GET /v1/suggestions
// ---------------------------------------------------------------------------

describe('GET /v1/suggestions', () => {
  it('returns 200 with global defaults', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/suggestions',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      floor_bps: number;
      duration_secs: number;
    };
    expect(body.floor_bps).toBe(500);
    expect(body.duration_secs).toBe(2592000);
  });

  it('ignores unknown query params', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/suggestions?account_id=0s' + 'a'.repeat(40),
    });

    expect(response.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/actions
// ---------------------------------------------------------------------------

describe('POST /v1/actions', () => {
  it('returns 400 VALIDATION_ERROR when action is invalid', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      payload: {
        action: 'invalid_action',
        floor_id: 'floor-123',
        account_id: '0s' + 'a'.repeat(40),
        signature: 'abc123',
        credential_id: 'cred456',
        wallet_request: { foo: 'bar' },
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 VALIDATION_ERROR when account_id has wrong format', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      payload: {
        action: 'sell_to_floor',
        floor_id: 'floor-123',
        account_id: 'wrong-format',
        signature: 'abc123',
        credential_id: 'cred456',
        wallet_request: { foo: 'bar' },
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 202 with status_id for valid sell_to_floor action', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      payload: {
        action: 'sell_to_floor',
        floor_id: 'floor-123',
        account_id: '0s' + 'a'.repeat(40),
        signature: 'base64urlsig',
        credential_id: 'base64urlcredid',
        wallet_request: { receiver_id: 'floors.near', actions: [] },
      },
    });

    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.body) as { status_id: string };
    expect(body.status_id).toBeDefined();
    expect(typeof body.status_id).toBe('string');
  });

  it('returns 202 with status_id for valid close action', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/actions',
      payload: {
        action: 'close',
        floor_id: 'floor-456',
        account_id: '0s' + 'b'.repeat(40),
        signature: 'base64urlsig2',
        credential_id: 'base64urlcredid2',
        wallet_request: null,
      },
    });

    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.body) as { status_id: string };
    expect(body.status_id).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// POST /v1/sell
// ---------------------------------------------------------------------------

describe('POST /v1/sell', () => {
  it('returns 400 when account_id is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sell',
      payload: {
        floor_id: 'floor-123',
        signature: 'sig',
        credential_id: 'cred',
        wallet_request: {},
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 202 with status_id for valid sell body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sell',
      payload: {
        floor_id: 'floor-789',
        account_id: '0s' + 'c'.repeat(40),
        signature: 'base64urlsig3',
        credential_id: 'base64urlcredid3',
        wallet_request: { receiver_id: 'floors.near', actions: [] },
      },
    });

    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.body) as { status_id: string };
    expect(body.status_id).toBeDefined();
  });
});
