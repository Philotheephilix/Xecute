import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { FloorApiError } from '@floors/shared-server';

const BuyBodySchema = z.object({
  signed_intent: z.record(z.unknown()),
  quote_id: z.string().length(64),
});

const IdempotencyKeyHeader = z.string().uuid();

export function registerBuyRoutes(app: FastifyInstance): void {
  app.post('/v1/buy', async (request: FastifyRequest, reply: FastifyReply) => {
    // Validate Idempotency-Key
    const idempotencyKeyRaw = request.headers['idempotency-key'];
    if (typeof idempotencyKeyRaw !== 'string') {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        'Idempotency-Key header is required',
        false,
        400,
      );
    }

    const ikResult = IdempotencyKeyHeader.safeParse(idempotencyKeyRaw);
    if (!ikResult.success) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        'Idempotency-Key must be a valid UUID',
        false,
        400,
      );
    }

    const bodyResult = BuyBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        'Invalid buy request body',
        false,
        400,
        { issues: bodyResult.error.issues },
      );
    }

    const { quote_id } = bodyResult.data;

    // Generate request_id
    const request_id = crypto.randomUUID();

    // Stub: relay to relayer service in S5
    request.log.info({ quote_id, request_id }, 'buy_intent_received');

    return reply.status(202).send({
      request_id,
      status: 'pending',
    });
  });
}
