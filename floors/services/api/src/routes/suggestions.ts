/**
 * GET /v1/suggestions — floor defaults for an account (or global defaults)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type postgres from 'postgres';

// ---------------------------------------------------------------------------
// Global defaults
// ---------------------------------------------------------------------------

const DEFAULT_FLOOR_BPS = 500;        // 5%
const DEFAULT_DURATION_SECS = 2592000; // 30 days

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerSuggestionsRoutes(
  app: FastifyInstance,
  _db: postgres.Sql,
): void {
  /**
   * GET /v1/suggestions
   *
   * Returns floor defaults for an account. Currently returns global defaults.
   * account_id query param accepted for future personalization.
   *
   * Response: { floor_bps, duration_secs }
   */
  app.get('/v1/suggestions', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(200).send({
      floor_bps: DEFAULT_FLOOR_BPS,
      duration_secs: DEFAULT_DURATION_SECS,
    });
  });
}
