import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { FloorApiError } from '@floors/shared-server';
import type postgres from 'postgres';
import { deriveAddress } from '@floors/wallet/nep616';

const CreateAccountBodySchema = z.object({
  // compressed P-256 public key as hex (66 hex chars = 33 bytes, SEC1 compressed)
  public_key_hex: z.string().regex(/^[0-9a-f]{66}$/, 'must be 66 hex chars (compressed SEC1 P-256)'),
  credential_id: z.string().min(1),
});

const IdempotencyKeyHeader = z.string().uuid();

interface AccountRow {
  account_id: string;
  public_key: string;
  credential_id: string;
  created_at: Date;
}

type AccountParams = { account_id: string };
type PositionQueryString = { cursor?: string; limit?: string };

function hexToBytes(hex: string): Uint8Array {
  const result = new Uint8Array(hex.length / 2);
  for (let i = 0; i < result.length; i++) {
    result[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return result;
}

export function registerAccountRoutes(app: FastifyInstance, db: postgres.Sql): void {
  /**
   * POST /v1/accounts
   *
   * Creates a new Floors smart account with a NEP-616 deterministic address.
   *
   * Address derivation (P1-B):
   *   account_id = "0s" + hex(keccak256(borsh(StateInit))[12..32])
   * where StateInit = wallet-webauthn-p256 v0.2.0 code hash + State{key}.
   *
   * The account is created on NEAR testnet via the relayer's create-account endpoint.
   */
  app.post('/v1/accounts', async (request: FastifyRequest, reply: FastifyReply) => {
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

    const idempotencyKey = ikResult.data;

    // Check idempotency cache
    const cached = await db<Array<{ response: unknown }>>`
      SELECT response FROM api.idempotency_keys
      WHERE key = ${idempotencyKey} AND expires_at > NOW()
    `;
    if (cached.length > 0 && cached[0] !== undefined) {
      return reply.status(200).send(cached[0].response);
    }

    // Parse body
    const bodyResult = CreateAccountBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        'Invalid request body',
        false,
        400,
        { issues: bodyResult.error.issues },
      );
    }

    const { public_key_hex, credential_id } = bodyResult.data;

    // Derive NEP-616 deterministic account ID from the compressed P-256 public key
    const compressedKey = hexToBytes(public_key_hex);
    const account_id = deriveAddress(compressedKey);

    request.log.info({ account_id, public_key_hex: public_key_hex.slice(0, 16) + '...', event: 'account_address_derived' });

    // Check if account already exists in DB
    const existing = await db<AccountRow[]>`
      SELECT account_id FROM api.accounts WHERE account_id = ${account_id}
    `;

    let created = false;
    if (existing.length === 0) {
      await db`
        INSERT INTO api.accounts (account_id, public_key, credential_id)
        VALUES (${account_id}, ${public_key_hex}, ${credential_id})
        ON CONFLICT (account_id) DO NOTHING
      `;
      created = true;
    }

    const response = { account_id, created };

    // Store idempotency key (24h TTL)
    await db`
      INSERT INTO api.idempotency_keys (key, response, expires_at)
      VALUES (${idempotencyKey}, ${db.json(response)}, NOW() + INTERVAL '24 hours')
      ON CONFLICT (key) DO NOTHING
    `;

    request.log.info({ account_id, created, event: 'account_created' });
    return reply.status(created ? 201 : 200).send(response);
  });

  app.get<{ Params: AccountParams }>(
    '/v1/accounts/:account_id',
    async (request, reply) => {
      const { account_id } = request.params;

      const rows = await db<AccountRow[]>`
        SELECT account_id, public_key, credential_id, created_at
        FROM api.accounts
        WHERE account_id = ${account_id}
      `;

      if (rows.length === 0 || rows[0] === undefined) {
        throw new FloorApiError('ACCOUNT_NOT_FOUND', `Account ${account_id} not found`, false, 404);
      }

      const row = rows[0];
      return reply.status(200).send({
        account_id: row.account_id,
        public_key: row.public_key,
        created_at: row.created_at.toISOString(),
      });
    },
  );

  app.get<{ Params: AccountParams; Querystring: PositionQueryString }>(
    '/v1/accounts/:account_id/positions',
    async (request, reply) => {
      const { account_id } = request.params;
      const { cursor, limit: limitStr } = request.query;

      const limit = Math.min(parseInt(limitStr ?? '20', 10), 100);

      interface PositionRow {
        floor_id: string;
        account_id: string;
        asset: string;
        qty: string;
        floor_price_e6: string;
        status: string;
        opened_at: Date;
        expires_at: Date;
      }

      const rows = await db<PositionRow[]>`
        SELECT floor_id, account_id, asset, qty, floor_price_e6, status, opened_at, expires_at
        FROM api.positions
        WHERE account_id = ${account_id}
          ${cursor !== undefined ? db`AND floor_id > ${cursor}` : db``}
        ORDER BY floor_id ASC
        LIMIT ${limit + 1}
      `;

      const hasMore = rows.length > limit;
      const positions = hasMore ? rows.slice(0, limit) : rows;
      const lastPos = positions[positions.length - 1];
      const nextCursor = hasMore && lastPos !== undefined ? lastPos.floor_id : undefined;

      return reply.status(200).send({
        positions: positions.map((p) => ({
          floor_id: p.floor_id,
          account_id: p.account_id,
          asset: p.asset,
          qty: p.qty,
          floor_price_e6: p.floor_price_e6,
          status: p.status,
          opened_at: p.opened_at.toISOString(),
          expires_at: p.expires_at.toISOString(),
        })),
        cursor: nextCursor,
      });
    },
  );
}
