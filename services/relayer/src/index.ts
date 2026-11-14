import { createLogger, createApp, createDb, runMigrations, initTracing, loadConfig } from '@floors/shared-server';
import { z } from 'zod';
import { BaseConfigSchema } from '@floors/shared-server';
import { registerRelayRoutes, createSigningAccount } from './routes/relay.js';
import { registerSwapRoutes } from './routes/swap.js';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const RelayerConfigSchema = BaseConfigSchema.extend({
  SERVICE_NAME: z.string().default('relayer'),
  NEAR_NODE_URL: z.string().url().default('http://localhost:3030'),
  NEAR_NETWORK_ID: z.enum(['sandbox', 'testnet', 'mainnet']).default('sandbox'),
  NEAR_ACCOUNT_ID: z.string().default('alice.test.near'),
  NEAR_PRIVATE_KEY: z.string().default('ed25519:3D4YudUahN1nadPAuM6raWaNE9FKCaEBqbWJSFbEQ9JzqJKPQgDpXfBaKFEEBdMzCJwSDRnjCL5gKVzBMtnhXNi'),
  // SHA-256 of the wallet-webauthn-p256 WASM (wallet-contracts-v0.2.0, ADR-0003)
  WALLET_CONTRACT_CODE_HASH: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'must be 64 hex chars')
    .default('7c2023ca3e3c53bf2309f9654180c8c516fb36cce5a18da8577e83c8f63ffd6b'),
  FLOORS_CONTRACT: z.string().default('floors.floors-dev.testnet'),
  RISK_SERVICE_URL: z.string().url().default('http://localhost:3003'),
  PYTH_CONTRACT: z.string().default('pyth.floors-dev.testnet'),
  PYTH_PRIVATE_KEY: z.string().optional(),
  ONE_CLICK_API_URL: z.string().url().default('https://1click.chaindefuser.com'),
  // Ref Finance testnet swap config (used when NEAR_NETWORK_ID !== 'mainnet')
  REF_FINANCE_CONTRACT: z.string().default('ref-finance-101.testnet'),
  USDC_TOKEN: z.string().default('usdc.fakes.testnet'),
  ETH_TOKEN: z.string().default('eth.fakes.testnet'),
  SOL_TOKEN: z.string().default('sol.fakes.testnet'),
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
registerSwapRoutes(app, logger, db, config);

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT, event: 'server_started' }, 'Relayer service started');
} catch (err) {
  logger.error({ err, event: 'server_start_failed' }, 'Failed to start server');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Background reconcile loop: fire-and-forget, every 5 minutes per major asset
// ---------------------------------------------------------------------------

const RECONCILE_ASSETS = [
  'nep141:eth.omft.near',
  'nep141:sol.omft.near',
  'nep141:starknet.omft.near',
];

const reconcileInterval = setInterval(async () => {
  for (const asset of RECONCILE_ASSETS) {
    try {
      const signingAccount = await createSigningAccount(config);
      const outcome = await signingAccount.functionCall({
        contractId: config.FLOORS_CONTRACT,
        methodName: 'reconcile',
        args: { asset },
        gas: BigInt(30_000_000_000_000), // 30 TGas
        attachedDeposit: BigInt(0),
      });
      logger.info(
        { asset, tx_hash: outcome.transaction_outcome.id, event: 'reconcile_loop_done' },
        'Reconcile loop submitted',
      );
    } catch (e) {
      logger.error({ err: e, asset, event: 'reconcile_loop_error' }, 'reconcile loop error');
    }
  }
}, 5 * 60 * 1000);
reconcileInterval.unref();

// ---------------------------------------------------------------------------
// Mock Pyth price refresh (testnet only): keep the mock oracle fresh so floor
// opens don't fail due to stale price. Runs every 30 seconds.
// ---------------------------------------------------------------------------

const PYTH_ETH_FEED = 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace';
const COINGECKO_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd';

const pythRefreshInterval = setInterval(async () => {
  if (config.NEAR_NETWORK_ID === 'mainnet') return; // Only on testnet
  try {
    // Fetch real ETH price from CoinGecko
    let priceE8 = 190000000000; // fallback $1900
    try {
      const cgRes = await fetch(COINGECKO_PRICE_URL);
      if (cgRes.ok) {
        const cgData = await cgRes.json() as { ethereum?: { usd?: number } };
        if (cgData.ethereum?.usd) {
          priceE8 = Math.round(cgData.ethereum.usd * 1e8);
        }
      }
    } catch { /* use fallback */ }

    // Use PYTH_PRIVATE_KEY if configured (mock Pyth admin may be a different account)
    const { connect, keyStores, KeyPair: nearKeyPair } = await import('near-api-js');
    const pythContract = config.PYTH_CONTRACT ?? 'pyth.floors-dev.testnet';
    let pythSigner = await createSigningAccount(config);
    if (config.PYTH_PRIVATE_KEY) {
      const ks = new keyStores.InMemoryKeyStore();
      const kp = nearKeyPair.fromString(config.PYTH_PRIVATE_KEY as Parameters<typeof nearKeyPair.fromString>[0]);
      await ks.setKey(config.NEAR_NETWORK_ID, pythContract, kp);
      const nearConn = await connect({ networkId: config.NEAR_NETWORK_ID, nodeUrl: config.NEAR_NODE_URL, keyStore: ks });
      pythSigner = await nearConn.account(pythContract);
    }
    const publishTimeNs = String(BigInt(Date.now()) * 1000000n);
    await pythSigner.functionCall({
      contractId: pythContract,
      methodName: 'set_price',
      args: {
        feed_id: PYTH_ETH_FEED,
        price: priceE8,
        expo: -8,
        publish_time_ns: publishTimeNs,
      },
      gas: BigInt(30_000_000_000_000),
      attachedDeposit: BigInt(0),
    });
    logger.info({ price: priceE8, event: 'pyth_refresh_done' }, 'Mock Pyth price refreshed');
  } catch (e) {
    logger.warn({ err: e, event: 'pyth_refresh_error' }, 'Mock Pyth refresh failed (non-fatal)');
  }
}, 30_000);
pythRefreshInterval.unref();
