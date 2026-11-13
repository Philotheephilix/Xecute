import { z } from 'zod';
import { BaseConfigSchema, loadConfig } from '@floors/shared-server';

export const ApiConfigSchema = BaseConfigSchema.extend({
  NODE_ENV: z.enum(['local', 'testnet', 'canary', 'production']),
  SERVICE_NAME: z.string().default('api'),
  RELAYER_URL: z.string().url().default('http://localhost:3002'),
  RISK_URL: z.string().url().default('http://localhost:3003'),
});

export type ApiConfig = z.infer<typeof ApiConfigSchema>;

export function loadApiConfig(): ApiConfig {
  return loadConfig(ApiConfigSchema);
}
