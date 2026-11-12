import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';
import { FloorQuoteSchema } from '@floors/types';

// Request schemas
const CreateAccountBodySchema = z.object({
  public_key: z.string().min(1),
  credential_id: z.string().min(1),
});

const QuoteRequestSchema = z.object({
  asset: z.string().min(1),
  qty: z.string().min(1),
  floor_bps: z.number().int().min(1).max(10000),
  duration_secs: z.number().int().positive(),
});

const BuyBodySchema = z.object({
  signed_intent: z.record(z.unknown()),
  quote_id: z.string().length(64),
});

const PositionSchema = z.object({
  floor_id: z.string(),
  account_id: z.string(),
  asset: z.string(),
  qty: z.string(),
  floor_price_e6: z.string(),
  status: z.string(),
  opened_at: z.string().datetime(),
  expires_at: z.string().datetime(),
});

const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.unknown()).optional(),
  }),
});

const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Floors API',
    version: '0.0.1',
    description: 'Floors on-chain floor price protection API',
  },
  servers: [{ url: 'http://localhost:3001', description: 'Local' }],
  paths: {
    '/v1/accounts': {
      post: {
        summary: 'Create smart account',
        operationId: 'createAccount',
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: zodToJsonSchema(CreateAccountBodySchema),
            },
          },
        },
        responses: {
          '201': {
            description: 'Account created',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { account_id: { type: 'string' }, created: { type: 'boolean' } } },
              },
            },
          },
          '400': { description: 'Validation error', content: { 'application/json': { schema: zodToJsonSchema(ErrorEnvelopeSchema) } } },
        },
      },
    },
    '/v1/quotes': {
      post: {
        summary: 'Get a floor quote',
        operationId: 'getQuote',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: zodToJsonSchema(QuoteRequestSchema) } },
        },
        responses: {
          '200': {
            description: 'Quote generated',
            content: {
              'application/json': {
                schema: zodToJsonSchema(z.object({ quote: FloorQuoteSchema, sig: z.string() })),
              },
            },
          },
          '400': { description: 'Validation error', content: { 'application/json': { schema: zodToJsonSchema(ErrorEnvelopeSchema) } } },
        },
      },
    },
    '/v1/buy': {
      post: {
        summary: 'Submit a buy intent',
        operationId: 'submitBuy',
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: zodToJsonSchema(BuyBodySchema) } },
        },
        responses: {
          '202': {
            description: 'Intent accepted',
            content: {
              'application/json': {
                schema: zodToJsonSchema(z.object({ request_id: z.string().uuid(), status: z.literal('pending') })),
              },
            },
          },
          '400': { description: 'Validation error', content: { 'application/json': { schema: zodToJsonSchema(ErrorEnvelopeSchema) } } },
        },
      },
    },
    '/v1/accounts/{account_id}/positions': {
      get: {
        summary: 'List open floor positions',
        operationId: 'listPositions',
        parameters: [
          { name: 'account_id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 20, maximum: 100 } },
        ],
        responses: {
          '200': {
            description: 'Positions list',
            content: {
              'application/json': {
                schema: zodToJsonSchema(z.object({ positions: z.array(PositionSchema), cursor: z.string().optional() })),
              },
            },
          },
        },
      },
    },
    '/v1/accounts/{account_id}': {
      get: {
        summary: 'Get account info',
        operationId: 'getAccount',
        parameters: [
          { name: 'account_id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Account info',
            content: {
              'application/json': {
                schema: zodToJsonSchema(z.object({ account_id: z.string(), public_key: z.string(), created_at: z.string().datetime() })),
              },
            },
          },
          '404': { description: 'Account not found', content: { 'application/json': { schema: zodToJsonSchema(ErrorEnvelopeSchema) } } },
        },
      },
    },
  },
};

console.log(JSON.stringify(openapi, null, 2));
