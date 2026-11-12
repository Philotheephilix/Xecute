import { z } from 'zod';

export const ERROR_CODES = {
  QUOTE_EXPIRED: 'QUOTE_EXPIRED',
  QUOTE_USED: 'QUOTE_USED',
  QUOTE_INVALID: 'QUOTE_INVALID',
  QUOTE_NOT_FOUND: 'QUOTE_NOT_FOUND',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  ASSET_NOT_ELIGIBLE: 'ASSET_NOT_ELIGIBLE',
  FLOOR_NOT_FOUND: 'FLOOR_NOT_FOUND',
  FLOOR_ALREADY_CLOSED: 'FLOOR_ALREADY_CLOSED',
  FLOOR_NOT_EXPIRED: 'FLOOR_NOT_EXPIRED',
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
  PRICE_FEED_STALE: 'PRICE_FEED_STALE',
  PRICE_FEED_NOT_FOUND: 'PRICE_FEED_NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.unknown()).optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
