import {
  createLogger,
  createApp,
  initTracing,
  loadConfig,
  BaseConfigSchema,
  createDb,
} from '@floors/shared-server';
import { z } from 'zod';
import PgBoss from 'pg-boss';

const IndexerConfigSchema = BaseConfigSchema.extend({
  SERVICE_NAME: z.string().default('indexer'),
  NEAR_NODE_URL: z.string().url().default('http://localhost:3030'),
  NEAR_NETWORK_ID: z.enum(['sandbox', 'testnet', 'mainnet']).default('sandbox'),
});

const config = loadConfig(IndexerConfigSchema);

initTracing(config.SERVICE_NAME, config.SERVICE_VERSION);

const logger = createLogger({
  service: config.SERVICE_NAME,
  version: config.SERVICE_VERSION,
  level: config.LOG_LEVEL,
});

const db = createDb(config.DATABASE_URL);
const app = await createApp(config, logger, async () => {
  try {
    await db`SELECT 1`;
    return { ready: true };
  } catch {
    return { ready: false, reason: 'db_unreachable' };
  }
});

// pg-boss queue consumer
const boss = new PgBoss(config.DATABASE_URL);

boss.on('error', (err) => {
  logger.error({ err, event: 'pgboss_error' }, 'pg-boss error');
});

try {
  await boss.start();
  logger.info({ event: 'pgboss_started' }, 'pg-boss started, watching for events');

  // Register queue handlers
  await boss.work('near-events', async (jobs) => {
    for (const job of jobs) {
      logger.info({ job_id: job.id, event: 'near_event_received' }, 'Processing NEAR event (stub)');
    }
  });

  logger.info({ event: 'indexer_started' }, 'Indexer started, watching for events');
} catch (err) {
  logger.warn({ err, event: 'pgboss_start_failed' }, 'pg-boss start failed (DB may not be available)');
}

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT, event: 'server_started' }, 'Indexer service started');
} catch (err) {
  logger.error({ err, event: 'server_start_failed' }, 'Failed to start server');
  process.exit(1);
}
