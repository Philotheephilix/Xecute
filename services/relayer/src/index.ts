import { createLogger, createApp, initTracing, loadConfig } from '@floors/shared-server';
import { z } from 'zod';
import { BaseConfigSchema } from '@floors/shared-server';
import { registerRelayRoutes } from './routes/relay.js';

const RelayerConfigSchema = BaseConfigSchema.extend({
  SERVICE_NAME: z.string().default('relayer'),
  NEAR_NODE_URL: z.string().url().default('https://rpc.testnet.near.org'),
  NEAR_NETWORK_ID: z.enum(['sandbox', 'testnet', 'mainnet']).default('testnet'),
});

const config = loadConfig(RelayerConfigSchema);

initTracing(config.SERVICE_NAME, config.SERVICE_VERSION);

const logger = createLogger({
  service: config.SERVICE_NAME,
  version: config.SERVICE_VERSION,
  level: config.LOG_LEVEL,
});

const app = await createApp(config, logger);

registerRelayRoutes(app, logger);

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT, event: 'server_started' }, 'Relayer service started');
} catch (err) {
  logger.error({ err, event: 'server_start_failed' }, 'Failed to start server');
  process.exit(1);
}
