import { z } from 'zod';

const BASE_URL = (import.meta as ImportMeta & { env: Record<string, string> }).env['VITE_API_URL'] ?? '';
const RELAYER_URL = (import.meta as ImportMeta & { env: Record<string, string> }).env['VITE_RELAYER_URL'] ?? '';

// ── Zod schemas ─────────────────────────────────────────────────────────────

const ErrorEnvelopeSchema = z.object({
  error: z.union([
    z.string(),
    z.object({
      code: z.string().optional(),
      message: z.string(),
      retryable: z.boolean().optional(),
      details: z.unknown().optional(),
    }),
  ]),
  code: z.string().optional(),
});

const CreateAccountResponseSchema = z.object({
  account_id: z.string(),
  created: z.boolean(),
});

const ValidateInviteResponseSchema = z.object({
  valid: z.literal(true),
});

const AccountSchema = z.object({
  account_id: z.string(),
  public_key: z.string(),
  created_at: z.string().optional(),
  status: z.enum(['pending', 'active', 'error']).optional(),
});

const EnableTradingResponseSchema = z.object({
  tx_hash: z.string().nullable(),
});

const EnableTradingRequestSchema = z.object({
  wallet_request: z.unknown(),
  challenge: z.string().regex(/^[0-9a-f]{64}$/, 'challenge must be 64-char hex'),
}) as z.ZodType<{ wallet_request: unknown; challenge: string }>;

const DepositAddressSchema = z.object({
  chain: z.string(),
  asset: z.string(),
  address: z.string(),
  memo: z.string().optional(),
});

const PositionRawSchema = z.object({
  floor_id: z.string(),
  asset: z.string(),
  // API returns qty; legacy may return amount
  amount: z.string().optional(),
  qty: z.string().optional(),
  floor_price_usd: z.number().optional(),
  floor_price_e6: z.string().optional(),
  protected_until: z.string().optional(),
  expires_at: z.string().optional(),
  status: z.enum(['active', 'expired', 'closed']).optional(),
});

const PositionsResponseSchema = z.object({
  positions: z.array(PositionRawSchema),
  near_balance: z.string().optional(),
  usdc_balance: z.string().nullable().optional(),
});

const SuggestionsSchema = z.object({
  floor_bps: z.number(),
  duration_secs: z.number(),
});

const ActionChallengeResponseSchema = z.object({
  wallet_request: z.unknown(),
  challenge: z.string().regex(/^[0-9a-f]{64}$/, 'challenge must be 64-char hex'),
}) as z.ZodType<{ wallet_request: unknown; challenge: string }>;

const ActionSubmitResponseSchema = z.object({
  status_id: z.string(),
});

const PortfolioHistoryPointSchema = z.object({
  t: z.number(),
  v: z.number(),
});

const PositionPnLSchema = z.object({
  floor_id: z.string(),
  asset: z.string(),
  qty: z.string(),
  entry_price: z.number(),
  current_price: z.number(),
  floor_price: z.number(),
  pnl_usd: z.number(),
  pnl_pct: z.number(),
  protected: z.boolean(),
});

const PortfolioHistoryResponseSchema = z.object({
  points: z.array(PortfolioHistoryPointSchema),
  current_value: z.number(),
  usdc_value: z.number().optional(),
  position_value: z.number().optional(),
  positions_pnl: z.array(PositionPnLSchema).optional(),
  change_24h: z.number(),
  change_pct_24h: z.number(),
});

// ── Activity schemas ────────────────────────────────────────────────────────

const ActivityActionSchema = z.object({
  action: z.string(),
  method: z.string().nullable(),
});

const ActivityTransactionSchema = z.object({
  tx_hash: z.string(),
  receipt_id: z.string(),
  type: z.string(),
  method: z.string().nullable(),
  label: z.string(),
  receiver: z.string(),
  predecessor: z.string(),
  timestamp: z.string(),
  status: z.string(),
  deposit: z.string(),
  icon_type: z.string(),
  actions: z.array(ActivityActionSchema),
});

const ActivityBuySubmissionSchema = z.object({
  status_id: z.string(),
  ticker: z.string(),
  amount_usdc: z.string(),
  tx_hash: z.string().nullable(),
  status: z.string(),
  created_at: z.string(),
});

const ActivityResponseSchema = z.object({
  transactions: z.array(ActivityTransactionSchema),
  buy_submissions: z.array(ActivityBuySubmissionSchema),
});

// ── Public types ─────────────────────────────────────────────────────────────

export interface Position {
  floor_id: string;
  asset: string;
  amount: string;
  floor_price_usd?: number;
  protected_until?: string;
  status: 'active' | 'expired' | 'closed';
}

export interface PortfolioHistoryPoint {
  /** Unix timestamp in seconds */
  t: number;
  /** Portfolio value in USD */
  v: number;
}

