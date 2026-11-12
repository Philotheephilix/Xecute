import { createLogger, createApp, createDb, runMigrations, initTracing, loadConfig } from '@floors/shared-server';
import { z } from 'zod';
import { BaseConfigSchema } from '@floors/shared-server';
import { registerRelayRoutes } from './routes/relay.js';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const RelayerConfigSchema = BaseConfigSchema.extend({
  SERVICE_NAME: z.string().default('relayer'),
  NEAR_NODE_URL: z.string().url().default('http://localhost:3030'),
  NEAR_NETWORK_ID: z.enum(['sandbox', 'testnet', 'mainnet']).default('sandbox'),
  NEAR_ACCOUNT_ID: z.string().default('alice.test.near'),
  NEAR_PRIVATE_KEY: z.string().default('ed25519:3D4YudUahN1nadPAuM6raWaNE9FKCaEBqbWJSFbEQ9JzqJKPQgDpXfBaKFEEBdMzCJwSDRnjCL5gKVzBMtnhXNi'),
});

export type RelayerConfig = z.infer<typeof RelayerConfigSchema>;

const config = loadConfig(RelayerConfigSchema);

initTracing(config.SERVICE_NAME, config.SERVICE_VERSION);

const logger = createLogger({
  service: config.SERVICE_NAME,
  version: config.SERVICE_VERSION,
  level: config.LOG_LEVEL,
});

const db = createDb(config.DATABASE_URL);

// Run migrations
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsDir = join(__dirname, '..', 'migrations');

try {
  await runMigrations(db, migrationsDir);
  logger.info({ event: 'migrations_complete' }, 'Database migrations applied');
} catch (err) {
  logger.error({ err, event: 'migrations_failed' }, 'Database migration failed');
  process.exit(1);
}

const app = await createApp(config, logger);

registerRelayRoutes(app, logger, db, config);

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT, event: 'server_started' }, 'Relayer service started');
} catch (err) {
  logger.error({ err, event: 'server_start_failed' }, 'Failed to start server');
  process.exit(1);
}
