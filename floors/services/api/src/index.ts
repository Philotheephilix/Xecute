import { createLogger, createDb, runMigrations, initTracing } from '@floors/shared-server';
import { loadApiConfig } from './config.js';
import { buildApp } from './app.js';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const config = loadApiConfig();

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

const app = await buildApp(config, logger, db);

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT, event: 'server_started' }, 'API service started');
} catch (err) {
  logger.error({ err, event: 'server_start_failed' }, 'Failed to start server');
  process.exit(1);
}
