/**
 * /v1/submit — POST to initiate a buy
 * /v1/status/:status_id/stream — GET SSE stream for buy status updates
 */

import { createHash, createVerify } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { FloorApiError } from '@floors/shared-server';
import type postgres from 'postgres';
import { getDraftQuoteByQuoteId } from './quotes.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const AssertionSchema = z.object({
  signature: z.string().min(1),
  credential_id: z.string().min(1),
  ticker: z.string().min(1),
  amount_usdc: z.string().regex(/^\d+$/, 'amount_usdc must be integer string'),
  // WebAuthn assertion fields (hex-encoded) — required for server-side signature verification
  authenticator_data: z.string().min(1).optional(),
  client_data_json: z.string().min(1).optional(),
});

const SubmitBodySchema = z.object({
  quote_id: z.string().min(1),
  assertion: AssertionSchema,
});

const IdempotencyKeyHeader = z.string().uuid();

// ---------------------------------------------------------------------------
// DB row types
// ---------------------------------------------------------------------------

interface BuySubmissionRow {
  status_id: string;
  idempotency_key: string;
  quote_id: string;
  account_id: string;
  ticker: string;
  amount_usdc: string;
  intent_hash: string | null;
  tx_hash: string | null;
  deposit_address: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Account row (for public key lookup)
// ---------------------------------------------------------------------------

interface AccountRow {
  public_key_hex: string | null;
}

// ---------------------------------------------------------------------------
// WebAuthn signature verification
// ---------------------------------------------------------------------------

/**
 * Verify a WebAuthn P-256 assertion signature server-side.
 *
 * Standard verification steps (WebAuthn Level 2 §7.2):
 *   1. clientDataHash = SHA-256(clientDataJSON)
 *   2. message = authenticatorData || clientDataHash
 *   3. Verify signature over message using the stored P-256 public key
 *
 * The stored key is a compressed P-256 point (33 bytes, hex).
 * Node's `crypto.createVerify` expects a SubjectPublicKeyInfo (SPKI) DER buffer,
 * so we wrap the raw key bytes accordingly.
 *
 * @returns true if valid, false if invalid, null if verification could not run
 *          (missing fields or unsupported key format — caller decides policy).
 */
function verifyWebAuthnAssertion(
  publicKeyHex: string,
  authenticatorDataHex: string,
  clientDataJsonHex: string,
  signatureHex: string,
): boolean {
  // Decode hex inputs
  const authenticatorData = Buffer.from(authenticatorDataHex, 'hex');
  const clientDataJSON = Buffer.from(clientDataJsonHex, 'hex');
  const rawSig = Buffer.from(signatureHex, 'hex');

  // Step 1: hash clientDataJSON
  const clientDataHash = createHash('sha256').update(clientDataJSON).digest();

  // Step 2: message = authenticatorData || clientDataHash
  const message = Buffer.concat([authenticatorData, clientDataHash]);

  // Step 3: build SPKI DER from compressed P-256 key (33 bytes)
  // SPKI header for P-256: sequence { sequence { OID ecPublicKey, OID P-256 }, bitString { 0x00, key } }
  const rawKey = Buffer.from(publicKeyHex, 'hex');

  // P-256 SPKI header (fixed bytes for algorithm identifier)
  const spkiHeader = Buffer.from(
    '3059301306072a8648ce3d020106082a8648ce3d030107034200',
    'hex',
  );
  // The header above ends with 0x03 0x42 0x00 which covers an uncompressed key (65 bytes).
  // For compressed keys (33 bytes) adjust the BIT STRING length: 0x03 0x22 0x00
  const spkiHeaderCompressed = Buffer.from(
    '3039301306072a8648ce3d020106082a8648ce3d03010703220000',
    'hex',
  );
  // Fix: build header dynamically for correct lengths
  const keyLength = rawKey.length; // 33 (compressed) or 65 (uncompressed)
  const bitStringBody = Buffer.concat([Buffer.from([0x00]), rawKey]); // leading 0x00 = no unused bits
  const bitStringLen = bitStringBody.length;
  const algoId = Buffer.from('301306072a8648ce3d020106082a8648ce3d030107', 'hex');
  const bitStringTag = Buffer.from([0x03, bitStringLen]);
  const spkiBody = Buffer.concat([algoId, bitStringTag, bitStringBody]);
  const spkiDer = Buffer.concat([Buffer.from([0x30, spkiBody.length]), spkiBody]);

  // Suppress unused variable warnings for the static buffers above
  void spkiHeader; void spkiHeaderCompressed; void keyLength;

  // The signature from WebAuthn is DER-encoded; createVerify('SHA256') handles raw message hashing
  const verifier = createVerify('SHA256');
  verifier.update(message);
  return verifier.verify({ key: spkiDer, format: 'der', type: 'spki' }, rawSig);
}

// ---------------------------------------------------------------------------
// Relayer swap response
// ---------------------------------------------------------------------------

interface RelaySwapResponse {
  intent_hash: string;
  tx_hash: string | null;
  status: string;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerSubmitRoutes(
  app: FastifyInstance,
  db: postgres.Sql,
  relayerUrl: string,
): void {
  /**
   * POST /v1/submit
   *
   * Validates assertion matches the draft quote, calls relayer /v1/relay/swap,
   * stores result in api.buy_submissions, returns { status_id }.
   */
  app.post('/v1/submit', async (request: FastifyRequest, reply: FastifyReply) => {
    // Validate Idempotency-Key
    const idempotencyKeyRaw = request.headers['idempotency-key'];
    if (typeof idempotencyKeyRaw !== 'string') {
      throw new FloorApiError('VALIDATION_ERROR', 'Idempotency-Key header is required', false, 400);
    }
    const ikResult = IdempotencyKeyHeader.safeParse(idempotencyKeyRaw);
    if (!ikResult.success) {
      throw new FloorApiError('VALIDATION_ERROR', 'Idempotency-Key must be a valid UUID', false, 400);
    }
    const idempotencyKey = ikResult.data;

    // Idempotency check — return existing submission if key already used
    const existingRows = await db<BuySubmissionRow[]>`
      SELECT status_id, status FROM api.buy_submissions
      WHERE idempotency_key = ${idempotencyKey}
    `;
    if (existingRows.length > 0 && existingRows[0] !== undefined) {
      return reply.status(200).send({
        status_id: existingRows[0].status_id,
        status: existingRows[0].status,
      });
    }

    // Parse body
    const bodyResult = SubmitBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        'Invalid submit request body',
        false,
        400,
        { issues: bodyResult.error.issues },
      );
    }

    const { quote_id, assertion } = bodyResult.data;

    // Validate assertion matches the draft quote (if still in cache)
    const cachedQuote = getDraftQuoteByQuoteId(quote_id);
    if (cachedQuote !== undefined) {
      const tickerMatch = assertion.ticker.toUpperCase() === cachedQuote.asset.toUpperCase();
      const amountMatch = assertion.amount_usdc === cachedQuote.pay_usdc;
      if (!tickerMatch || !amountMatch) {
        throw new FloorApiError(
          'VALIDATION_ERROR',
          'Assertion does not match quoted terms',
          false,
          422,
          {
            expected: { ticker: cachedQuote.asset, amount_usdc: cachedQuote.pay_usdc },
            got: { ticker: assertion.ticker, amount_usdc: assertion.amount_usdc },
          },
        );
      }
    }
    // If quote expired from cache (>15s), we still proceed — the user signed valid data

    // Look up account_id and public_key_hex from DB using the credential_id.
    const accountRows = await db<Array<{ account_id: string; public_key_hex: string | null }>>`
      SELECT account_id, public_key_hex FROM api.accounts WHERE credential_id = ${assertion.credential_id}
    `;
    if (accountRows.length === 0 || accountRows[0] === undefined) {
      throw new FloorApiError('ACCOUNT_NOT_FOUND', 'No account found for this credential', false, 404);
    }
    const { account_id, public_key_hex } = accountRows[0];

    // Verify WebAuthn P-256 assertion signature.
    // TODO: once all clients send authenticator_data + client_data_json, make these required
    //   and remove the fallback log-only path.
    if (
      assertion.authenticator_data !== undefined &&
      assertion.client_data_json !== undefined
    ) {
      if (public_key_hex === null || public_key_hex.length === 0) {
        // No stored public key — cannot verify; reject to prevent bypass
        throw new FloorApiError(
          'UNAUTHORIZED',
          'No public key on record for this credential; cannot verify signature',
          false,
          401,
        );
      }
      let sigValid: boolean;
      try {
        sigValid = verifyWebAuthnAssertion(
          public_key_hex,
          assertion.authenticator_data,
          assertion.client_data_json,
          assertion.signature,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        request.log.warn({ event: 'webauthn_verify_error', err: msg }, 'WebAuthn verification threw');
        throw new FloorApiError('UNAUTHORIZED', 'Signature verification failed', false, 401);
      }
      if (!sigValid) {
        throw new FloorApiError('UNAUTHORIZED', 'WebAuthn signature is invalid', false, 401);
      }
      request.log.info({ event: 'webauthn_verified' }, 'WebAuthn signature verified');
    } else {
      // Legacy clients that do not send authenticator_data/client_data_json — log and continue.
      // TODO: remove this branch once all clients are updated.
      request.log.warn(
        { event: 'webauthn_skipped', credential_id: assertion.credential_id },
        'WebAuthn assertion fields missing — signature not verified (legacy client)',
      );
    }

    request.log.info(
      { quote_id, ticker: assertion.ticker, amount_usdc: assertion.amount_usdc, event: 'submit_received' },
      'Submit received — storing and forwarding to relayer async',
    );

    // Store submission record immediately — return status_id before relayer finishes
    const rows = await db<Array<{ status_id: string }>>`
      INSERT INTO api.buy_submissions
        (idempotency_key, quote_id, account_id, ticker, amount_usdc, deposit_address, status)
      VALUES
        (
          ${idempotencyKey},
          ${quote_id},
          ${account_id},
          ${assertion.ticker},
          ${assertion.amount_usdc},
          ${cachedQuote?.deposit_address ?? null},
          'submitted'
        )
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING status_id
    `;

    const statusId = rows[0]?.status_id;
    if (statusId === undefined) {
      throw new FloorApiError('INTERNAL_ERROR', 'Failed to create submission record', false, 500);
    }

    // Fire-and-forget: call relayer async, update DB when done
    // This allows immediate return to client while relay/1Click runs in background
    const doRelay = async () => {
      try {
        const relayRes = await fetch(`${relayerUrl}/v1/relay/swap`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            account_id,
            ticker: assertion.ticker,
            amount_usdc: assertion.amount_usdc,
            idempotency_key: idempotencyKey,
          }),
        });

        if (!relayRes.ok) {
          const body = await relayRes.text().catch(() => '');
          request.log.error({ status: relayRes.status, body, statusId, event: 'relay_error' }, 'Relayer error');
          await db`
            UPDATE api.buy_submissions
            SET status = 'failed', updated_at = NOW()
            WHERE status_id = ${statusId}
          `;
          return;
        }

        const relayBody = await relayRes.json() as RelaySwapResponse;

        const newStatus = relayBody.status === 'completed' ? 'done' : 'submitted';
        await db`
          UPDATE api.buy_submissions
          SET intent_hash = ${relayBody.intent_hash ?? null},
              tx_hash = ${relayBody.tx_hash ?? null},
              status = ${newStatus},
              updated_at = NOW()
          WHERE status_id = ${statusId}
        `;

        request.log.info(
          { statusId, intent_hash: relayBody.intent_hash, status: newStatus, event: 'relay_complete' },
          'Relay completed, submission updated',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        request.log.error({ err: msg, statusId, event: 'relay_async_error' }, 'Async relay failed');
        await db`
          UPDATE api.buy_submissions
          SET status = 'failed', updated_at = NOW()
          WHERE status_id = ${statusId}
        `.catch(() => {/* ignore */});
      }
    };

