import { z } from 'zod';

export const FloorQuoteSchema = z.object({
  v: z.literal(1),
  id: z.string().length(64),       // 32 bytes hex
  owner: z.string(),
  asset: z.string(),
  qty: z.string(),                 // decimal string
  floor_bps: z.number().int().min(1).max(10000),
  duration_secs: z.number().int().positive(),
  floor_price_e6: z.string(),
  fee_usdc: z.string(),
  sleeve: z.string(),
  pyth_feed: z.string(),
  expires_at_ns: z.string(),
  key_id: z.number().int().min(0).max(1),
});

export type FloorQuote = z.infer<typeof FloorQuoteSchema>;
