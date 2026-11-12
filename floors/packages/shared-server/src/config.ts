import { z } from 'zod';

export const BaseConfigSchema = z.object({
  NODE_ENV: z.enum(['local', 'testnet', 'canary', 'production']),
  PORT: z.coerce.number().int().positive(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  SERVICE_NAME: z.string(),
  SERVICE_VERSION: z.string().default('0.0.1'),
  DATABASE_URL: z.string().url(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});

export type BaseConfig = z.infer<typeof BaseConfigSchema>;

export function loadConfig<T extends z.ZodTypeAny>(
  schema: T,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const formatted = result.error.format();
    console.error('Configuration validation failed:', JSON.stringify(formatted, null, 2));
    process.exit(1);
  }
  return result.data as z.infer<T>;
}