export interface PositionPnL {
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

export interface PortfolioHistory {
  points: PortfolioHistoryPoint[];
  current_value: number;
  /** USDC balance portion of current_value */
  usdc_value?: number | undefined;
  /** Position value portion (sum of qty * current_price for all active floors) */
  position_value?: number | undefined;
  /** Per-position PnL breakdown */
  positions_pnl?: PositionPnL[] | undefined;
  change_24h: number;
  change_pct_24h: number;
}

export type Account = z.infer<typeof AccountSchema>;
export type DepositAddress = z.infer<typeof DepositAddressSchema>;
export type ActivityTransaction = z.infer<typeof ActivityTransactionSchema>;
export type ActivityBuySubmission = z.infer<typeof ActivityBuySubmissionSchema>;
export interface ActivityResponse {
  transactions: ActivityTransaction[];
  buy_submissions: ActivityBuySubmission[];
}

// ── Utilities ────────────────────────────────────────────────────────────────

function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function parseResponse<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  const json: unknown = await res.json().catch(() => ({}));

  if (!res.ok) {
    const parsed = ErrorEnvelopeSchema.safeParse(json);
    let message = `HTTP ${res.status}`;
    let code: string | undefined;
    if (parsed.success) {
      const err = parsed.data.error;
      if (typeof err === 'string') {
        message = err;
        code = parsed.data.code;
      } else {
        message = err.message;
        code = err.code;
      }
    }
    throw new ApiError(message, res.status, code);
  }

  return schema.parse(json);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Validate an invite code without redeeming it.
 * Throws ApiError (400) if the code is invalid or already used.
 */
export async function validateInviteCode(code: string): Promise<{ valid: true }> {
  const res = await fetch(`${BASE_URL}/v1/invites/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return parseResponse(res, ValidateInviteResponseSchema);
}

/**
 * Create a Floors smart account.
 *
 * @param compressedKeyHex - 66-char hex string of the compressed SEC1 P-256 key (33 bytes)
 * @param credentialId - base64url-encoded WebAuthn credential ID
 * @param inviteCode - optional invite code; required when the API has invite mode on
 */
export async function createAccount(
  compressedKeyHex: string,
  credentialId: string,
  inviteCode?: string,
): Promise<{ account_id: string; created: boolean }> {
  const body: Record<string, string> = {
    public_key_hex: compressedKeyHex,
    credential_id: credentialId,
  };
  if (inviteCode !== undefined) {
    body['invite_code'] = inviteCode;
  }

  const res = await fetch(`${BASE_URL}/v1/accounts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': generateIdempotencyKey(),
    },
    body: JSON.stringify(body),
  });

  return parseResponse(res, CreateAccountResponseSchema);
}

export async function getAccount(accountId: string): Promise<Account | null> {
  const res = await fetch(`${BASE_URL}/v1/accounts/${encodeURIComponent(accountId)}`, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (res.status === 404) return null;
  return parseResponse(res, AccountSchema);
}

/**
 * Fetch a wallet request to sign for enabling trading on intents.near.
 * Returns null if the API endpoint doesn't exist yet (404).
 */
export async function getEnableTradingRequest(accountId: string): Promise<{ wallet_request: unknown; challenge: string } | null> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/v1/accounts/${encodeURIComponent(accountId)}/enable-trading-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  } catch (err) {
    console.warn('[floors] enable-trading-request fetch failed (network error):', err);
    return null;
  }

  if (res.status === 404 || res.status === 501) {
    console.warn('[floors] enable-trading-request endpoint not yet implemented (status', res.status, ')');
    return null;
  }

  return parseResponse(res, EnableTradingRequestSchema);
}

/**
 * Register the user's public key with intents.near via the relayer.
 * Direct RPC call — no wallet contract signature needed.
 */
export async function enableTrading(
  accountId: string,
  publicKey: string,
): Promise<{ tx_hash: string | null }> {
  const res = await fetch(`${RELAYER_URL}/v1/relay/enable-trading`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      account_id: accountId,
      public_key: publicKey,
      idempotency_key: crypto.randomUUID(),
    }),
  });

  return parseResponse(res, EnableTradingResponseSchema);
}

/**
 * Get deposit addresses for funding an account.
 * Returns a hardcoded fallback list if the endpoint returns 404 (not yet implemented).
 */
