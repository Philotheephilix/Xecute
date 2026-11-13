import type { FastifyInstance } from 'fastify';
import { createApp, type BaseConfig, type Logger } from '@floors/shared-server';
import type postgres from 'postgres';
import type { ApiConfig } from './config.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerQuoteRoutes } from './routes/quotes.js';
import { registerBuyRoutes } from './routes/buy.js';
import { registerSubmitRoutes } from './routes/submit.js';
import { registerInviteRoutes } from './routes/invites.js';

export async function buildApp(
  config: ApiConfig & BaseConfig,
  logger: Logger,
  db: postgres.Sql,
): Promise<FastifyInstance> {
  const app = await createApp(config, logger);

  // Register all routes
  registerAccountRoutes(app, db, config.RELAYER_URL);
  registerInviteRoutes(app, db);
  registerQuoteRoutes(app);
  registerBuyRoutes(app, config.RELAYER_URL);
  registerSubmitRoutes(app, db, config.RELAYER_URL);

  return app;
}
