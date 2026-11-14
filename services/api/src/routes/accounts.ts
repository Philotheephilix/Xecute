import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { FloorApiError } from '@floors/shared-server';
import type postgres from 'postgres';
import { deriveAddress } from '@floors/wallet/nep616';
import { buildRequestMessage, hashRequestMessage } from '@floors/wallet';
import type { NearPromiseJSON } from '@floors/wallet';

const AccountIdParamSchema = z.object({
  account_id: z.string().regex(/^0s[0-9a-f]{40}$/, 'account_id must match /^0s[0-9a-f]{40}$/'),
});

const CreateAccountBodySchema = z.object({
  // compressed P-256 public key as hex (66 hex chars = 33 bytes, SEC1 compressed)
  public_key_hex: z.string().regex(/^[0-9a-f]{66}$/, 'must be 66 hex chars (compressed SEC1 P-256)'),
  credential_id: z.string().min(1),
  invite_code: z.string().min(1).max(8).optional(),
});

const IdempotencyKeyHeader = z.string().uuid();

interface AccountRow {
  account_id: string;
  public_key: string;
  credential_id: string;
  created_at: Date;
}

type AccountParams = { account_id: string };
type PositionQueryString = { cursor?: string; limit?: string };

function hexToBytes(hex: string): Uint8Array {
  const result = new Uint8Array(hex.length / 2);
  for (let i = 0; i < result.length; i++) {
    result[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return result;
}

/**
 * Fetch the raw USDC balance (micro-units) for an account via NEAR RPC ft_balance_of.
 * Returns the raw string from the contract (e.g. "44845177") or null on failure.
 */
async function fetchRawUsdcBalance(accountId: string, rpcUrl: string, usdcContract: string): Promise<string | null> {
  try {
    const args = Buffer.from(JSON.stringify({ account_id: accountId })).toString('base64');
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'query',
        params: {
          request_type: 'call_function',
          finality: 'final',
          account_id: usdcContract,
          method_name: 'ft_balance_of',
          args_base64: args,
        },
      }),
    });
    const data = await response.json() as { result?: { result?: number[] }; error?: unknown };
    if (!data.result?.result) return null;
    const rawBalance = JSON.parse(Buffer.from(data.result.result).toString()) as string;
    return rawBalance;
  } catch {
    return null;
  }
}

/**
 * Fetch the USDC balance for an account via NEAR RPC ft_balance_of.
 * Returns a human-readable string (e.g. "20.00") or null on failure.
 */
async function fetchUsdcBalance(accountId: string, rpcUrl: string, usdcContract: string): Promise<string | null> {
  const raw = await fetchRawUsdcBalance(accountId, rpcUrl, usdcContract);
  if (raw === null) return null;
  return (Number(raw) / 1_000_000).toFixed(2);
}

/**
 * Fetch on-chain floors for an account via NEAR RPC list_floors view call.
 * Returns an array of FloorView objects or empty array on failure.
 */
interface OnChainFloor {
  floor_id: number;
  owner: string;
  asset: string;
  qty: string;
  floor_price_e6: string;
  reserved_usdc: string;
  fee_usdc: string;
  sleeve: string;
  opened_ns: string;
  expires_ns: string;
  status: string;
}

async function fetchOnChainFloors(accountId: string, rpcUrl: string, floorsContract: string): Promise<OnChainFloor[]> {
  try {
    const args = Buffer.from(JSON.stringify({ owner: accountId })).toString('base64');
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'query',
        params: {
          request_type: 'call_function',
          finality: 'final',
          account_id: floorsContract,
          method_name: 'list_floors',
          args_base64: args,
        },
      }),
    });
    const data = await response.json() as { result?: { result?: number[] }; error?: unknown };
    if (!data.result?.result) return [];
    const parsed = JSON.parse(Buffer.from(data.result.result).toString());
    if (!Array.isArray(parsed)) return [];
    return parsed as OnChainFloor[];
  } catch {
    return [];
  }
}

