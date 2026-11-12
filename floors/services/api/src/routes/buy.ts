import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { FloorApiError } from '@floors/shared-server';

const BuyBodySchema = z.object({
  signed_intent: z.record(z.unknown()),
  quote_id: z.string().length(64),
});

const IdempotencyKeyHeader = z.string().uuid();

const RelayResponseSchema = z.object({
  tx_hash: z.string(),
  status: z.string(),
});

export function registerBuyRoutes(app: FastifyInstance, relayerUrl: string): void {
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

    const { signed_intent, quote_id } = bodyResult.data;

    // Generate request_id
    const request_id = crypto.randomUUID();

    request.log.info({ quote_id, request_id }, 'buy_intent_received — forwarding to relayer');

    // Forward to relayer service
    const relayPayload = {
      account_id: (signed_intent['credential_id'] as string | undefined) ?? 'alice.test.near',
      actions: [signed_intent],
      idempotency_key: ikResult.data,
    };

    let relayRes: Response;
    try {
      relayRes = await fetch(`${relayerUrl}/v1/relay`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(relayPayload),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      request.log.error({ err, event: 'relay_fetch_error' }, 'Failed to reach relayer');
      throw new FloorApiError('RELAYER_ERROR', `Relayer unreachable: ${msg}`, true, 502);
    }

    if (!relayRes.ok) {
      const body = await relayRes.text().catch(() => '');
      request.log.error({ status: relayRes.status, body, event: 'relay_error' }, 'Relayer returned error');
      throw new FloorApiError(
        'RELAYER_ERROR',
        `Relayer returned ${relayRes.status.toString()}`,
        false,
        502,
      );
    }

    const relayBody: unknown = await relayRes.json();
    const relayParsed = RelayResponseSchema.safeParse(relayBody);
    if (!relayParsed.success) {
      request.log.error({ relayBody, event: 'relay_bad_response' }, 'Relayer response shape unexpected');
      throw new FloorApiError('RELAYER_ERROR', 'Relayer response malformed', false, 502);
    }

    request.log.info(
      { quote_id, request_id, tx_hash: relayParsed.data.tx_hash, event: 'buy_relayed' },
      'Buy relayed successfully',
    );

    return reply.status(202).send({
      request_id,
      tx_hash: relayParsed.data.tx_hash,
      status: 'pending',
    });
  });
}
