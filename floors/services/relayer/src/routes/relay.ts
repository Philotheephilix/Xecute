import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { FloorApiError } from '@floors/shared-server';
import { connect, keyStores, KeyPair } from 'near-api-js';
import type { Account } from 'near-api-js';
import type pino from 'pino';
import type { Sql } from 'postgres';
import type { RelayerConfig } from '../index.js';
import {
  sendRawNearTransaction,
  nearAccountExists,
  encodeDeployGlobalContractAction,
  encodeDeterministicStateInitAction,
  encodeWalletStateForP256,
} from '../near-tx.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const RelayBodySchema = z.object({
  account_id: z.string().min(1),
  actions: z.array(z.record(z.unknown())).min(1),
  idempotency_key: z.string().uuid(),
});

const CreateAccountBodySchema = z.object({
  account_id: z.string().regex(/^0s[0-9a-f]{40}$/, 'must be a valid 0s... NEP-616 address'),
  // compressed P-256 public key as hex (66 hex chars = 33 bytes)
  public_key_hex: z.string().regex(/^[0-9a-f]{66}$/, 'must be 66 hex chars (compressed P-256 key)'),
  idempotency_key: z.string().uuid(),
});

const EnableTradingBodySchema = z.object({
  account_id: z.string().regex(/^0s[0-9a-f]{40}$/, 'must be a valid 0s... NEP-616 address'),
  wallet_request_signed: z.object({
    msg: z.string().min(1),
    proof: z.string().min(1),
  }),
  idempotency_key: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const result = new Uint8Array(hex.length / 2);
  for (let i = 0; i < result.length; i++) {
    result[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Signing account singleton — created once at startup, reused for all requests.
// ---------------------------------------------------------------------------

let signingAccountPromise: Promise<Account> | null = null;
let signingAccountConfig: RelayerConfig | null = null;

function getSigningAccount(config: RelayerConfig): Promise<Account> {
  // Re-create if config changes (e.g. test suite rebuilds the module).
  if (!signingAccountPromise || signingAccountConfig !== config) {
    signingAccountConfig = config;
    signingAccountPromise = createSigningAccount(config);
  }
  return signingAccountPromise;
}

/**
 * Create a NEAR account handle authenticated with the relayer's signing key.
 */
export async function createSigningAccount(config: RelayerConfig): Promise<Account> {
  const keyStore = new keyStores.InMemoryKeyStore();
  const keyPair = KeyPair.fromString(
    config.NEAR_PRIVATE_KEY as Parameters<typeof KeyPair.fromString>[0],
  );
  await keyStore.setKey(config.NEAR_NETWORK_ID, config.NEAR_ACCOUNT_ID, keyPair);

  const near = await connect({
    networkId: config.NEAR_NETWORK_ID,
    nodeUrl: config.NEAR_NODE_URL,
    keyStore,
  });

  return near.account(config.NEAR_ACCOUNT_ID);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerRelayRoutes(
  app: FastifyInstance,
  logger: pino.Logger,
  db: Sql,
  config: RelayerConfig,
): void {
  // ---- Legacy relay endpoint (S6 integration harness) ----

  app.post('/v1/relay', async (request, reply) => {
    const bodyResult = RelayBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        'Invalid relay request',
        false,
        400,
        { issues: bodyResult.error.issues },
      );
    }

    const { account_id, actions, idempotency_key } = bodyResult.data;

    // Check idempotency
    const existing = await db<Array<{ tx_hash: string; status: string }>>`
      SELECT tx_hash, status FROM relayer.transactions
      WHERE idempotency_key = ${idempotency_key}
    `;
    if (existing.length > 0 && existing[0] !== undefined) {
      return reply.status(200).send({ tx_hash: existing[0].tx_hash, status: existing[0].status });
    }

    logger.info(
      { account_id, action_count: actions.length, event: 'relay_start' },
      'Submitting transaction to NEAR',
    );

    let tx_hash: string;
    try {
      const signingAccount = await getSigningAccount(config);
      // Execute the provided actions as a function call on the target account.
      // The first action is expected to carry the signed intent payload.
      const outcome = await signingAccount.functionCall({
        contractId: account_id,
        methodName: 'execute',
        args: { actions },
        gas: BigInt(100_000_000_000_000), // 100 TGas
        attachedDeposit: BigInt(0),
      });
      tx_hash = outcome.transaction_outcome.id;
      logger.info({ tx_hash, account_id, event: 'near_tx_submitted' }, 'NEAR transaction submitted');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, account_id, event: 'near_rpc_error' }, 'NEAR RPC call failed');
      throw new FloorApiError('RELAYER_ERROR', `NEAR RPC failed: ${msg}`, true, 502);
    }

    await db`
      INSERT INTO relayer.transactions (idempotency_key, account_id, tx_hash, status)
      VALUES (${idempotency_key}, ${account_id}, ${tx_hash}, 'pending')
      ON CONFLICT (idempotency_key) DO NOTHING
    `;

    logger.info({ tx_hash, account_id, event: 'relay_submitted' }, 'Relay committed to DB');
    return reply.status(202).send({ tx_hash, status: 'pending' });
  });

  app.get('/v1/relay/:tx_hash', async (request, reply) => {
    const { tx_hash } = request.params as { tx_hash: string };

    const rows = await db<Array<{ tx_hash: string; status: string }>>`
      SELECT tx_hash, status FROM relayer.transactions
      WHERE tx_hash = ${tx_hash}
    `;

    if (rows.length === 0) {
      throw new FloorApiError('NOT_FOUND', `Transaction ${tx_hash} not found`, false, 404);
    }

    return reply.status(200).send(rows[0]);
  });

  // ---- P1-B: create smart account ----

  /**
   * POST /v1/relay/create-account
   *
   * Creates a NEP-616 deterministic smart account on NEAR for a user.
   *
   * Steps:
   * 1. Idempotency check (Postgres)
   * 2. Check if account already exists on NEAR
   * 3. Send DeployGlobalContract (if not already done) + DeterministicStateInit tx
   * 4. Return {account_id, status, tx_hash}
   *
   * Decision (ADR-0003 follow-up): near-api-js v5 does not support
   * DeployGlobalContract (NEP-591, action discriminant 9) or
   * DeterministicStateInit (NEP-616, action discriminant 11). We build the
   * raw Borsh transaction bytes and sign them using near-api-js's key management.
   */
  app.post('/v1/relay/create-account', async (request, reply) => {
    const bodyResult = CreateAccountBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        'Invalid create-account request',
        false,
        400,
        { issues: bodyResult.error.issues },
      );
    }

    const { account_id, public_key_hex, idempotency_key } = bodyResult.data;

    // 1. Idempotency check
    const existing = await db<Array<{ tx_hash: string; status: string; result: unknown }>>`
      SELECT tx_hash, status, result FROM relayer.create_account_requests
      WHERE idempotency_key = ${idempotency_key}
    `;
    if (existing.length > 0 && existing[0] !== undefined) {
      logger.info({ account_id, idempotency_key, event: 'create_account_idempotent' }, 'Idempotent request');
      return reply.status(200).send(existing[0].result);
    }

    // 2. Check if account already exists on NEAR
    const alreadyExists = await nearAccountExists(config.NEAR_NODE_URL, account_id);
    if (alreadyExists) {
      logger.info({ account_id, event: 'account_already_exists' }, 'Account already exists on NEAR');
      const result = { account_id, status: 'exists', tx_hash: null };

      await db`
        INSERT INTO relayer.create_account_requests (idempotency_key, account_id, status, result)
        VALUES (${idempotency_key}, ${account_id}, 'exists', ${db.json(result)})
        ON CONFLICT (idempotency_key) DO NOTHING
      `;

      return reply.status(200).send(result);
    }

    // 3. Attempt to deploy the wallet global contract first (idempotent on chain)
    //    The NEAR protocol silently succeeds if the hash is already deployed.
    const codeHashHex = config.WALLET_CONTRACT_CODE_HASH;
    const codeHashBytes = hexToBytes(codeHashHex);

    // Fetch wallet WASM to deploy (only needed if not yet deployed on testnet)
    // We attempt the deploy first — it's a no-op if already deployed (protocol-level).
    // The WASM must match the SHA-256 hash; we read it from a well-known location
    // or skip if this is testnet and it was already deployed.
    // For now: skip the global deploy step and attempt the state-init directly.
    // If the global contract isn't deployed yet, the state-init will fail with
    // "contract not found" and we'll get a clear error.
    //
    // The wallet WASM was pre-deployed during the P1-B setup by the build process.
    // See: docs/adr/0003-wallet-contract-version.md

    logger.info(
      { account_id, code_hash: codeHashHex, event: 'create_account_start' },
      'Creating NEAR smart account via DeterministicStateInit',
    );

    // 4. Build wallet state for the given P-256 public key
    const compressedKey = hexToBytes(public_key_hex);
    let stateBytes: Uint8Array;
    try {
      stateBytes = encodeWalletStateForP256(compressedKey);
    } catch (err) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        `Invalid public key: ${err instanceof Error ? err.message : String(err)}`,
        false,
        400,
      );
    }

    // Build the data BTreeMap: { b"" => stateBytes }
    const stateData = new Map<Uint8Array, Uint8Array>([[new Uint8Array(0), stateBytes]]);

    // 5. Send DeterministicStateInit action
    //    deposit = 10_000_000_000_000_000_000_000n = 0.01 NEAR (storage staking estimate)
    //    See ADR-0003 table: ~0.007 NEAR for account creation + buffer
    const DEPOSIT_YOCTO = 10_000_000_000_000_000_000_000n; // 0.01 NEAR

    const stateInitActionBytes = encodeDeterministicStateInitAction(
      codeHashBytes,
      stateData,
      DEPOSIT_YOCTO,
    );

    const txOptions = {
      networkId: config.NEAR_NETWORK_ID,
      nodeUrl: config.NEAR_NODE_URL,
      accountId: config.NEAR_ACCOUNT_ID,
      privateKey: config.NEAR_PRIVATE_KEY,
    };

    let tx_hash: string;
    try {
      const result = await sendRawNearTransaction(
        txOptions,
        account_id,             // receiver = the 0s... address
        [stateInitActionBytes], // actions
      );
      tx_hash = result.tx_hash;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, account_id, event: 'create_account_rpc_error' }, 'NEAR create account failed');

      // If error is "global contract not deployed", we need to deploy it first
      if (msg.includes('global contract') || msg.includes('contract not found') || msg.includes('UnknownAccount')) {
        throw new FloorApiError(
          'RELAYER_ERROR',
          `Wallet global contract not deployed on ${config.NEAR_NETWORK_ID}. ` +
          `Deploy it first using deploy-global-contract endpoint. Hash: ${codeHashHex}`,
          false,
          412,
        );
      }

      throw new FloorApiError('RELAYER_ERROR', `NEAR RPC failed: ${msg}`, true, 502);
    }

    logger.info({ tx_hash, account_id, event: 'account_created' }, 'NEAR smart account created');

    const responseBody = { account_id, status: 'created' as const, tx_hash };

    // 6. Persist idempotency record
    await db`
      INSERT INTO relayer.create_account_requests (idempotency_key, account_id, tx_hash, status, result)
      VALUES (${idempotency_key}, ${account_id}, ${tx_hash}, 'created', ${db.json(responseBody)})
      ON CONFLICT (idempotency_key) DO NOTHING
    `;

    return reply.status(201).send(responseBody);
  });

  // ---- P1-B: deploy global wallet contract (one-time setup) ----

  /**
   * POST /v1/relay/deploy-global-contract
   *
   * Deploys the wallet WASM as a NEP-591 global contract on NEAR.
   * This is a one-time setup step required before creating smart accounts.
   * Safe to call multiple times — NEAR protocol is idempotent for the same hash.
   */
  app.post('/v1/relay/deploy-global-contract', async (request, reply) => {
    // Expect the WASM bytes as base64 in the request body
    const bodyResult = z.object({
      wasm_base64: z.string().min(1),
      idempotency_key: z.string().uuid(),
    }).safeParse(request.body);

    if (!bodyResult.success) {
      throw new FloorApiError('VALIDATION_ERROR', 'Invalid request', false, 400, { issues: bodyResult.error.issues });
    }

    const { wasm_base64, idempotency_key } = bodyResult.data;

    // Check idempotency
    const existing = await db<Array<{ tx_hash: string }>>`
      SELECT tx_hash FROM relayer.transactions
      WHERE idempotency_key = ${idempotency_key}
    `;
    if (existing.length > 0 && existing[0] !== undefined) {
      return reply.status(200).send({ status: 'already_deployed', tx_hash: existing[0].tx_hash });
    }

    const wasmBytes = new Uint8Array(Buffer.from(wasm_base64, 'base64'));
    const deployAction = encodeDeployGlobalContractAction(wasmBytes);

    logger.info(
      { wasm_size: wasmBytes.length, event: 'deploy_global_contract_start' },
      'Deploying wallet global contract',
    );

    const txOptions = {
      networkId: config.NEAR_NETWORK_ID,
      nodeUrl: config.NEAR_NODE_URL,
      accountId: config.NEAR_ACCOUNT_ID,
      privateKey: config.NEAR_PRIVATE_KEY,
    };

    let tx_hash: string;
    try {
      const result = await sendRawNearTransaction(
        txOptions,
        config.NEAR_ACCOUNT_ID, // receiver = self for DeployGlobalContract
        [deployAction],
      );
      tx_hash = result.tx_hash;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, event: 'deploy_global_contract_error' }, 'Deploy global contract failed');
      throw new FloorApiError('RELAYER_ERROR', `NEAR deploy failed: ${msg}`, true, 502);
    }

    await db`
      INSERT INTO relayer.transactions (idempotency_key, account_id, tx_hash, status)
      VALUES (${idempotency_key}, ${config.NEAR_ACCOUNT_ID}, ${tx_hash}, 'deployed')
      ON CONFLICT (idempotency_key) DO NOTHING
    `;

    logger.info({ tx_hash, event: 'global_contract_deployed' }, 'Global wallet contract deployed');
    return reply.status(201).send({ status: 'deployed', tx_hash });
  });

  // ---- P1-B: enable trading ----

  /**
   * POST /v1/relay/enable-trading
   *
   * Calls w_execute_signed(msg, proof) on the user's smart account to add
   * their P-256 public key to intents.near and register with passkeys-registry.near.
   */
  app.post('/v1/relay/enable-trading', async (request, reply) => {
    const bodyResult = EnableTradingBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        'Invalid enable-trading request',
        false,
        400,
        { issues: bodyResult.error.issues },
      );
    }

    const { account_id, wallet_request_signed, idempotency_key } = bodyResult.data;

    // Check idempotency
    const existing = await db<Array<{ tx_hash: string; status: string; result: unknown }>>`
      SELECT tx_hash, status, result FROM relayer.create_account_requests
      WHERE idempotency_key = ${idempotency_key}
    `;
    if (existing.length > 0 && existing[0] !== undefined) {
      return reply.status(200).send(existing[0].result);
    }

    logger.info(
      { account_id, event: 'enable_trading_start' },
      'Calling w_execute_signed on wallet account',
    );

    // Call w_execute_signed on the smart account using near-api-js FunctionCall
    // (this is a standard function call — no custom actions needed)
    let tx_hash: string;
    try {
      const signingAccount = await getSigningAccount(config);

      const outcome = await signingAccount.functionCall({
        contractId: account_id,
        methodName: 'w_execute_signed',
        args: {
          msg: wallet_request_signed.msg,
          proof: wallet_request_signed.proof,
        },
        gas: BigInt(30_000_000_000_000), // 30 TGas
        attachedDeposit: BigInt(0),
      });

      tx_hash = outcome.transaction_outcome.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, account_id, event: 'enable_trading_error' }, 'w_execute_signed failed');
      throw new FloorApiError('RELAYER_ERROR', `w_execute_signed failed: ${msg}`, true, 502);
    }

    logger.info({ tx_hash, account_id, event: 'trading_enabled' }, 'Trading enabled for account');

    const responseBody = { tx_hash, status: 'success' as const };

    await db`
      INSERT INTO relayer.create_account_requests (idempotency_key, account_id, tx_hash, status, result)
      VALUES (${idempotency_key}, ${account_id}, ${tx_hash}, 'success', ${db.json(responseBody)})
      ON CONFLICT (idempotency_key) DO NOTHING
    `;

    return reply.status(200).send(responseBody);
  });

  // ---- Floor lifecycle bot endpoints ----

  // ---------------------------------------------------------------------------
  // Bot authentication
  // Reads INTERNAL_SECRET once at route-registration time.
  // If set, every bot endpoint requires:  Authorization: Bearer <secret>
  // If unset, a warning is logged at startup and requests are allowed through
  // (dev/sandbox mode).
  // ---------------------------------------------------------------------------

  const internalSecret = process.env['INTERNAL_SECRET'] ?? '';

  if (!internalSecret) {
    logger.warn(
      { event: 'bot_auth_disabled' },
      'INTERNAL_SECRET is not set — bot endpoints are unauthenticated (dev mode)',
    );
  }

  /**
   * Throws a 401 FloorApiError when INTERNAL_SECRET is configured and the
   * request does not carry a matching `Authorization: Bearer <secret>` header.
   */
  function assertBotAuth(request: FastifyRequest): void {
    if (!internalSecret) return; // dev mode — no auth required
    const authHeader = request.headers['authorization'] ?? '';
    if (authHeader !== `Bearer ${internalSecret}`) {
      throw new FloorApiError('UNAUTHORIZED', 'Missing or invalid Authorization header', false, 401);
    }
  }

  /**
   * Persist a nonce to Postgres for replay protection.
   *
   * Throws a FloorApiError (400) when the request has expired (valid_until_ns in the past).
   * Throws a FloorApiError (409) when the nonce already exists (replay attempt).
   * Returns void on success (nonce recorded for the first time).
   *
   * Also prunes expired nonces on each call (cheap DELETE; index on expires_at).
   */
  async function checkAndRecordNonce(nonce: string, valid_until_ns: string): Promise<void> {
    // Check expiry: valid_until_ns is nanoseconds; Date.now() is milliseconds
    const validUntilMs = BigInt(valid_until_ns) / 1_000_000n;
    if (validUntilMs < BigInt(Date.now())) {
      throw new FloorApiError('VALIDATION_ERROR', 'Request has expired (valid_until_ns in the past)', false, 400);
    }

    // Prune expired nonces (best-effort, don't block on error)
    db`DELETE FROM relayer.floor_action_nonces WHERE expires_at < NOW()`.catch((err: unknown) => {
      logger.warn({ err, event: 'nonce_prune_error' }, 'Failed to prune expired nonces');
    });

    // Atomically insert; 0 rows returned means nonce already exists → replay
    const rows = await db<Array<{ nonce: string }>>`
      INSERT INTO relayer.floor_action_nonces (nonce, expires_at)
      VALUES (${nonce}, to_timestamp(${valid_until_ns}::numeric / 1e9))
      ON CONFLICT (nonce) DO NOTHING
      RETURNING nonce
    `;

    if (rows.length === 0) {
      throw new FloorApiError('VALIDATION_ERROR', 'Nonce already used', false, 409);
    }
  }

  /**
   * POST /v1/relay/floor-action
   *
   * Validates and relays a user floor action (close, extend, etc.) to the NEAR
   * smart account via w_execute_signed.
   */
  const FloorActionBodySchema = z.object({
    account_id: z.string().regex(/^0s[0-9a-f]{40}$/, 'must be a valid 0s... NEP-616 address'),
    floor_id: z.number().int().nonnegative(),
    action: z.enum(['close', 'sell_to_floor', 'extend', 'cancel']),
    nonce: z.string().min(1),
    valid_until_ns: z.string().min(1),
    assertion: z.object({
      signature: z.string().min(1),
      credential_id: z.string().min(1),
      wallet_request: z.record(z.unknown()),
    }),
  });

  app.post('/v1/relay/floor-action', async (request, reply) => {
    assertBotAuth(request);

    const bodyResult = FloorActionBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError('VALIDATION_ERROR', 'Invalid floor-action request', false, 400, { issues: bodyResult.error.issues });
    }

    const { account_id, floor_id, action, nonce, valid_until_ns, assertion } = bodyResult.data;

    await checkAndRecordNonce(nonce, valid_until_ns);

    logger.info({ account_id, floor_id, action, event: 'floor_action_start' }, 'Floor action relay');

    let tx_hash: string;
    try {
      const signingAccount = await getSigningAccount(config);
      const outcome = await signingAccount.functionCall({
        contractId: account_id,
        methodName: 'w_execute_signed',
        args: {
          msg: JSON.stringify({ floor_id, action, nonce, valid_until_ns }),
          proof: assertion.signature,
        },
        gas: BigInt(30_000_000_000_000),
        attachedDeposit: BigInt(0),
      });
      tx_hash = outcome.transaction_outcome.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, account_id, floor_id, event: 'floor_action_error' }, 'w_execute_signed failed');
      throw new FloorApiError('RELAYER_ERROR', `NEAR RPC failed: ${msg}`, true, 502);
    }

    logger.info({ tx_hash, account_id, floor_id, action, event: 'floor_action_done' }, 'Floor action submitted');
    return reply.status(200).send({ tx_hash, status: 'success' });
  });

  /**
   * POST /v1/relay/expire-floor
   *
   * Calls `expire([floor_id])` on the floors contract.
   */
  const ExpireFloorBodySchema = z.object({
    floor_id: z.number().int().nonnegative(),
  });

  app.post('/v1/relay/expire-floor', async (request, reply) => {
    assertBotAuth(request);

    const bodyResult = ExpireFloorBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError('VALIDATION_ERROR', 'Invalid expire-floor request', false, 400, { issues: bodyResult.error.issues });
    }

    const { floor_id } = bodyResult.data;
    const floorsContract = config.FLOORS_CONTRACT;

    logger.info({ floor_id, floorsContract, event: 'expire_floor_start' }, 'Expire floor');

    let tx_hash: string;
    try {
      const signingAccount = await getSigningAccount(config);
      const outcome = await signingAccount.functionCall({
        contractId: floorsContract,
        methodName: 'expire',
        args: { floor_ids: [floor_id] },
        gas: BigInt(30_000_000_000_000),
        attachedDeposit: BigInt(0),
      });
      tx_hash = outcome.transaction_outcome.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, floor_id, event: 'expire_floor_error' }, 'expire floor call failed');
      throw new FloorApiError('RELAYER_ERROR', `NEAR RPC failed: ${msg}`, true, 502);
    }

    logger.info({ tx_hash, floor_id, event: 'expire_floor_done' }, 'Floor expired');
    return reply.status(200).send({ tx_hash });
  });

  /**
   * POST /v1/relay/expire-floors-batch
   *
   * Calls expire per floor_id (1-50), returns per-floor results.
   */
  const ExpireFloorsBatchBodySchema = z.object({
    floor_ids: z.array(z.number().int().nonnegative()).min(1).max(50),
  });

  app.post('/v1/relay/expire-floors-batch', async (request, reply) => {
    assertBotAuth(request);

    const bodyResult = ExpireFloorsBatchBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError('VALIDATION_ERROR', 'Invalid expire-floors-batch request', false, 400, { issues: bodyResult.error.issues });
    }

    const { floor_ids } = bodyResult.data;
    const floorsContract = config.FLOORS_CONTRACT;

    logger.info({ count: floor_ids.length, event: 'expire_floors_batch_start' }, 'Expire floors batch');

    const results: Array<{ floor_id: number; tx_hash?: string; error?: string }> = [];

    for (const floor_id of floor_ids) {
      try {
        const signingAccount = await getSigningAccount(config);
        const outcome = await signingAccount.functionCall({
          contractId: floorsContract,
          methodName: 'expire',
          args: { floor_ids: [floor_id] },
          gas: BigInt(30_000_000_000_000),
          attachedDeposit: BigInt(0),
        });
        results.push({ floor_id, tx_hash: outcome.transaction_outcome.id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ floor_id, error: msg });
      }
    }

    return reply.status(200).send({ results });
  });

  /**
   * POST /v1/relay/reconcile
   *
   * Calls `reconcile({ asset })` on the floors contract to rebalance a given asset.
   */
  const ReconcileBodySchema = z.object({
    asset: z.string().regex(/^nep141:[a-z0-9_\-\.]{2,64}$/, 'must be a nep141: asset id'),
  });

  app.post('/v1/relay/reconcile', async (request, reply) => {
    assertBotAuth(request);

    const bodyResult = ReconcileBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError('VALIDATION_ERROR', 'Invalid reconcile request', false, 400, { issues: bodyResult.error.issues });
    }

    const { asset } = bodyResult.data;
    const floorsContract = config.FLOORS_CONTRACT;

    logger.info({ asset, floorsContract, event: 'reconcile_start' }, 'Reconcile asset');

    let tx_hash: string;
    try {
      const signingAccount = await getSigningAccount(config);
      const outcome = await signingAccount.functionCall({
        contractId: floorsContract,
        methodName: 'reconcile',
        args: { asset },
        gas: BigInt(30_000_000_000_000), // 30 TGas
        attachedDeposit: BigInt(0),
      });
      tx_hash = outcome.transaction_outcome.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, asset, event: 'reconcile_error' }, 'reconcile call failed');
      throw new FloorApiError('RELAYER_ERROR', `NEAR RPC failed: ${msg}`, true, 502);
    }

    logger.info({ tx_hash, asset, event: 'reconcile_done' }, 'Reconcile submitted');
    return reply.status(200).send({ tx_hash, status: 'submitted' });
  });

  /**
   * POST /v1/relay/auto-protect
   *
   * Calls `auto_protect({ floor_id })` on the floors contract.
   */
  const AutoProtectBodySchema = z.object({
    floor_id: z.number().int().nonnegative(),
  });

  app.post('/v1/relay/auto-protect', async (request, reply) => {
    assertBotAuth(request);

    const bodyResult = AutoProtectBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError('VALIDATION_ERROR', 'Invalid auto-protect request', false, 400, { issues: bodyResult.error.issues });
    }

    const { floor_id } = bodyResult.data;
    const floorsContract = config.FLOORS_CONTRACT;

    logger.info({ floor_id, floorsContract, event: 'auto_protect_start' }, 'Auto-protect floor');

    let tx_hash: string;
    try {
      const signingAccount = await getSigningAccount(config);
      const outcome = await signingAccount.functionCall({
        contractId: floorsContract,
        methodName: 'auto_protect',
        args: { floor_id },
        gas: BigInt(60_000_000_000_000), // 60 TGas
        attachedDeposit: BigInt(0),
      });
      tx_hash = outcome.transaction_outcome.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, floor_id, event: 'auto_protect_error' }, 'auto_protect call failed');
      throw new FloorApiError('RELAYER_ERROR', `NEAR RPC failed: ${msg}`, true, 502);
    }

    logger.info({ tx_hash, floor_id, event: 'auto_protect_done' }, 'Auto-protect submitted');
    return reply.status(200).send({ tx_hash, status: 'submitted' });
  });

  /**
   * POST /v1/relay/unwind-start
   *
   * Calls `unwind_start({ asset, qty, deposit_account, min_usdc_out })` on the floors contract.
   */
  const UnwindStartBodySchema = z.object({
    asset: z.string().regex(/^nep141:[a-z0-9_\-\.]{2,64}$/, 'must be a nep141: asset id'),
    qty: z.string().min(1),
    deposit_account: z.string().regex(/^[a-z0-9_\-\.]{2,64}$/, 'must be a valid NEAR account id'),
    min_usdc_out: z.string().min(1),
  });

  app.post('/v1/relay/unwind-start', async (request, reply) => {
    assertBotAuth(request);

    const bodyResult = UnwindStartBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError('VALIDATION_ERROR', 'Invalid unwind-start request', false, 400, { issues: bodyResult.error.issues });
    }

    const { asset, qty, deposit_account, min_usdc_out } = bodyResult.data;
    const floorsContract = config.FLOORS_CONTRACT;

    logger.info({ asset, qty, deposit_account, event: 'unwind_start_start' }, 'Unwind start');

    let tx_hash: string;
    try {
      const signingAccount = await getSigningAccount(config);
      const outcome = await signingAccount.functionCall({
        contractId: floorsContract,
        methodName: 'unwind_start',
        args: {
          asset,
          qty: qty.toString(),
          deposit_account,
          min_usdc_out: min_usdc_out.toString(),
        },
        gas: BigInt(40_000_000_000_000), // 40 TGas
        attachedDeposit: BigInt(0),
      });
      tx_hash = outcome.transaction_outcome.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, asset, event: 'unwind_start_error' }, 'unwind_start call failed');
      throw new FloorApiError('RELAYER_ERROR', `NEAR RPC failed: ${msg}`, true, 502);
    }

    logger.info({ tx_hash, asset, event: 'unwind_start_done' }, 'Unwind start submitted');
    return reply.status(200).send({ tx_hash });
  });

  /**
   * POST /v1/relay/unwind-settle
   *
   * Calls `unwind_settle({ unwind_id })` on the floors contract.
   */
  const UnwindSettleBodySchema = z.object({
    unwind_id: z.number().int().nonnegative(),
  });

  app.post('/v1/relay/unwind-settle', async (request, reply) => {
    assertBotAuth(request);

    const bodyResult = UnwindSettleBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError('VALIDATION_ERROR', 'Invalid unwind-settle request', false, 400, { issues: bodyResult.error.issues });
    }

    const { unwind_id } = bodyResult.data;
    const floorsContract = config.FLOORS_CONTRACT;

    logger.info({ unwind_id, floorsContract, event: 'unwind_settle_start' }, 'Unwind settle');

    let tx_hash: string;
    try {
      const signingAccount = await getSigningAccount(config);
      const outcome = await signingAccount.functionCall({
        contractId: floorsContract,
        methodName: 'unwind_settle',
        args: { unwind_id },
        gas: BigInt(40_000_000_000_000), // 40 TGas
        attachedDeposit: BigInt(0),
      });
      tx_hash = outcome.transaction_outcome.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, unwind_id, event: 'unwind_settle_error' }, 'unwind_settle call failed');
      throw new FloorApiError('RELAYER_ERROR', `NEAR RPC failed: ${msg}`, true, 502);
    }

    logger.info({ tx_hash, unwind_id, event: 'unwind_settle_done' }, 'Unwind settle submitted');
    return reply.status(200).send({ tx_hash });
  });
}