export async function getDepositAddresses(accountId: string): Promise<DepositAddress[]> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/v1/accounts/${encodeURIComponent(accountId)}/deposit-addresses`, {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.warn('[floors] deposit-addresses fetch failed (network error):', err);
    return fallbackDepositAddresses(accountId);
  }

  if (res.status === 404 || res.status === 501) {
    console.warn('[floors] deposit-addresses endpoint not yet implemented, using fallback');
    return fallbackDepositAddresses(accountId);
  }

  const result = await parseResponse(res, z.object({ addresses: z.array(DepositAddressSchema) }));
  return result.addresses;
}

/**
 * Get floor positions for an account.
 * Returns { positions, near_balance, usdc_balance } from the API.
 */
export async function getPositions(accountId: string): Promise<{ positions: Position[]; near_balance: string | null; usdc_balance: string | null }> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/v1/accounts/${encodeURIComponent(accountId)}/positions`, {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.warn('[floors] positions fetch failed (network error):', err);
    return { positions: [], near_balance: null, usdc_balance: null };
  }

  if (res.status === 404 || res.status === 501) {
    console.warn('[floors] positions endpoint not yet implemented (status', res.status, ')');
    return { positions: [], near_balance: null, usdc_balance: null };
  }

  const result = await parseResponse(res, PositionsResponseSchema);
  const positions = result.positions.map((p): Position => {
    const pos: Position = {
      floor_id: p.floor_id,
      asset: p.asset,
      // API returns qty; some older responses use amount
      amount: p.qty ?? p.amount ?? '0',
      status: p.status ?? 'active',
    };
    if (p.floor_price_usd !== undefined) pos.floor_price_usd = p.floor_price_usd;
    if (p.protected_until !== undefined) pos.protected_until = p.protected_until;
    if (p.expires_at !== undefined && pos.protected_until === undefined) pos.protected_until = p.expires_at;
    return pos;
  });
  return { positions, near_balance: result.near_balance ?? null, usdc_balance: result.usdc_balance ?? null };
}

/**
 * Fetch recent activity (on-chain txns + buy submissions) for an account.
 * Returns empty arrays on network error or 404.
 */
export async function getActivity(accountId: string): Promise<ActivityResponse> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/v1/accounts/${encodeURIComponent(accountId)}/activity`, {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.warn('[floors] activity fetch failed (network error):', err);
    return { transactions: [], buy_submissions: [] };
  }

  if (res.status === 404 || res.status === 501) {
    console.warn('[floors] activity endpoint not available (status', res.status, ')');
    return { transactions: [], buy_submissions: [] };
  }

  return parseResponse(res, ActivityResponseSchema);
}

/**
 * Get default suggestions for floor protection settings.
 * Returns sensible fallback defaults if endpoint unavailable.
 */
export async function getSuggestions(): Promise<{ floor_bps: number; duration_secs: number }> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/v1/suggestions`);
  } catch {
    return { floor_bps: 1000, duration_secs: 86400 };
  }
  if (!res.ok) return { floor_bps: 500, duration_secs: 2592000 };
  return parseResponse(res, SuggestionsSchema);
}

/**
 * Request phase for a floor action: returns a wallet_request and challenge to sign.
 * C1: Step 1 of the two-step pattern — get challenge from API.
 */
export async function getActionChallenge(
  accountId: string,
  action: 'sell_to_floor' | 'close',
  floorId: string,
): Promise<{ wallet_request: unknown; challenge: string }> {
  const res = await fetch(
    `${BASE_URL}/v1/actions/challenge`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, floor_id: floorId, account_id: accountId }),
    },
  );
  return parseResponse(res, ActionChallengeResponseSchema);
}

/**
 * Submit a floor action (sell_to_floor, close) authenticated with a WebAuthn assertion.
 * C1: Step 3 — submit signed request.
 *
 * Two-step pattern identical to enableTrading:
 * 1. Get challenge from getActionChallenge()
 * 2. WebAuthn sign the challenge (caller provides assertion)
 * 3. Call this function with the assertion
 */
export async function submitAction(params: {
  action: 'sell_to_floor' | 'close';
  floor_id: string;
  account_id: string;
  assertion: { signature: string; credential_id: string; wallet_request: unknown };
}): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE_URL}/v1/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: params.action,
      floor_id: params.floor_id,
      account_id: params.account_id,
      signature: params.assertion.signature,
      credential_id: params.assertion.credential_id,
      wallet_request: params.assertion.wallet_request,
    }),
  });
  await parseResponse(res, ActionSubmitResponseSchema);
  return { ok: true };
}

/**
 * Fetch portfolio value history for an account.
 * Returns { points, current_value, change_24h, change_pct_24h }.
 * Returns null on network error or if the endpoint is not yet deployed.
 */
export async function getPortfolioHistory(accountId: string): Promise<PortfolioHistory | null> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/v1/accounts/${encodeURIComponent(accountId)}/portfolio-history`, {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.warn('[floors] portfolio-history fetch failed (network error):', err);
    return null;
  }

  if (res.status === 404 || res.status === 501) {
    console.warn('[floors] portfolio-history endpoint not yet implemented (status', res.status, ')');
    return null;
  }

  return parseResponse(res, PortfolioHistoryResponseSchema);
}

function fallbackDepositAddresses(accountId: string): DepositAddress[] {
  // When the API doesn't have this endpoint yet, provide the NEAR address as the
  // primary destination. Users can bridge USDC from other chains via NEAR Intents.
  return [
    { chain: 'NEAR', asset: 'USDC', address: accountId },
    { chain: 'Ethereum', asset: 'USDC', address: accountId, memo: 'via NEAR Intents bridge' },
    { chain: 'Base', asset: 'USDC', address: accountId, memo: 'via NEAR Intents bridge' },
    { chain: 'Arbitrum', asset: 'USDC', address: accountId, memo: 'via NEAR Intents bridge' },
    { chain: 'Solana', asset: 'USDC', address: accountId, memo: 'via NEAR Intents bridge' },
  ];
}
