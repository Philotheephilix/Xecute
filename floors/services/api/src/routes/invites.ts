import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { FloorApiError } from '@floors/shared-server';
import type postgres from 'postgres';

const ValidateInviteBodySchema = z.object({
  // Allow mixed-case input; handler normalises to upper before DB query.
  // Alphabet: ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (no I/O/0/1)
  code: z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/i, 'code must be 8 chars from the invite alphabet (A-Z excluding I/O, 2-9)'),
});

interface InviteCodeRow {
  code: string;
  used_at: Date | null;
}

export function registerInviteRoutes(app: FastifyInstance, db: postgres.Sql): void {
  /**
   * POST /v1/invites/validate
   *
   * Validates that an invite code exists and has not been redeemed yet.
   * Does NOT redeem the code — redemption happens atomically during account creation.
   */
  app.post('/v1/invites/validate', async (request: FastifyRequest, reply: FastifyReply) => {
    const bodyResult = ValidateInviteBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        'Invalid request body',
        false,
        400,
        { issues: bodyResult.error.issues },
      );
    }

    const { code } = bodyResult.data;
    const upperCode = code.toUpperCase();

    const rows = await db<InviteCodeRow[]>`
      SELECT code, used_at FROM api.invite_codes WHERE code = ${upperCode}
    `;

    if (rows.length === 0 || rows[0] === undefined || rows[0].used_at !== null) {
      throw new FloorApiError('INVALID_INVITE', 'Invalid or already used invite code', false, 400);
    }

    return reply.status(200).send({ valid: true });
  });
}
