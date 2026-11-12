import { z } from 'zod';
import { FloorQuoteSchema } from './quote.js';

export const BuyRequestSchema = z.object({
  asset: z.string(),
  qty: z.string(),                 // decimal string
  floor_bps: z.number().int().min(1).max(10000),
  duration_secs: z.number().int().positive(),
  idempotency_key: z.string(),
});
export type BuyRequest = z.infer<typeof BuyRequestSchema>;

export const BuyResponseSchema = z.object({
  floor_id: z.string(),
  tx_hash: z.string(),
  settled_at_ns: z.string(),
});
export type BuyResponse = z.infer<typeof BuyResponseSchema>;

export const AccountSchema = z.object({
  account_id: z.string(),
  public_key: z.string(),
  created_at_ns: z.string(),
});
export type Account = z.infer<typeof AccountSchema>;

export const QuoteResponseSchema = z.object({
  quote: FloorQuoteSchema,
  sig: z.string(),
});
export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;
