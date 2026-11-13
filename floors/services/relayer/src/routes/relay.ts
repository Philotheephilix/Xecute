import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
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

// BLOCKER 4: floor_id accepts both numeric string and number, transformed to number
const FloorIdSchema = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
  .transform((v) => Number(v));

const ExpireFloorBodySchema = z.object({
  floor_id: FloorIdSchema,
});

const FloorActionBodySchema = z.object({
  floor_id: FloorIdSchema,
  action: z.enum(['sell_to_floor', 'close']),
  account_id: z.string().regex(/^0s[0-9a-f]{40}$/),
  // BLOCKER 3: nonce and valid_until_ns required for replay check
  nonce: z.string().regex(/^\d+$/),
  valid_until_ns: z.string().regex(/^\d+$/),
  assertion: z.object({
    signature: z.string(),
    credential_id: z.string(),
    wallet_request: z.unknown(),
  }),
});

const ExpireBatchBodySchema = z.object({
  floor_ids: z.array(FloorIdSchema).min(1).max(50),
});

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

// BLOCKER 3: in-memory nonce replay protection (HTTP-layer, chain is authoritative)
const seenNonces = new Map<string, number>(); // nonce → expiry ms

function checkAndRecordNonce(nonce: string, validUntilNs: string): boolean {
  const now = Date.now();
  // clean expired entries
  for (const [n, exp] of seenNonces) {
    if (exp < now) seenNonces.delete(n);
  }
  if (seenNonces.has(nonce)) return false; // replay
  const expMs = Number(BigInt(validUntilNs) / 1_000_000n);
  seenNonces.set(nonce, expMs);
  return true;
}

// BLOCKER 1: internal auth preHandler
async function requireInternalAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const secret = process.env['INTERNAL_SECRET'];
  if (!secret) return; // dev mode: no secret configured → allow
  if (request.headers['x-internal-secret'] !== secret) {
    await reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
  }
}

/**
 * Create a NEAR account handle authenticated with the relayer's signing key.
 */