export function registerAccountRoutes(app: FastifyInstance, db: postgres.Sql, relayerUrl: string, nearNetworkId: string = 'testnet', nearNodeUrl: string = 'https://rpc.testnet.fastnear.com', usdcContract: string = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af', floorsContract: string = 'floors.floors-dev.testnet'): void {
  /**
   * POST /v1/accounts
   *
   * Creates a new Floors smart account with a NEP-616 deterministic address.
   *
   * Address derivation (P1-B):
   *   account_id = "0s" + hex(keccak256(borsh(StateInit))[12..32])
   * where StateInit = wallet-webauthn-p256 v0.2.0 code hash + State{key}.
   *
   * The account is created on NEAR testnet via the relayer's create-account endpoint.
   */
  app.post('/v1/accounts', async (request: FastifyRequest, reply: FastifyReply) => {
    // Validate Idempotency-Key
    const idempotencyKeyRaw = request.headers['idempotency-key'];
    if (typeof idempotencyKeyRaw !== 'string') {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        'Idempotency-Key header is required',
        false,
        400,
      );
    }

    const ikResult = IdempotencyKeyHeader.safeParse(idempotencyKeyRaw);
    if (!ikResult.success) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        'Idempotency-Key must be a valid UUID',
        false,
        400,
      );
    }

    const idempotencyKey = ikResult.data;

    // Check idempotency cache
    const cached = await db<Array<{ response: unknown }>>`
      SELECT response FROM api.idempotency_keys
      WHERE key = ${idempotencyKey} AND expires_at > NOW()
    `;
    if (cached.length > 0 && cached[0] !== undefined) {
      return reply.status(200).send(cached[0].response);
    }

    // Parse body
    const bodyResult = CreateAccountBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        'Invalid request body',
        false,
        400,
        { issues: bodyResult.error.issues },
      );
    }

    const { public_key_hex, credential_id, invite_code } = bodyResult.data;

    // Invite-gate: if any invite codes exist in the table, invite mode is on and
    // a valid, unused code is required to create an account.
    const inviteCount = await db<Array<{ n: string }>>`
      SELECT COUNT(*)::text AS n FROM api.invite_codes LIMIT 1
    `;
    const inviteModeOn = inviteCount[0] !== undefined && parseInt(inviteCount[0].n, 10) > 0;

    if (inviteModeOn) {
      if (invite_code === undefined || invite_code === '') {
        throw new FloorApiError('INVALID_INVITE', 'An invite code is required', false, 400);
      }
    }

    // Derive NEP-616 deterministic account ID from the compressed P-256 public key
    const compressedKey = hexToBytes(public_key_hex);
    const account_id = deriveAddress(compressedKey);

    request.log.info({ account_id, public_key_hex: public_key_hex.slice(0, 16) + '...', event: 'account_address_derived' });

    // Redeem invite code atomically BEFORE creating the account.
    // UPDATE-first pattern prevents TOCTOU race: only one concurrent request
    // can claim the code (used_at IS NULL guard is atomic in the UPDATE).
    if (inviteModeOn && invite_code !== undefined) {
      const upperCode = invite_code.toUpperCase();
      const redeemed = await db<Array<{ code: string }>>`
        UPDATE api.invite_codes
        SET used_at = NOW(), used_by = ${account_id}
        WHERE code = ${upperCode} AND used_at IS NULL
        RETURNING code
      `;
      if (redeemed.length === 0) {
        throw new FloorApiError('INVALID_INVITE', 'Invalid or already used invite code', false, 400);
      }
    }

    // Check if account already exists in DB
    const existing = await db<AccountRow[]>`
      SELECT account_id FROM api.accounts WHERE account_id = ${account_id}
    `;

    let created = false;
    if (existing.length === 0) {
      await db`
        INSERT INTO api.accounts (account_id, public_key, credential_id)
        VALUES (${account_id}, ${public_key_hex}, ${credential_id})
        ON CONFLICT (account_id) DO NOTHING
      `;
      created = true;

      // Fire-and-forget: ask the relayer to create the account on-chain.
      // The address is deterministic so the user can retry if this fails.
      const relayerIdempotencyKey = crypto.randomUUID();
      fetch(`${relayerUrl}/v1/relay/create-account`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id,
          public_key_hex,
          idempotency_key: relayerIdempotencyKey,
        }),
      }).catch((err: unknown) => {
        request.log.error(
          { err, account_id, event: 'relayer_create_account_fire_failed' },
          'Background relayer create-account call failed',
        );
      });
    }

    const response = { account_id, created };

    // Store idempotency key (24h TTL)
    await db`
      INSERT INTO api.idempotency_keys (key, response, expires_at)
      VALUES (${idempotencyKey}, ${db.json(response)}, NOW() + INTERVAL '24 hours')
      ON CONFLICT (key) DO NOTHING
    `;

    request.log.info({ account_id, created, event: 'account_created' });
    return reply.status(created ? 201 : 200).send(response);
  });

  app.get<{ Params: AccountParams }>(
    '/v1/accounts/:account_id',
    async (request, reply) => {
      const { account_id } = request.params;

      const rows = await db<AccountRow[]>`
        SELECT account_id, public_key, credential_id, created_at
        FROM api.accounts
        WHERE account_id = ${account_id}
      `;

      if (rows.length === 0 || rows[0] === undefined) {
        throw new FloorApiError('ACCOUNT_NOT_FOUND', `Account ${account_id} not found`, false, 404);
      }

      const row = rows[0];
      return reply.status(200).send({
        account_id: row.account_id,
        public_key: row.public_key,
        created_at: row.created_at.toISOString(),
      });
    },
  );

  // POST /v1/accounts/:account_id/credentials
  // Register an additional credential (passkey) for an existing account.
  // Called by the extension's link-device flow when a new passkey is created
  // on a different origin (chrome-extension://) than the original web passkey.
  const AddCredentialBodySchema = z.object({
    credential_id: z.string().min(1),
    public_key_hex: z.string().min(1).optional(),
    device_name: z.string().max(64).optional(),
    // SECURITY (C2): Require the original credential_id as proof-of-knowledge.
    // The caller must know the credential that created the account.
    // TODO: Production auth — require a passkey signature from the original credential.
    existing_credential_id: z.string().min(1),
  });

  app.post<{ Params: AccountParams }>(
    '/v1/accounts/:account_id/credentials',
    async (request, reply) => {
      const { account_id } = request.params;

      // Verify account exists AND retrieve the original credential_id
      const rows = await db<AccountRow[]>`
        SELECT account_id, credential_id FROM api.accounts WHERE account_id = ${account_id}
      `;
      if (rows.length === 0 || rows[0] === undefined) {
        throw new FloorApiError('ACCOUNT_NOT_FOUND', `Account ${account_id} not found`, false, 404);
      }

      const bodyResult = AddCredentialBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        throw new FloorApiError('VALIDATION_ERROR', 'Invalid request body', false, 400, { issues: bodyResult.error.issues });
      }

      const { credential_id, public_key_hex, device_name, existing_credential_id } = bodyResult.data;

      // SECURITY (C2): Verify the caller knows the original credential_id for this account.
      // This blocks trivial account-takeover via credential registration.
      // TODO: For production, require a passkey signature from the original credential instead.
      if (existing_credential_id !== rows[0].credential_id) {
        throw new FloorApiError(
          'UNAUTHORIZED',
          'existing_credential_id does not match the account\'s original credential',
          false,
          403,
        );
      }

      // Insert into account_credentials table; if it doesn't exist, update the
      // main accounts table's credential_id as a simple fallback (single-credential schema).
      // In production, a separate account_credentials table would be better.
      // For now, we store as a secondary credential by inserting a row that links
      // credential_id → account_id. We use the same accounts table with an upsert
      // approach: if credential already registered, no-op.
      try {
        // Try inserting into account_credentials if the table exists
        await db`
          INSERT INTO api.account_credentials (account_id, credential_id, public_key, source)
          VALUES (${account_id}, ${credential_id}, ${public_key_hex ?? null}, ${device_name ?? 'extension'})
          ON CONFLICT (credential_id) DO NOTHING
        `;
      } catch {
        // Table might not exist yet — log and continue.
        // The submit endpoint has an account_id fallback for this case.
        request.log.warn(
          { account_id, credential_id, event: 'credential_table_missing' },
          'account_credentials table not found — credential registration skipped',
        );
      }

      request.log.info({ account_id, credential_id, device_name, event: 'credential_registered' });
      return reply.status(200).send({ status: 'ok' });
    },
  );

  // POST /v1/accounts/:account_id/enable-trading-request
  app.post<{ Params: AccountParams }>(
    '/v1/accounts/:account_id/enable-trading-request',
    async (request, reply) => {
      // Validate account_id param
      const paramResult = AccountIdParamSchema.safeParse(request.params);
      if (!paramResult.success) {
        throw new FloorApiError(
          'VALIDATION_ERROR',
          'Invalid account_id: must match /^0s[0-9a-f]{40}$/',
          false,
          400,
          { issues: paramResult.error.issues },
        );
      }

      const { account_id } = paramResult.data;

      // Look up account to verify it exists
      const rows = await db<AccountRow[]>`
        SELECT account_id, public_key, credential_id, created_at
        FROM api.accounts
        WHERE account_id = ${account_id}
      `;

      if (rows.length === 0 || rows[0] === undefined) {
        throw new FloorApiError('ACCOUNT_NOT_FOUND', `Account ${account_id} not found`, false, 404);
      }

      const account = rows[0];

      // Build a RequestMessage in the contract's exact format for w_execute_signed.
      // The intents.near#add_public_key call registers the user's passkey for trading.
      const argsJson = JSON.stringify({ public_key: account.public_key });
      const argsBase64 = Buffer.from(argsJson).toString('base64');

      const external: NearPromiseJSON[] = [{
        receiver_id: 'intents.near',
        actions: [{
          action: 'function_call',
          payload: {
            function_name: 'add_public_key',
            args: argsBase64,
            deposit: '0',
          },
        }],
      }];

      const msg = buildRequestMessage(nearNetworkId, account_id, external);

      // challenge = SHA3-256("NEAR_WALLET_CONTRACT/V1" || borsh(RequestMessage))
      const challengeBytes = hashRequestMessage(msg);
      const challenge = Buffer.from(challengeBytes).toString('hex');

      return reply.status(200).send({ wallet_request: msg, challenge });
    },
  );

  // GET /v1/accounts/:account_id/deposit-addresses
  app.get<{ Params: AccountParams }>(
    '/v1/accounts/:account_id/deposit-addresses',
    async (request, reply) => {
      // Validate account_id param
      const paramResult = AccountIdParamSchema.safeParse(request.params);
      if (!paramResult.success) {
        throw new FloorApiError(
          'VALIDATION_ERROR',
          'Invalid account_id: must match /^0s[0-9a-f]{40}$/',
          false,
          400,
          { issues: paramResult.error.issues },
        );
      }

      const { account_id } = paramResult.data;

      // Verify account exists
      const rows = await db<AccountRow[]>`
        SELECT account_id FROM api.accounts WHERE account_id = ${account_id}
      `;

      if (rows.length === 0 || rows[0] === undefined) {
        throw new FloorApiError('ACCOUNT_NOT_FOUND', `Account ${account_id} not found`, false, 404);
      }

      const addresses = [
        { chain: 'near', chain_display: 'NEAR', address: account_id, asset: 'USDC', min_amount: '1.00', note: 'Send USDC (usdc.near) to your NEAR account' },
      ];

      return reply.status(200).send({ addresses });
    },
  );

  app.get<{ Params: AccountParams; Querystring: PositionQueryString }>(
    '/v1/accounts/:account_id/positions',
    async (request, reply) => {
      const { account_id } = request.params;
      const { cursor, limit: limitStr } = request.query;

      const limit = Math.min(parseInt(limitStr ?? '20', 10), 100);

      interface PositionRow {
        floor_id: string;
        account_id: string;
        asset: string;
        qty: string;
        floor_price_e6: string;
        status: string;
        opened_at: Date;
        expires_at: Date;
      }

      // Query DB positions, buy_submissions, on-chain floors, and USDC balance in parallel
      interface BuySubmissionRow {
        status_id: string;
        ticker: string;
        amount_usdc: string;
        tx_hash: string | null;
        status: string;
        created_at: Date;
      }

      const [positionRows, tradeRows, onChainFloors, rawUsdcBalance, totalSpentRows] = await Promise.all([
        db<PositionRow[]>`
          SELECT floor_id, account_id, asset, qty, floor_price_e6, status, opened_at, expires_at
          FROM api.positions
          WHERE account_id = ${account_id}
            ${cursor !== undefined ? db`AND floor_id > ${cursor}` : db``}
          ORDER BY floor_id ASC
          LIMIT ${limit + 1}
        `,
        db<BuySubmissionRow[]>`
          SELECT status_id, ticker, amount_usdc, tx_hash, status, created_at
          FROM api.buy_submissions
          WHERE account_id = ${account_id}
          ORDER BY created_at DESC
          LIMIT 50
        `,
        fetchOnChainFloors(account_id, nearNodeUrl, floorsContract),
        fetchRawUsdcBalance(account_id, nearNodeUrl, usdcContract),
        // Sum USDC spent in successful buys (debited from user's effective balance).
        // On testnet protocol < 89, on-chain w_execute_extension doesn't work,
        // so the on-chain balance stays unchanged. We debit via this ledger instead.
        db<Array<{ total_spent: string | null }>>`
          SELECT COALESCE(SUM(amount_usdc::bigint), 0)::text AS total_spent
          FROM api.buy_submissions
          WHERE account_id = ${account_id}
            AND status NOT IN ('failed', 'rejected')
        `,
      ]);

      // Show on-chain USDC balance directly. On testnet the relayer fronts swap
      // costs, so the user's on-chain balance reflects: initial funding + sell_to_floor
      // credits - any actual transfers out. On mainnet with protocol v89+, the wallet
      // extension handles actual USDC transfers from the user.
      let usdcBalance: string | null = null;
      if (rawUsdcBalance !== null) {
        usdcBalance = (Number(rawUsdcBalance) / 1_000_000).toFixed(2);
      }

      const hasMore = positionRows.length > limit;
      const dbPositions = hasMore ? positionRows.slice(0, limit) : positionRows;
      const lastPos = dbPositions[dbPositions.length - 1];
      const nextCursor = hasMore && lastPos !== undefined ? lastPos.floor_id : undefined;

      // On-chain floors are the primary source of truth (DB positions table may be empty).
      // Build a Set of on-chain floor IDs to dedup against DB rows.
      const onChainById = new Map(onChainFloors.map((f) => [String(f.floor_id), f]));

      // Map on-chain floors as primary positions
      const chainPositions = onChainFloors.map((f) => {
        const floorPriceE6 = f.floor_price_e6;
        const floorPriceUsd = Number(floorPriceE6) / 1_000_000;
        const status = f.status === 'Active' ? 'active' : f.status.toLowerCase();

        // Parse asset ticker and decimals from nep141 identifier
        const rawAsset = f.asset.replace(/^nep141:/, '');
        const assetLower = rawAsset.toLowerCase();
        let ticker = rawAsset;
        let decimals = 18;
        if (assetLower.includes('eth')) { ticker = 'ETH'; decimals = 18; }
        else if (assetLower.includes('btc') || assetLower.includes('wbtc')) { ticker = 'BTC'; decimals = 8; }
        else if (assetLower.includes('sol')) { ticker = 'SOL'; decimals = 9; }
        else if (assetLower.includes('near')) { ticker = 'NEAR'; decimals = 24; }
        else { ticker = rawAsset.split('.')[0]?.toUpperCase() ?? rawAsset; }

        // Format qty as human-readable display value
        const qtyRaw = f.qty;
        const qtyNum = Number(qtyRaw) / Math.pow(10, decimals);
        const qtyDisplay = qtyNum < 0.0001
          ? qtyNum.toExponential(2)
          : qtyNum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: Math.min(decimals, 8) });

        return {
          floor_id: String(f.floor_id),
          account_id: f.owner,
          asset: f.asset,
          ticker,
          qty: f.qty,
          qty_display: qtyDisplay,
          floor_price_e6: floorPriceE6,
          floor_price_usd: floorPriceUsd,
          reserved_usdc: f.reserved_usdc,
          fee_usdc: f.fee_usdc,
          sleeve: f.sleeve,
          status,
          opened_at: new Date(Number(f.opened_ns) / 1_000_000).toISOString(),
          expires_at: new Date(Number(f.expires_ns) / 1_000_000).toISOString(),
        };
      });

      // Add DB positions that aren't already covered by on-chain data
      const dbOnlyPositions = dbPositions
        .filter((p) => !onChainById.has(p.floor_id))
        .map((p) => {
          const rawAsset = p.asset.replace(/^nep141:/, '');
          const assetLower = rawAsset.toLowerCase();
          let ticker = rawAsset;
          if (assetLower.includes('eth')) ticker = 'ETH';
          else if (assetLower.includes('btc') || assetLower.includes('wbtc')) ticker = 'BTC';
          else if (assetLower.includes('sol')) ticker = 'SOL';
          else if (assetLower.includes('near')) ticker = 'NEAR';
          else ticker = rawAsset.split('.')[0]?.toUpperCase() ?? rawAsset;
          return {
            floor_id: p.floor_id,
            account_id: p.account_id,
            asset: p.asset,
            ticker,
            qty: p.qty,
            qty_display: p.qty,
            floor_price_e6: p.floor_price_e6,
            floor_price_usd: Number(p.floor_price_e6) / 1_000_000,
            status: p.status,
            opened_at: p.opened_at.toISOString(),
            expires_at: p.expires_at.toISOString(),
          };
        });

      const effectivePositions = [...chainPositions, ...dbOnlyPositions];

      // Map buy_submissions as recent_trades
      const recentTrades = tradeRows.map((t) => ({
        status_id: t.status_id,
        ticker: t.ticker,
        amount_usdc: t.amount_usdc,
        tx_hash: t.tx_hash,
        status: t.status,
        created_at: t.created_at.toISOString(),
      }));

      return reply.status(200).send({
        positions: effectivePositions,
        cursor: nextCursor,
        usdc_balance: usdcBalance,
        recent_trades: recentTrades,
      });
    },
  );

  // ── GET /v1/accounts/:account_id/activity ─────────────────────────────────
  // Fetch the last 10 real wallet transactions from NearBlocks testnet explorer
  // plus buy_submissions from the DB as additional context.

  interface NearBlocksTxn {
    actions: Array<{ action: string; method: string | null }>;
    actions_agg: { deposit: number };
    block_timestamp: string;
    predecessor_account_id: string;
    receiver_account_id: string;
    transaction_hash: string;
    receipt_id: string;
    receipt_outcome: { status: boolean };
  }

  interface ActivityBuySubmissionRow {
    status_id: string;
    ticker: string;
    amount_usdc: string;
    tx_hash: string | null;
    status: string;
    created_at: Date;
  }

  type IconType = 'swap' | 'floor' | 'transfer' | 'account' | 'other';

  function classifyTx(
    action: string,
    method: string | null,
    receiver: string,
    predecessor: string,
    accountId: string,
  ): { label: string; iconType: IconType } {
    // Non-function-call actions
    if (action === 'TRANSFER') return { label: 'Transfer', iconType: 'transfer' };
    if (action === 'DETERMINISTIC_STATE_INIT' || action === 'CREATE_ACCOUNT') {
      return { label: 'Account Created', iconType: 'account' };
    }

    if (action !== 'FUNCTION_CALL' || !method) {
      return { label: action, iconType: 'other' };
    }

    // Floors-specific methods
    if (method === 'sell_to_floor') return { label: 'Sold to Floor', iconType: 'floor' };
    if (method === 'close') return { label: 'Closed Position', iconType: 'floor' };
    if (method === 'expire') return { label: 'Floor Expired', iconType: 'floor' };
    if (method === 'reconcile') return { label: 'Reconcile', iconType: 'floor' };

    // mt_on_transfer on floors contracts
    if (method === 'mt_on_transfer' && (receiver.includes('floors') || predecessor.includes('floors'))) {
      return { label: 'Opened Floor', iconType: 'floor' };
    }

    // ft_transfer on USDC contract
    if (method === 'ft_transfer' && (receiver.includes('usdc') || receiver.includes('fakes.testnet'))) {
      const direction = predecessor === accountId ? 'Sent USDC' : 'Received USDC';
      return { label: direction, iconType: 'transfer' };
    }

    // ft_transfer_call on Ref Finance
    if (method === 'ft_transfer_call' && receiver.includes('ref-finance')) {
      return { label: 'Swapped on Ref Finance', iconType: 'swap' };
    }

    // ft_transfer_call generic (likely a swap)
    if (method === 'ft_transfer_call') {
      return { label: `Swap via ${receiver.split('.')[0] ?? receiver}`, iconType: 'swap' };
    }

    // Generic ft_transfer
    if (method === 'ft_transfer') {
      const direction = predecessor === accountId ? 'Sent tokens' : 'Received tokens';
      return { label: direction, iconType: 'transfer' };
    }

    // Fallback: show method name
    return { label: method, iconType: 'other' };
  }

  async function fetchNearBlocksTxns(accountId: string): Promise<NearBlocksTxn[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const url = `https://api-testnet.nearblocks.io/v1/account/${encodeURIComponent(accountId)}/txns?per_page=10&order=desc`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return [];
      const data = await res.json() as { txns?: NearBlocksTxn[] };
      return data.txns ?? [];
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  app.get<{ Params: AccountParams }>(
    '/v1/accounts/:account_id/activity',
    async (request, reply) => {
      const paramResult = AccountIdParamSchema.safeParse(request.params);
      if (!paramResult.success) {
        throw new FloorApiError(
          'VALIDATION_ERROR',
          'Invalid account_id: must match /^0s[0-9a-f]{40}$/',
          false,
          400,
          { issues: paramResult.error.issues },
        );
      }

      const { account_id } = paramResult.data;

      // Fetch NearBlocks txns and buy_submissions in parallel
      const [nearTxns, buyRows] = await Promise.all([
        fetchNearBlocksTxns(account_id),
        db<ActivityBuySubmissionRow[]>`
          SELECT status_id, ticker, amount_usdc, tx_hash, status, created_at
          FROM api.buy_submissions
          WHERE account_id = ${account_id}
          ORDER BY created_at DESC
          LIMIT 20
        `,
      ]);

      const transactions = nearTxns.map((tx) => {
        const firstAction = tx.actions[0];
        const action = firstAction?.action ?? 'UNKNOWN';
        const method = firstAction?.method ?? null;
        const { label, iconType } = classifyTx(
          action,
          method,
          tx.receiver_account_id,
          tx.predecessor_account_id,
          account_id,
        );

        // block_timestamp is in nanoseconds
        const tsMs = Number(BigInt(tx.block_timestamp) / 1_000_000n);
        const timestamp = new Date(tsMs).toISOString();

        return {
          tx_hash: tx.transaction_hash,
          receipt_id: tx.receipt_id,
          type: action,
          method,
          label,
          receiver: tx.receiver_account_id,
          predecessor: tx.predecessor_account_id,
          timestamp,
          status: tx.receipt_outcome?.status ? 'success' : 'failure',
          deposit: String(tx.actions_agg?.deposit ?? 0),
          icon_type: iconType,
          actions: tx.actions,
        };
      });

      const buySubmissions = buyRows.map((t) => ({
        status_id: t.status_id,
        ticker: t.ticker,
        amount_usdc: t.amount_usdc,
        tx_hash: t.tx_hash,
        status: t.status,
        created_at: t.created_at.toISOString(),
      }));

      return reply.status(200).send({ transactions, buy_submissions: buySubmissions });
    },
  );

  // ── GET /v1/accounts/:account_id/portfolio-history ──────────────────────────
  // Build a portfolio time series from buy_submissions, USDC balance, and live
  // position values. The final data point includes position_value derived from
  // current market prices so the PnL chart reflects real-time gains/losses.

  interface PortfolioHistoryBuyRow {
    amount_usdc: string;
    ticker: string;
    floor_id: number | null;
    created_at: Date;
  }

  /** CoinGecko asset IDs for price lookups */
  const COINGECKO_IDS: Record<string, string> = {
    ETH: 'ethereum',
    BTC: 'bitcoin',
    SOL: 'solana',
    NEAR: 'near',
  };

  /** Fetch current USD prices for multiple assets from CoinGecko */
  async function fetchLivePrices(tickers: string[]): Promise<Record<string, number>> {
    const uniqueTickers = [...new Set(tickers)];
    const geckoIds = uniqueTickers
      .map((t) => COINGECKO_IDS[t])
      .filter((id): id is string => id !== undefined);
    if (geckoIds.length === 0) return {};

    try {
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${geckoIds.join(',')}&vs_currencies=usd`;
      const resp = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!resp.ok) return {};
      const body = (await resp.json()) as Record<string, { usd: number }>;

      const result: Record<string, number> = {};
      for (const ticker of uniqueTickers) {
        const geckoId = COINGECKO_IDS[ticker];
        if (geckoId && body[geckoId]?.usd) {
          result[ticker] = body[geckoId].usd;
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  /** Parse ticker and decimals from a NEP-141 asset identifier */
  function parseAssetInfo(asset: string): { ticker: string; decimals: number } {
    const rawAsset = asset.replace(/^nep141:/, '');
    const assetLower = rawAsset.toLowerCase();
    if (assetLower.includes('eth')) return { ticker: 'ETH', decimals: 18 };
    if (assetLower.includes('btc') || assetLower.includes('wbtc')) return { ticker: 'BTC', decimals: 8 };
    if (assetLower.includes('sol')) return { ticker: 'SOL', decimals: 9 };
    if (assetLower.includes('near')) return { ticker: 'NEAR', decimals: 24 };
    return { ticker: rawAsset.split('.')[0]?.toUpperCase() ?? rawAsset, decimals: 18 };
  }

  app.get<{ Params: AccountParams }>(
    '/v1/accounts/:account_id/portfolio-history',
    async (request, reply) => {
      const paramResult = AccountIdParamSchema.safeParse(request.params);
      if (!paramResult.success) {
        throw new FloorApiError(
          'VALIDATION_ERROR',
          'Invalid account_id: must match /^0s[0-9a-f]{40}$/',
          false,
          400,
          { issues: paramResult.error.issues },
        );
      }

      const { account_id } = paramResult.data;

      // Fetch buy submissions, account info, USDC balance, and on-chain floors in parallel
      const [buyRows, accountRows, rawUsdcBalancePortfolio, onChainFloors] = await Promise.all([
        db<PortfolioHistoryBuyRow[]>`
          SELECT amount_usdc, ticker, floor_id, created_at
          FROM api.buy_submissions
          WHERE account_id = ${account_id} AND status = 'done'
          ORDER BY created_at ASC
        `,
        db<Array<{ created_at: Date }>>`
          SELECT created_at FROM api.accounts WHERE account_id = ${account_id}
        `,
        fetchRawUsdcBalance(account_id, nearNodeUrl, usdcContract),
        fetchOnChainFloors(account_id, nearNodeUrl, floorsContract),
      ]);

      if (accountRows.length === 0 || accountRows[0] === undefined) {
        throw new FloorApiError('ACCOUNT_NOT_FOUND', `Account ${account_id} not found`, false, 404);
      }

      // Effective USDC balance = on-chain balance - total spent in buys.
      // (Same logic as portfolio endpoint — see note about protocol < 89.)
      let currentUsdcBalance = 0;
      if (rawUsdcBalancePortfolio !== null) {
        currentUsdcBalance = Number(rawUsdcBalancePortfolio) / 1_000_000;
      }
      const accountCreatedAt = accountRows[0].created_at;

      // Determine which tickers we need prices for (from active on-chain positions)
      const activeFloors = onChainFloors.filter((f) => f.status === 'Active');
      const tickersNeeded = [...new Set(activeFloors.map((f) => parseAssetInfo(f.asset).ticker))];

      // Fetch live prices for all position assets
      const livePrices = tickersNeeded.length > 0 ? await fetchLivePrices(tickersNeeded) : {};

      // Build per-position PnL breakdown
      // Map buy_submissions by floor_id for entry price estimation
      const buyByFloorId = new Map<string, { amount_usdc: number; ticker: string }>();
      for (const row of buyRows) {
        if (row.floor_id !== null) {
          const existing = buyByFloorId.get(String(row.floor_id));
          if (!existing) {
            buyByFloorId.set(String(row.floor_id), {
              amount_usdc: Number(row.amount_usdc) / 1_000_000,
              ticker: row.ticker,
            });
          }
        }
      }

      interface PositionPnL {
        floor_id: string;
        asset: string;
        qty: string;
        entry_price: number;
        current_price: number;
        floor_price: number;
        pnl_usd: number;
        pnl_pct: number;
        protected: boolean;
      }

      let totalPositionValue = 0;
      const positionsPnl: PositionPnL[] = [];

      for (const floor of activeFloors) {
        const { ticker, decimals } = parseAssetInfo(floor.asset);
        const qtyNum = Number(floor.qty) / Math.pow(10, decimals);
        const currentPrice = livePrices[ticker] ?? 0;
        const floorPrice = Number(floor.floor_price_e6) / 1_000_000;

        // Estimate entry price from buy submission or fall back to floor price
        const buyInfo = buyByFloorId.get(String(floor.floor_id));
        const entryPrice = buyInfo && qtyNum > 0
          ? buyInfo.amount_usdc / qtyNum
          : floorPrice; // fallback: use floor price as rough entry estimate

        const positionValue = qtyNum * currentPrice;
        const entryValue = qtyNum * entryPrice;
        const pnlUsd = positionValue - entryValue;
        const pnlPct = entryValue > 0 ? (pnlUsd / entryValue) * 100 : 0;

        totalPositionValue += positionValue;

        // Format qty for display
        const qtyDisplay = qtyNum < 0.0001
          ? qtyNum.toExponential(2)
          : qtyNum.toFixed(Math.min(decimals, 8));

        positionsPnl.push({
          floor_id: String(floor.floor_id),
          asset: ticker,
          qty: qtyDisplay,
          entry_price: Math.round(entryPrice * 100) / 100,
          current_price: Math.round(currentPrice * 100) / 100,
          floor_price: Math.round(floorPrice * 100) / 100,
          pnl_usd: Math.round(pnlUsd * 100) / 100,
          pnl_pct: Math.round(pnlPct * 100) / 100,
          protected: currentPrice <= floorPrice,
        });
      }

      // Total portfolio value = USDC balance + position value
      const totalCurrentValue = currentUsdcBalance + totalPositionValue;

      // Reconstruct portfolio value over time.
      // Total spent = sum of all done buy_submissions amount_usdc (micro-units).
      // Starting value = current USDC balance + total_spent (what was funded).
      // This tracks the USDC side; the final point merges in live position value.
      const totalSpent = buyRows.reduce((sum, r) => sum + Number(r.amount_usdc) / 1_000_000, 0);
      const startingValue = currentUsdcBalance + totalSpent;

      // Build time series points
      const points: Array<{ t: number; v: number }> = [];
      let runningValue = startingValue;

      // First point: account creation
      points.push({
        t: Math.floor(accountCreatedAt.getTime() / 1000),
        v: Math.round(runningValue * 100) / 100,
      });

      // Each buy subtracts USDC but adds position value at entry.
      // For chart purposes, the value stays roughly constant at buy time
      // (USDC goes down, position value goes up by same amount).
      for (const row of buyRows) {
        const spent = Number(row.amount_usdc) / 1_000_000;
        // At purchase time, total value stays the same (USDC -> position)
        // but we record it so chart shows timeline of buys
        runningValue -= spent;
        // Add back the spent amount as position value at entry
        runningValue += spent;
        points.push({
          t: Math.floor(row.created_at.getTime() / 1000),
          v: Math.round(runningValue * 100) / 100,
        });
      }

      // Final point: current time with total portfolio value (USDC + positions at live price)
      const nowSec = Math.floor(Date.now() / 1000);
      const lastPoint = points[points.length - 1];
      if (lastPoint === undefined || lastPoint.t < nowSec - 60) {
        points.push({ t: nowSec, v: Math.round(totalCurrentValue * 100) / 100 });
      }

      // 24h change calculation against total portfolio value
      const oneDayAgo = nowSec - 86400;
      let value24hAgo = startingValue;
      for (const pt of points) {
        if (pt.t <= oneDayAgo) {
          value24hAgo = pt.v;
        }
      }
      const change24h = Math.round((totalCurrentValue - value24hAgo) * 100) / 100;
      const changePct24h = value24hAgo > 0
        ? Math.round((change24h / value24hAgo) * 10000) / 100
        : 0;

      return reply.status(200).send({
        points,
        current_value: Math.round(totalCurrentValue * 100) / 100,
        usdc_value: Math.round(currentUsdcBalance * 100) / 100,
        position_value: Math.round(totalPositionValue * 100) / 100,
        positions_pnl: positionsPnl,
        change_24h: change24h,
        change_pct_24h: changePct24h,
      });
    },
  );
}
