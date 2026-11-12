import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FloorApiError } from '@floors/shared-server';
import type pino from 'pino';

const RelayBodySchema = z.object({
  account_id: z.string().min(1),
  actions: z.array(z.record(z.unknown())).min(1),
  idempotency_key: z.string().uuid(),
});

// In-memory tx store for stub (S6 will use DB)
const txStore = new Map<string, { status: 'pending' | 'executed'; tx_hash: string }>();

export function registerRelayRoutes(app: FastifyInstance, logger: pino.Logger): void {
  app.post('/v1/relay', async (request, reply) => {
    const bodyResult = RelayBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        'Invalid relay request',
        false,
        400,
        { issues: bodyResult.error.issues },
      );
    }

    const { account_id, actions, idempotency_key } = bodyResult.data;

    // Check idempotency
    const existing = txStore.get(idempotency_key);
    if (existing !== undefined) {
      return reply.status(200).send(existing);
    }

    // Stub simulation — in S6 we'll call NEAR RPC dry_run
    logger.info(
      { account_id, action_count: actions.length, event: 'relay_simulate' },
      'Simulating transaction (stub)',
    );

    // Generate fake tx hash
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const tx_hash = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');

    const result = { tx_hash, status: 'pending' as const };
    txStore.set(idempotency_key, result);

    logger.info({ tx_hash, account_id, event: 'relay_submitted' }, 'Transaction submitted (stub)');

    return reply.status(202).send(result);
  });

  app.get('/v1/relay/:tx_hash', async (request, reply) => {
    const { tx_hash } = request.params as { tx_hash: string };

    // Find in store
    for (const [, value] of txStore) {
      if (value.tx_hash === tx_hash) {
        return reply.status(200).send(value);
      }
    }

    throw new FloorApiError('NOT_FOUND', `Transaction ${tx_hash} not found`, false, 404);
  });
}