async function createSigningAccount(config: RelayerConfig): Promise<Account> {
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
      const signingAccount = await createSigningAccount(config);
      const outcome = await signingAccount.sendMoney(config.NEAR_ACCOUNT_ID, BigInt(1));
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
      const signingAccount = await createSigningAccount(config);

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

  // ---- P2-8: bot endpoints for floor lifecycle automation ----

  /**
   * POST /v1/relay/expire-floor
   *
   * Called by cron/indexer when a floor's expires_at has passed.
   * Calls floors.near#expire(floor_id) from the relayer signing key.
   * BLOCKER 1: protected by internal API key.
   */
  app.post('/v1/relay/expire-floor', { preHandler: requireInternalAuth }, async (request, reply) => {
    const bodyResult = ExpireFloorBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        'Invalid expire-floor request',
        false,
        400,
        { issues: bodyResult.error.issues },
      );
    }

    const { floor_id } = bodyResult.data;
    const floorsContract = config.FLOORS_CONTRACT;

    logger.info(
      { floor_id, contract: floorsContract, event: 'expire_floor_start' },
      'Calling expire on floors contract',
    );

    let tx_hash: string;
    try {
      const signingAccount = await createSigningAccount(config);

      const outcome = await signingAccount.functionCall({
        contractId: floorsContract,
        methodName: 'expire',
        // BLOCKER 4: floor_id is now a number (u64)
        args: { floor_id },
        // BONUS: expire calls mt_transfer + callback, needs ~50 TGas
        gas: BigInt(50_000_000_000_000), // 50 TGas
        attachedDeposit: BigInt(0),
      });

      tx_hash = outcome.transaction_outcome.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, floor_id, event: 'expire_floor_error' }, 'expire call failed');
      throw new FloorApiError('RELAYER_ERROR', `NEAR RPC failed: ${msg}`, true, 502);
    }

    logger.info({ tx_hash, floor_id, event: 'expire_floor_submitted' }, 'expire submitted');
    return reply.status(200).send({ tx_hash });
  });

  /**
   * POST /v1/relay/floor-action
   *
   * User-initiated sell_to_floor or close, called by the API service.
   * Calls w_execute_signed on the user's 0s account with a wallet_request
   * targeting floors.near.
   * floor-action carries user auth so no internal-auth preHandler here.
   */
  app.post('/v1/relay/floor-action', async (request, reply) => {
    const bodyResult = FloorActionBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        'Invalid floor-action request',
        false,
        400,
        { issues: bodyResult.error.issues },
      );
    }

    const { floor_id, action, account_id, nonce, valid_until_ns, assertion } = bodyResult.data;
    const floorsContract = config.FLOORS_CONTRACT;

    // BLOCKER 3: reject obvious replays before burning gas
    if (!checkAndRecordNonce(nonce, valid_until_ns)) {
      throw new FloorApiError(
        'REPLAY_DETECTED',
        'Nonce already used',
        false,
        409,
      );
    }

    // BLOCKER 2: correct WalletRequest shape matching wallet-contracts-v0.2.0
    // ExternalCall fields: receiver_id, method_name, args (string), attached_near?, gas?
    const wallet_request = {
      nonce,
      valid_until_ns,
      external: [{
        receiver_id: floorsContract,
        method_name: action,
        // BLOCKER 4: floor_id is now a number
        args: JSON.stringify({ floor_id }),
        // BLOCKER 5: correct field is attached_near, not deposit
        attached_near: '1', // 1 yoctoNEAR
        // BONUS: 50 TGas for sell_to_floor/close
        gas: '50000000000000',
      }],
    };

    logger.info(
      { floor_id, action, account_id, event: 'floor_action_start' },
      'Calling w_execute_signed for floor action',
    );

    let tx_hash: string;
    try {
      const signingAccount = await createSigningAccount(config);

      const outcome = await signingAccount.functionCall({
        contractId: account_id,
        methodName: 'w_execute_signed',
        args: {
          msg: JSON.stringify(wallet_request),
          proof: assertion.signature,
        },
        // BONUS: 50 TGas outer call budget
        gas: BigInt(50_000_000_000_000), // 50 TGas
        attachedDeposit: BigInt(0),
      });

      tx_hash = outcome.transaction_outcome.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, floor_id, action, account_id, event: 'floor_action_error' }, 'floor action failed');
      throw new FloorApiError('RELAYER_ERROR', `w_execute_signed failed: ${msg}`, true, 502);
    }

    logger.info({ tx_hash, floor_id, action, account_id, event: 'floor_action_submitted' }, 'Floor action submitted');
    return reply.status(200).send({ tx_hash });
  });

  /**
   * POST /v1/relay/expire-floors-batch
   *
   * Expires multiple floors in parallel. Uses Promise.allSettled so one
   * failure does not block others. Returns per-floor results.
   * BLOCKER 1: protected by internal API key.
   */
  app.post('/v1/relay/expire-floors-batch', { preHandler: requireInternalAuth }, async (request, reply) => {
    const bodyResult = ExpireBatchBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        'Invalid expire-floors-batch request',
        false,
        400,
        { issues: bodyResult.error.issues },
      );
    }

    const { floor_ids } = bodyResult.data;
    const floorsContract = config.FLOORS_CONTRACT;

    logger.info(
      { count: floor_ids.length, contract: floorsContract, event: 'expire_batch_start' },
      'Expiring batch of floors',
    );

    const signingAccount = await createSigningAccount(config);

    const settled = await Promise.allSettled(
      floor_ids.map(async (floor_id) => {
        const outcome = await signingAccount.functionCall({
          contractId: floorsContract,
          methodName: 'expire',
          // BLOCKER 4: floor_id is now a number (u64)
          args: { floor_id },
          // BONUS: 50 TGas for expire (mt_transfer + callback)
          gas: BigInt(50_000_000_000_000), // 50 TGas
          attachedDeposit: BigInt(0),
        });
        return { floor_id, tx_hash: outcome.transaction_outcome.id };
      }),
    );

    const results = settled.map((result, i) => {
      const floor_id = floor_ids[i];
      if (result.status === 'fulfilled') {
        return { floor_id, tx_hash: result.value.tx_hash };
      } else {
        const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        logger.warn({ floor_id, err: result.reason, event: 'expire_batch_item_error' }, 'Batch expire item failed');
        return { floor_id, error: msg };
      }
    });

    logger.info(
      { count: floor_ids.length, failed: results.filter(r => 'error' in r).length, event: 'expire_batch_done' },
      'Batch expire complete',
    );

    return reply.status(200).send({ results });
  });

  /**
   * POST /v1/relay/reconcile
   *
   * Stub — complex settlement logic is out of scope for this ticket.
   * BLOCKER 1: protected by internal API key.
   */
  app.post('/v1/relay/reconcile', { preHandler: requireInternalAuth }, async (_request, reply) => {
    return reply.status(501).send({ error: 'Not implemented', code: 'NOT_IMPLEMENTED' });
  });

  /**
   * POST /v1/relay/auto-protect
   *
   * Stub — requires indexer to detect expiring floors and trigger renewal.
   * Out of scope for this ticket.
   * BLOCKER 1: protected by internal API key.
   */
  app.post('/v1/relay/auto-protect', { preHandler: requireInternalAuth }, async (_request, reply) => {
    return reply.status(501).send({ error: 'Not implemented', code: 'NOT_IMPLEMENTED' });
  });
}
