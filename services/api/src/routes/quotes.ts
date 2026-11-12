import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { FloorApiError } from '@floors/shared-server';
import type { FloorQuote } from '@floors/types';

const QuoteRequestSchema = z.object({
  asset: z.string().min(1),
  qty: z.string().min(1),
  floor_bps: z.number().int().min(1).max(10000),
  duration_secs: z.number().int().positive(),
});

function generateQuoteId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function registerQuoteRoutes(app: FastifyInstance): void {
  app.post('/v1/quotes', async (request: FastifyRequest, reply: FastifyReply) => {
    const bodyResult = QuoteRequestSchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        'Invalid quote request',
        false,
        400,
        { issues: bodyResult.error.issues },
      );
    }

    const { asset, qty, floor_bps, duration_secs } = bodyResult.data;

    const expiresAtNs = BigInt(Date.now() + duration_secs * 1000) * BigInt(1_000_000);

    // Stub: hardcoded quote for now (real pricing via risk service in S4)
    const quote: FloorQuote = {
      v: 1,
      id: generateQuoteId(),
      owner: 'pending.floors.near',
      asset,
      qty,
      floor_bps,
      duration_secs,
      floor_price_e6: '1000000', // $1.00 stub
      fee_usdc: '100',           // $0.01 stub fee
      sleeve: 'stub_sleeve',
      pyth_feed: '0x0000000000000000000000000000000000000000000000000000000000000000',
      expires_at_ns: expiresAtNs.toString(),
      key_id: 0,
    };

    // Stub signature (real Ed25519 signing in risk service S4)
    const sig = 'stub_sig_' + quote.id.slice(0, 16);

    request.log.info({ asset, quote_id: quote.id }, 'quote_generated');

    return reply.status(200).send({ quote, sig });
  });
}
