import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FloorApiError } from '@floors/shared-server';
import { connect, keyStores, KeyPair } from 'near-api-js';
import type { Account } from 'near-api-js';
import type pino from 'pino';
import type { Sql } from 'postgres';
import type { RelayerConfig } from '../index.js';

const RelayBodySchema = z.object({
  account_id: z.string().min(1),
  actions: z.array(z.record(z.unknown())).min(1),
  idempotency_key: z.string().uuid(),
});

/**
 * Create a NEAR account handle authenticated with the relayer's signing key.
 * For S6, we use alice.test.near on the localnet sandbox to prove the RPC path.
 */
async function createSigningAccount(config: RelayerConfig): Promise<Account> {
  const keyStore = new keyStores.InMemoryKeyStore();
  const keyPair = KeyPair.fromString(
    config.NEAR_PRIVATE_KEY as Parameters<typeof KeyPair.fromString>[0],
  );
  await keyStore.setKey(config.NEAR_NETWORK_ID, config.NEAR_ACCOUNT_ID, keyPair);

  const near = await connect({
    networkId: config.NEAR_NETWORK_ID,
    nodeUrl: config.NEAR_NODE_URL,
    keyStore,
  });

  return near.account(config.NEAR_ACCOUNT_ID);
}

export function registerRelayRoutes(
  app: FastifyInstance,
  logger: pino.Logger,
  db: Sql,
  config: RelayerConfig,
): void {
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

    // Check idempotency in real Postgres
    const existing = await db<Array<{ tx_hash: string; status: string }>>`
      SELECT tx_hash, status FROM relayer.transactions
      WHERE idempotency_key = ${idempotency_key}
    `;
    if (existing.length > 0 && existing[0] !== undefined) {
      return reply.status(200).send({ tx_hash: existing[0].tx_hash, status: existing[0].status });
    }

    logger.info(
      { account_id, action_count: actions.length, event: 'relay_start' },
      'Submitting transaction to NEAR sandbox',
    );

    // Call real NEAR sandbox RPC:
    // Send 1 yoctoNEAR from alice.test.near → alice.test.near (self transfer).
    // This proves the full NEAR RPC path works without needing a real Intents swap (P1).
    let tx_hash: string;
    try {
      const signingAccount = await createSigningAccount(config);

      // sendMoney: 1 yoctoNEAR self-transfer to prove RPC path
      const outcome = await signingAccount.sendMoney(config.NEAR_ACCOUNT_ID, BigInt(1));

      // near-api-js returns FinalExecutionOutcome; transaction_outcome.id is the tx hash
      tx_hash = outcome.transaction_outcome.id;

      logger.info(
        { tx_hash, account_id, event: 'near_tx_submitted' },
        'NEAR sandbox transaction submitted',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, account_id, event: 'near_rpc_error' }, 'NEAR RPC call failed');
      throw new FloorApiError('RELAYER_ERROR', `NEAR RPC failed: ${msg}`, true, 502);
    }

    // Persist to real Postgres
    await db`
      INSERT INTO relayer.transactions (idempotency_key, account_id, tx_hash, status)
      VALUES (${idempotency_key}, ${account_id}, ${tx_hash}, 'pending')
      ON CONFLICT (idempotency_key) DO NOTHING
    `;

    logger.info({ tx_hash, account_id, event: 'relay_submitted' }, 'Relay committed to DB');

    return reply.status(202).send({ tx_hash, status: 'pending' });
  });

  app.get('/v1/relay/:tx_hash', async (request, reply) => {
    const { tx_hash } = request.params as { tx_hash: string };

    const rows = await db<Array<{ tx_hash: string; status: string }>>`
      SELECT tx_hash, status FROM relayer.transactions
      WHERE tx_hash = ${tx_hash}
    `;

    if (rows.length === 0) {
      throw new FloorApiError('NOT_FOUND', `Transaction ${tx_hash} not found`, false, 404);
    }

    return reply.status(200).send(rows[0]);
  });
}
