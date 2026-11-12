import { createLogger, createApp, initTracing, loadConfig, BaseConfigSchema } from '@floors/shared-server';
import { z } from 'zod';
import { registerTokenRoutes } from './routes/tokens.js';

const RegistryConfigSchema = BaseConfigSchema.extend({
  SERVICE_NAME: z.string().default('registry'),
});

const config = loadConfig(RegistryConfigSchema);

initTracing(config.SERVICE_NAME, config.SERVICE_VERSION);

const logger = createLogger({
  service: config.SERVICE_NAME,
  version: config.SERVICE_VERSION,
  level: config.LOG_LEVEL,
});

const app = await createApp(config, logger);

registerTokenRoutes(app);

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT, event: 'server_started' }, 'Registry service started');
} catch (err) {
  logger.error({ err, event: 'server_start_failed' }, 'Failed to start server');
  process.exit(1);
}
