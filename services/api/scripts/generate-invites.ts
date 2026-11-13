/**
 * Generate invite codes and insert them into the database.
 *
 * Usage:
 *   DATABASE_URL=postgres://... tsx services/api/scripts/generate-invites.ts [count]
 *
 * Outputs one code per line to stdout for copy-paste sharing.
 * Codes are 8-char uppercase alphanumeric with visually unambiguous characters
 * (excludes 0/O/1/I to avoid confusion).
 */

import postgres from 'postgres';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

function generateCode(): string {
  let code = '';
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < CODE_LENGTH; i++) {
    const byte = bytes[i];
    if (byte === undefined) throw new Error('unexpected undefined byte');
    code += ALPHABET[byte % ALPHABET.length];
  }
  return code;
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('Error: DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const countArg = process.argv[2];
  const count = countArg !== undefined ? parseInt(countArg, 10) : 100;
  if (isNaN(count) || count <= 0) {
    console.error(`Error: invalid count "${countArg ?? ''}"`);
    process.exit(1);
  }

  const db = postgres(databaseUrl, { max: 1 });

  try {
    const codes: string[] = [];
    const seen = new Set<string>();

    while (codes.length < count) {
      const code = generateCode();
      if (!seen.has(code)) {
        seen.add(code);
        codes.push(code);
      }
    }

    // Batch insert — ON CONFLICT DO NOTHING skips any rare collision with existing codes
    await db`
      INSERT INTO api.invite_codes (code)
      SELECT unnest(${codes}::text[])
      ON CONFLICT (code) DO NOTHING
    `;

    // Emit one code per line for easy copy-paste
    for (const code of codes) {
      process.stdout.write(code + '\n');
    }

    console.error(`\nInserted ${count} invite codes.`);
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
