/**
 * POST /v1/actions  — floor action (sell_to_floor | close)
 * POST /v1/sell     — thin alias for sell_to_floor
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { FloorApiError } from '@floors/shared-server';
import type postgres from 'postgres';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ActionsBodySchema = z.object({
  action: z.enum(['sell_to_floor', 'close']),
  floor_id: z.string().min(1),
  account_id: z.string().regex(/^0s[0-9a-f]{40}$/, 'account_id must match /^0s[0-9a-f]{40}$/'),
  // WebAuthn assertion
  signature: z.string().min(1),
  credential_id: z.string().min(1),
  // Pre-built wallet_request from client
  wallet_request: z.unknown(),
});

const SellBodySchema = z.object({
  floor_id: z.string().min(1),
  account_id: z.string().regex(/^0s[0-9a-f]{40}$/, 'account_id must match /^0s[0-9a-f]{40}$/'),
  signature: z.string().min(1),
  credential_id: z.string().min(1),
  wallet_request: z.unknown(),
});

// ---------------------------------------------------------------------------
// DB row type
// ---------------------------------------------------------------------------

interface BuySubmissionRow {
  status_id: string;
}

// ---------------------------------------------------------------------------
// Core action handler
// ---------------------------------------------------------------------------

async function handleFloorAction(
  action: 'sell_to_floor' | 'close',
  floor_id: string,
  account_id: string,
  signature: string,
  credential_id: string,
  wallet_request: unknown,
  db: postgres.Sql,
  relayerUrl: string,
  log: import('fastify').FastifyBaseLogger,
): Promise<{ statusId: string; nonce: string; valid_until_ns: string }> {
  // Insert pending submission record
  const rows = await db<BuySubmissionRow[]>`
    INSERT INTO api.buy_submissions
      (idempotency_key, quote_id, account_id, ticker, amount_usdc, status)
    VALUES
      (
        ${crypto.randomUUID()},
        ${floor_id},
        ${account_id},
        ${'FLOOR_ACTION'},
        ${'0'},
        'pending'
      )
    RETURNING status_id
  `;

  const statusId = rows[0]?.status_id;
  if (statusId === undefined) {
    throw new FloorApiError('INTERNAL_ERROR', 'Failed to create action record', false, 500);
  }

  // Generate nonce (digits-only, matches relayer /^\d+$/ requirement) and valid_until_ns
  // Use a combination of timestamp-ns + 6 random decimal digits for uniqueness
  const randomSuffix = Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0');
  const nonce = (BigInt(Date.now()) * 1_000_000n).toString() + randomSuffix;
  const valid_until_ns = (BigInt(Date.now() + 300_000) * 1_000_000n).toString();

  // Fire-and-forget: call relayer
  const doRelay = async () => {
    try {
      const relayRes = await fetch(`${relayerUrl}/v1/relay/floor-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          floor_id,
          action,
          account_id,
          nonce,
          valid_until_ns,
          assertion: {
            signature,
            credential_id,
            wallet_request,
          },
        }),
      });

      if (!relayRes.ok) {
        const body = await relayRes.text().catch(() => '');
        log.error({ status: relayRes.status, body, statusId, event: 'floor_action_relay_error' }, 'Floor action relayer error');
        await db`
          UPDATE api.buy_submissions
          SET status = 'failed', updated_at = NOW()
          WHERE status_id = ${statusId}
        `;
        return;
      }

      await db`
        UPDATE api.buy_submissions
        SET status = 'submitted', updated_at = NOW()
        WHERE status_id = ${statusId}
      `;

      log.info({ statusId, floor_id, action, event: 'floor_action_relayed' }, 'Floor action relayed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, statusId, event: 'floor_action_relay_async_error' }, 'Async floor action relay failed');
      await db`
        UPDATE api.buy_submissions
        SET status = 'failed', updated_at = NOW()
        WHERE status_id = ${statusId}
      `.catch(() => {/* ignore */});
    }
  };

  // Intentionally not awaited
  void doRelay();

  return { statusId, nonce, valid_until_ns };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerActionsRoutes(
  app: FastifyInstance,
  db: postgres.Sql,
  relayerUrl: string,
): void {
  /**
   * POST /v1/actions
   *
   * Initiates a floor action (sell_to_floor or close).
   * Returns { status_id } immediately; relay happens async.
   */
  app.post('/v1/actions', async (request: FastifyRequest, reply: FastifyReply) => {
    const bodyResult = ActionsBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        'Invalid actions request body',
        false,
        400,
        { issues: bodyResult.error.issues },
      );
    }

    const { action, floor_id, account_id, signature, credential_id, wallet_request } = bodyResult.data;

    request.log.info({ floor_id, action, account_id, event: 'floor_action_received' }, 'Floor action received');

    const { statusId } = await handleFloorAction(
      action,
      floor_id,
      account_id,
      signature,
      credential_id,
      wallet_request,
      db,
      relayerUrl,
      request.log,
    );

    return reply.status(202).send({ status_id: statusId });
  });

  /**
   * POST /v1/sell
   *
   * Thin wrapper over /v1/actions with action='sell_to_floor'.
   */
  app.post('/v1/sell', async (request: FastifyRequest, reply: FastifyReply) => {
    const bodyResult = SellBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        'Invalid sell request body',
        false,
        400,
        { issues: bodyResult.error.issues },
      );
    }

    const { floor_id, account_id, signature, credential_id, wallet_request } = bodyResult.data;

    request.log.info({ floor_id, account_id, event: 'sell_received' }, 'Sell (floor action) received');

    const { statusId } = await handleFloorAction(
      'sell_to_floor',
      floor_id,
      account_id,
      signature,
      credential_id,
      wallet_request,
      db,
      relayerUrl,
      request.log,
    );

    return reply.status(202).send({ status_id: statusId });
  });
}
