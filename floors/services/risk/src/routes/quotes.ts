import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FloorApiError } from '@floors/shared-server';
import type { FloorQuote } from '@floors/types';

const InternalQuoteRequestSchema = z.object({
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

// Dev Ed25519 stub key (real key management in S4)
const DEV_SIGNING_KEY = 'dev_stub_ed25519_key_for_local_only';

export function registerRiskQuoteRoutes(app: FastifyInstance): void {
  app.post('/v1/quotes', async (request, reply) => {
    const bodyResult = InternalQuoteRequestSchema.safeParse(request.body);
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
    const quoteId = generateQuoteId();

    const quote: FloorQuote = {
      v: 1,
      id: quoteId,
      owner: 'pending.floors.near',
      asset,
      qty,
      floor_bps,
      duration_secs,
      floor_price_e6: '1000000', // $1.00 stub — real pricing via Pyth in S4
      fee_usdc: '100',
      sleeve: 'stub_sleeve',
      pyth_feed: '0x0000000000000000000000000000000000000000000000000000000000000000',
      expires_at_ns: expiresAtNs.toString(),
      key_id: 0,
    };

    // Stub Ed25519 signature — real signing with local dev key in S4
    const sigPayload = JSON.stringify(quote);
    const encoder = new TextEncoder();
    const data = encoder.encode(DEV_SIGNING_KEY + sigPayload);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const sig = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    request.log.info({ asset, quote_id: quote.id, event: 'risk_quote_generated' }, 'Quote generated');

    return reply.status(200).send({ quote, sig });
  });
}
