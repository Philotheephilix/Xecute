import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { FloorApiError } from '@floors/shared-server';
import type postgres from 'postgres';

const CreateAccountBodySchema = z.object({
  public_key: z.string().min(1),
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

export function registerAccountRoutes(app: FastifyInstance, db: postgres.Sql): void {
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

    const { public_key, credential_id } = bodyResult.data;

    // Generate account_id from public key (deterministic)
    const encoder = new TextEncoder();
    const data = encoder.encode(public_key);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    const account_id = `${hashHex.slice(0, 16)}.floors.near`;

    // Check if account already exists
    const existing = await db<AccountRow[]>`
      SELECT account_id FROM api.accounts WHERE account_id = ${account_id}
    `;

    let created = false;
    if (existing.length === 0) {
      await db`
        INSERT INTO api.accounts (account_id, public_key, credential_id)
        VALUES (${account_id}, ${public_key}, ${credential_id})
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

    request.log.info({ account_id, created }, 'account_created');
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
