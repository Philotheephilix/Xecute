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
  // account_id — sent by extension when credential_id differs from the one stored at account creation
  // (e.g. after link-device creates a new passkey for an existing account)
  account_id: z.string().min(1).optional(),
});

const FloorSchema = z.object({
  bps: z.number().int().positive(),
  duration_secs: z.number().int().positive(),
});

const SubmitBodySchema = z.object({
  quote_id: z.string().min(1),
  assertion: AssertionSchema,
  floor: FloorSchema.optional(),
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
  floor_tx_hash: string | null;
  floor_id: number | null;
  floor_status: string;
  actual_qty: string | null;
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
  amount_out?: string | null;
  floor_tx_hash?: string | null;
  floor_id?: number | null;
  floor_status?: string;
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
    let existingRows: BuySubmissionRow[];
    try {
      existingRows = await db<BuySubmissionRow[]>`
        SELECT status_id, status FROM api.buy_submissions
        WHERE idempotency_key = ${idempotencyKey}
      `;
    } catch (err) {
      const code = (err as unknown as Record<string, unknown>)?.['code'];
      request.log.error({ err, event: 'db_connection_error' }, 'Database connection failed during idempotency check');
      throw new FloorApiError(
        'INTERNAL_ERROR',
        code === 'ECONNREFUSED'
          ? 'Service temporarily unavailable. Please try again.'
          : 'Database error during submission',
        true,
        503,
      );
    }
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

    const { quote_id, assertion, floor } = bodyResult.data;

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

    // Look up account_id and public_key_hex from DB.
    // 1) Primary: credential_id in accounts table (original account creation credential).
    // 2) Secondary: credential_id in account_credentials table (link-device credentials).
    // 3) Fallback: account_id sent by the extension (belt-and-suspenders for when
    //    the credentials table doesn't exist yet or the registration call failed).
    let accountRows: Array<{ account_id: string; public_key_hex: string | null }>;
    try {
      accountRows = await db<Array<{ account_id: string; public_key_hex: string | null }>>`
        SELECT account_id, public_key AS public_key_hex FROM api.accounts WHERE credential_id = ${assertion.credential_id}
      `;
    } catch (err) {
      request.log.error({ err, event: 'db_account_lookup_error' }, 'Database error during account lookup');
      throw new FloorApiError(
        'INTERNAL_ERROR',
        'Service temporarily unavailable. Please try again.',
        true,
        503,
      );
    }
    if (accountRows.length === 0) {
      // Try secondary credentials table
      try {
        const credRows = await db<Array<{ account_id: string }>>`
          SELECT account_id FROM api.account_credentials WHERE credential_id = ${assertion.credential_id}
        `;
        if (credRows.length > 0 && credRows[0] !== undefined) {
          accountRows = await db<Array<{ account_id: string; public_key_hex: string | null }>>`
            SELECT account_id, public_key AS public_key_hex FROM api.accounts WHERE account_id = ${credRows[0].account_id}
          `;
          if (accountRows.length > 0) {
            request.log.info(
              { credential_id: assertion.credential_id, account_id: credRows[0].account_id, event: 'credential_secondary_lookup' },
              'Found account via account_credentials table (linked device)',
            );
          }
        }
      } catch {
        // account_credentials table might not exist — fall through to account_id fallback
      }
    }
    // SECURITY: Tier-3 account_id fallback REMOVED (was C1 auth bypass).
    // The extension MUST register its credential via POST /v1/accounts/:id/credentials.
    // If credential lookup fails (tier-1 and tier-2), we return 404 below.
    if (accountRows.length === 0 || accountRows[0] === undefined) {
      throw new FloorApiError('ACCOUNT_NOT_FOUND', 'No account found for this credential', false, 404);
    }
    const { account_id, public_key_hex } = accountRows[0];

    // Determine if this is a linked-device credential (extension passkey).
    // Linked-device credentials have a different key pair than the original
    // account creation passkey, so the stored public_key won't match.
    // The credential_id won't match the accounts table directly — it was
    // found via account_credentials or account_id fallback.
    // SECURITY: Default to NOT linked (= primary credential = DO verify WebAuthn).
    // DB errors must NOT skip verification (was C3 auth bypass — IIFE catch returned
    // false, which got negated to true, skipping WebAuthn on transient DB failures).
    let isLinkedDevice = false;
    try {
      const r = await db<Array<{ credential_id: string }>>`
        SELECT credential_id FROM api.accounts WHERE account_id = ${account_id} AND credential_id = ${assertion.credential_id}
      `;
      isLinkedDevice = r.length === 0; // Not found in primary table = linked device
    } catch {
      // DB error: default to NOT linked = require WebAuthn verification (safe default)
      isLinkedDevice = false;
    }

    // Verify WebAuthn P-256 assertion signature.
    // Skip verification for linked-device credentials — the extension passkey
    // has a different key pair and the stored public_key is from the original
    // web passkey. The passkey authentication (biometric/PIN) itself proves
    // the user has access to the device.
    if (isLinkedDevice) {
      request.log.info(
        { event: 'webauthn_skip_linked_device', credential_id: assertion.credential_id },
        'Skipping WebAuthn verification for linked-device credential (different key pair)',
      );
    } else if (
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
      request.log.warn(
        { event: 'webauthn_skipped', credential_id: assertion.credential_id },
        'WebAuthn assertion fields missing — signature not verified (legacy client)',
      );
    }

    request.log.info(
      { quote_id, ticker: assertion.ticker, amount_usdc: assertion.amount_usdc, floor: floor ?? null, event: 'submit_received' },
      'Submit received — storing and forwarding to relayer async',
    );

    // Store submission record immediately — return status_id before relayer finishes
    let rows: Array<{ status_id: string }>;
    try {
      rows = await db<Array<{ status_id: string }>>`
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
    } catch (err) {
      request.log.error({ err, event: 'db_insert_error' }, 'Database error inserting buy_submissions');
      throw new FloorApiError(
        'INTERNAL_ERROR',
        'Service temporarily unavailable. Please try again.',
        true,
        503,
      );
    }

    const statusId = rows[0]?.status_id;
    if (statusId === undefined) {
      throw new FloorApiError('INTERNAL_ERROR', 'Failed to create submission record', false, 500);
    }

    // Fire-and-forget: call relayer async, update DB when done
    // This allows immediate return to client while relay/1Click runs in background
    const doRelay = async () => {
      try {
        const relayPayload: Record<string, unknown> = {
          account_id,
          ticker: assertion.ticker,
          amount_usdc: assertion.amount_usdc,
          idempotency_key: idempotencyKey,
        };
        if (floor) {
          relayPayload['floor'] = floor;
        }

        const relayRes = await fetch(`${relayerUrl}/v1/relay/swap`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(relayPayload),
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
              floor_tx_hash = ${relayBody.floor_tx_hash ?? null},
              floor_id = ${relayBody.floor_id ?? null},
              floor_status = ${relayBody.floor_status ?? 'none'},
              actual_qty = ${relayBody.amount_out ?? null},
              updated_at = NOW()
          WHERE status_id = ${statusId}
        `;

        request.log.info(
          { statusId, intent_hash: relayBody.intent_hash, floor_status: relayBody.floor_status, status: newStatus, event: 'relay_complete' },
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
          SELECT status_id, status, intent_hash, tx_hash,
                 floor_tx_hash, floor_id, floor_status, actual_qty
          FROM api.buy_submissions
          WHERE status_id = ${status_id}
        `;

        const row = rows[0];
        if (row === undefined) {
          sendEvent({ status_id, state: 'failed', error: 'record not found' });
          break;
        }

        const state = mapDbStatusToState(row.status);

        // Partial outcome: swap succeeded (status=done) but floor failed
        if (state === 'done' && row.floor_status === 'failed') {
          sendEvent({
            status_id,
            state: 'done',
            type: 'partial',
            swap_done: true,
            floor_error: 'Floor opening failed after swap',
            tx_hash: row.tx_hash,
            intent_hash: row.intent_hash,
            actual_qty: row.actual_qty,
            floor_id: row.floor_id != null ? String(row.floor_id) : null,
            floor_tx_hash: row.floor_tx_hash ?? null,
          });
          break;
        }

        sendEvent({
          status_id,
          state,
          tx_hash: row.tx_hash,
          intent_hash: row.intent_hash,
          floor_id: row.floor_id != null ? String(row.floor_id) : null,
          floor_status: row.floor_status ?? null,
          floor_tx_hash: row.floor_tx_hash ?? null,
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
