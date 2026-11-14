import { z } from 'zod';
import { BaseConfigSchema, loadConfig } from '@floors/shared-server';

export const ApiConfigSchema = BaseConfigSchema.extend({
  NODE_ENV: z.enum(['local', 'testnet', 'canary', 'production']),
  SERVICE_NAME: z.string().default('api'),
  RELAYER_URL: z.string().url().default('http://localhost:3002'),
  RISK_URL: z.string().url().default('http://localhost:3003'),
  NEAR_NETWORK_ID: z.enum(['sandbox', 'testnet', 'mainnet']).default('testnet'),
  NEAR_NODE_URL: z.string().url().default('https://rpc.testnet.fastnear.com'),
  USDC_CONTRACT: z.string().default('3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af'),
  FLOORS_CONTRACT: z.string().default('floors-dev.testnet'),
  // Ref Finance testnet config (used when NEAR_NETWORK_ID !== 'mainnet')
  REF_FINANCE_CONTRACT: z.string().default('ref-finance-101.testnet'),
  USDC_TOKEN: z.string().default('usdc.fakes.testnet'),
  ETH_TOKEN: z.string().default('eth.fakes.testnet'),
  SOL_TOKEN: z.string().default('sol.fakes.testnet'),
});

export type ApiConfig = z.infer<typeof ApiConfigSchema>;

export function loadApiConfig(): ApiConfig {
  return loadConfig(ApiConfigSchema);
}
