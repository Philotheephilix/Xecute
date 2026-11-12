import type { FastifyInstance } from 'fastify';
import { createApp, type BaseConfig, type Logger } from '@floors/shared-server';
import type postgres from 'postgres';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerQuoteRoutes } from './routes/quotes.js';
import { registerBuyRoutes } from './routes/buy.js';

export async function buildApp(
  config: BaseConfig,
  logger: Logger,
  db: postgres.Sql,
): Promise<FastifyInstance> {
  const app = await createApp(config, logger);

  // Register all routes
  registerAccountRoutes(app, db);
  registerQuoteRoutes(app);
  registerBuyRoutes(app);

  return app;
}
