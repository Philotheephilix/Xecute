import postgres from 'postgres';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function createDb(databaseUrl: string): postgres.Sql {
  return postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 30,
    transform: {
      undefined: null,
    },
  });
}

export async function runMigrations(
  sql: postgres.Sql,
  migrationsDir: string,
): Promise<void> {
  // Create migrations tracking table if not exists
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Read all SQL files from migrations dir
  const { readdir } = await import('node:fs/promises');
  let files: string[];
  try {
    files = await readdir(migrationsDir);
  } catch {
    // No migrations directory
    return;
  }

  const sqlFiles = files
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of sqlFiles) {
    const rows = await sql<Array<{ filename: string }>>`
      SELECT filename FROM _migrations WHERE filename = ${file}
    `;

    if (rows.length > 0) {
      continue; // Already applied
    }

    const filePath = join(migrationsDir, file);
    const content = await readFile(filePath, 'utf-8');

    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      await tx`INSERT INTO _migrations (filename) VALUES (${file})`;
    });

    console.log(`Applied migration: ${file}`);
  }
}
