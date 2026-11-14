import type { FastifyInstance } from 'fastify';
import { createApp, type BaseConfig, type Logger } from '@floors/shared-server';
import type postgres from 'postgres';
import type { ApiConfig } from './config.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerQuoteRoutes } from './routes/quotes.js';
import { registerBuyRoutes } from './routes/buy.js';
import { registerSubmitRoutes } from './routes/submit.js';
import { registerInviteRoutes } from './routes/invites.js';
import { registerActionsRoutes } from './routes/actions.js';
import { registerSuggestionsRoutes } from './routes/suggestions.js';
import { registerPriceRoutes } from './routes/prices.js';

export async function buildApp(
  config: ApiConfig & BaseConfig,
  logger: Logger,
  db: postgres.Sql,
): Promise<FastifyInstance> {
  const app = await createApp(config, logger);

  // Register all routes
  registerAccountRoutes(app, db, config.RELAYER_URL, config.NEAR_NETWORK_ID, config.NEAR_NODE_URL, config.USDC_CONTRACT, config.FLOORS_CONTRACT);
  registerInviteRoutes(app, db);
  registerQuoteRoutes(app, config.RISK_URL, config);
  registerBuyRoutes(app, config.RELAYER_URL);
  registerSubmitRoutes(app, db, config.RELAYER_URL);
  registerActionsRoutes(app, db, config.RELAYER_URL, config.NEAR_NETWORK_ID, config.FLOORS_CONTRACT);
  registerSuggestionsRoutes(app, db);
  registerPriceRoutes(app);

  return app;
}
