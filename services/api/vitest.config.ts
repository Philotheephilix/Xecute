import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/__tests__/**/*.test.ts'],
    alias: {
      '@floors/shared-server': resolve(__dirname, '../../packages/shared-server/src/index.ts'),
      '@floors/types': resolve(__dirname, '../../packages/types/src/index.ts'),
    },
  },
});
