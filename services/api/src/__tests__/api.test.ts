import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, createLogger } from '@floors/shared-server';
import type { BaseConfig } from '@floors/shared-server';
import { registerQuoteRoutes } from '../routes/quotes.js';
import { registerBuyRoutes } from '../routes/buy.js';

const TEST_CONFIG: BaseConfig = {
  NODE_ENV: 'local',
  PORT: 3099,
  LOG_LEVEL: 'error',
  SERVICE_NAME: 'api-test',
  SERVICE_VERSION: '0.0.1',
  DATABASE_URL: 'postgres://floors:floors@localhost:5432/floors_test',
};

let app: FastifyInstance;

beforeAll(async () => {
  const logger = createLogger({
    service: TEST_CONFIG.SERVICE_NAME,
    version: TEST_CONFIG.SERVICE_VERSION,
    level: TEST_CONFIG.LOG_LEVEL,
  });

  app = await createApp(TEST_CONFIG, logger);
  registerQuoteRoutes(app);
  registerBuyRoutes(app);
  await app.ready();
});

afterAll(async () => {
  if (app !== undefined) {
    await app.close();
  }
});

describe('GET /health', () => {
  it('returns 200 with ok status', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { status: string; service: string; version: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('api-test');
    expect(body.version).toBe('0.0.1');
  });
});

describe('GET /ready', () => {
  it('returns 200 with ready status', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/ready',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { status: string };
    expect(body.status).toBe('ready');
  });
});

describe('POST /v1/buy', () => {
  it('returns 400 VALIDATION_ERROR when Idempotency-Key header is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/buy',
      payload: {
        signed_intent: { foo: 'bar' },
        quote_id: 'a'.repeat(64),
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { error: { code: string; retryable: boolean } };
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.retryable).toBe(false);
  });

  it('returns 400 when Idempotency-Key is not a valid UUID', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/buy',
      headers: { 'idempotency-key': 'not-a-uuid' },
      payload: {
        signed_intent: { foo: 'bar' },
        quote_id: 'a'.repeat(64),
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 202 with request_id and pending status when valid', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/buy',
      headers: { 'idempotency-key': '00000000-0000-0000-0000-000000000001' },
      payload: {
        signed_intent: { action: 'buy', asset: 'eth.near' },
        quote_id: 'a'.repeat(64),
      },
    });

    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.body) as { request_id: string; status: string };
    expect(body.status).toBe('pending');
    expect(typeof body.request_id).toBe('string');
  });
});

describe('POST /v1/quotes', () => {
  it('returns 200 with a quote when request is valid', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: {
        asset: 'eth.near',
        qty: '1000000000000000000',
        floor_bps: 500,
        duration_secs: 3600,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      quote: { v: number; asset: string; id: string };
      sig: string;
    };
    expect(body.quote.v).toBe(1);
    expect(body.quote.asset).toBe('eth.near');
    expect(body.quote.id).toHaveLength(64);
    expect(typeof body.sig).toBe('string');
  });

  it('returns 400 with VALIDATION_ERROR when floor_bps is too high', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: {
        asset: 'eth.near',
        qty: '100',
        floor_bps: 99999,
        duration_secs: 3600,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 with VALIDATION_ERROR when asset is empty', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: {
        asset: '',
        qty: '100',
        floor_bps: 500,
        duration_secs: 3600,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});
