import { createLogger, createApp, initTracing, loadConfig, BaseConfigSchema } from '@floors/shared-server';
import { z } from 'zod';
import { registerRiskQuoteRoutes } from './routes/quotes.js';

const RiskConfigSchema = BaseConfigSchema.extend({
  SERVICE_NAME: z.string().default('risk'),
});

const config = loadConfig(RiskConfigSchema);

initTracing(config.SERVICE_NAME, config.SERVICE_VERSION);

const logger = createLogger({
  service: config.SERVICE_NAME,
  version: config.SERVICE_VERSION,
  level: config.LOG_LEVEL,
});

const app = await createApp(config, logger);

registerRiskQuoteRoutes(app);

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT, event: 'server_started' }, 'Risk service started');
} catch (err) {
  logger.error({ err, event: 'server_start_failed' }, 'Failed to start server');
  process.exit(1);
}
