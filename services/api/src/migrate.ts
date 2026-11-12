import { createDb, runMigrations } from '@floors/shared-server';
import { loadApiConfig } from './config.js';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const config = loadApiConfig();
const db = createDb(config.DATABASE_URL);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsDir = join(__dirname, '..', 'migrations');

try {
  await runMigrations(db, migrationsDir);
  console.log('Migrations complete');
  await db.end();
} catch (err) {
  console.error('Migration failed:', err);
  await db.end();
  process.exit(1);
}