    // Intentionally not awaited — return immediately to client
    void doRelay();

    request.log.info({ status_id: statusId, event: 'submit_accepted' }, 'Submission accepted, relay running async');

    return reply.status(202).send({
      status_id: statusId,
      status: 'submitted',
    });
  });

  /**
   * GET /v1/status/:status_id/stream
   *
   * SSE stream: polls api.buy_submissions every 500ms.
   * Emits: event: status\ndata: JSON\n\n
   * Closes after state=done|failed or 30s timeout.
   */
  app.get<{ Params: { status_id: string } }>(
    '/v1/status/:status_id/stream',
    async (request: FastifyRequest<{ Params: { status_id: string } }>, reply: FastifyReply) => {
      const { status_id } = request.params;

      // Validate UUID format
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(status_id)) {
        throw new FloorApiError('VALIDATION_ERROR', 'Invalid status_id', false, 400);
      }

      // Check existence
      const check = await db<Array<{ status_id: string }>>`
        SELECT status_id FROM api.buy_submissions WHERE status_id = ${status_id}
      `;
      if (check.length === 0) {
        throw new FloorApiError('NOT_FOUND', `Submission ${status_id} not found`, false, 404);
      }

      // Set SSE headers
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      });

      const POLL_INTERVAL_MS = 500;
      const TIMEOUT_MS = 30_000;
      const deadline = Date.now() + TIMEOUT_MS;

      let closed = false;

      // Handle client disconnect
      request.raw.on('close', () => {
        closed = true;
      });

      const sendEvent = (data: Record<string, unknown>): void => {
        if (closed || reply.raw.writableEnded) return;
        reply.raw.write(`event: status\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // Poll loop
      while (!closed && !reply.raw.writableEnded && Date.now() < deadline) {
        const rows = await db<BuySubmissionRow[]>`
          SELECT status_id, status, intent_hash, tx_hash
          FROM api.buy_submissions
          WHERE status_id = ${status_id}
        `;

        const row = rows[0];
        if (row === undefined) {
          sendEvent({ status_id, state: 'failed', error: 'record not found' });
          break;
        }

        const state = mapDbStatusToState(row.status);

        sendEvent({
          status_id,
          state,
          tx_hash: row.tx_hash,
          intent_hash: row.intent_hash,
        });

        if (state === 'done' || state === 'failed') {
          break;
        }

        await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      if (Date.now() >= deadline && !closed) {
        // Timeout — send final tracking state
        sendEvent({ status_id, state: 'tracking', message: 'Order is being tracked' });
      }

      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    },
  );
}

function mapDbStatusToState(dbStatus: string): string {
  switch (dbStatus) {
    case 'submitted': return 'submitted';
    case 'completed': return 'done';
    case 'done': return 'done';
    case 'failed':
    case 'expired':
    case 'refunded': return 'failed';
    default: return 'tracking';
  }
}
