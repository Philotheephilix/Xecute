import { z } from 'zod';

const BASE_URL = (import.meta as ImportMeta & { env: Record<string, string> }).env['VITE_API_URL'] ?? 'http://localhost:3001';
const RELAYER_URL = (import.meta as ImportMeta & { env: Record<string, string> }).env['VITE_RELAYER_URL'] ?? 'http://localhost:3002';

// ── Zod schemas ─────────────────────────────────────────────────────────────

const ErrorEnvelopeSchema = z.object({
  error: z.string(),
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
  tx_hash: z.string(),
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
  amount: z.string(),
  floor_price_usd: z.number().optional(),
  protected_until: z.string().optional(),
  status: z.enum(['active', 'expired', 'closed']).optional(),
});

const PositionsResponseSchema = z.object({
  positions: z.array(PositionRawSchema),
  near_balance: z.string().optional(),
});

const SuggestionsSchema = z.object({
  floor_bps: z.number(),
  duration_secs: z.number(),
});

export interface Position {
  floor_id: string;
  asset: string;
  amount: string;
  floor_price_usd?: number;
  protected_until?: string;
  status: 'active' | 'expired' | 'closed';
}

export type Account = z.infer<typeof AccountSchema>;
export type DepositAddress = z.infer<typeof DepositAddressSchema>;

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
    const message = parsed.success ? parsed.data.error : `HTTP ${res.status}`;
    const code = parsed.success ? parsed.data.code : undefined;
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
 * Submit a signed wallet request to the relayer to enable trading.
 * Called against the relayer (port 3002).
 */
export async function enableTrading(
  accountId: string,
  assertion: { signature: string; credential_id: string; wallet_request: unknown },
): Promise<{ tx_hash: string }> {
  const res = await fetch(`${RELAYER_URL}/v1/relay/enable-trading`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      account_id: accountId,
      wallet_request_signed: {
        msg: JSON.stringify(assertion.wallet_request),
        proof: assertion.signature,
      },
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
 * Returns empty array if endpoint not yet available.
 */
export async function getPositions(accountId: string): Promise<Position[]> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/v1/accounts/${encodeURIComponent(accountId)}/positions`, {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.warn('[floors] positions fetch failed (network error):', err);
    return [];
  }

  if (res.status === 404 || res.status === 501) {
    console.warn('[floors] positions endpoint not yet implemented (status', res.status, ')');
    return [];
  }

  const result = await parseResponse(res, PositionsResponseSchema);
  return result.positions.map((p): Position => {
    const pos: Position = {
      floor_id: p.floor_id,
      asset: p.asset,
      amount: p.amount,
      status: p.status ?? 'active',
    };
    if (p.floor_price_usd !== undefined) pos.floor_price_usd = p.floor_price_usd;
    if (p.protected_until !== undefined) pos.protected_until = p.protected_until;
    return pos;
  });
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
    return { floor_bps: 500, duration_secs: 2592000 };
  }
  if (!res.ok) return { floor_bps: 500, duration_secs: 2592000 };
  return parseResponse(res, SuggestionsSchema);
}

/**
 * Submit an action (sell_to_floor, close) for a floor position.
 * TODO: add passkey signing
 */
export async function submitAction(params: {
  action: 'sell_to_floor' | 'close';
  floor_id: string;
  account_id: string;
}): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE_URL}/v1/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({})) as { error?: string };
    throw new ApiError(json.error ?? `HTTP ${res.status}`, res.status);
  }
  return { ok: true };
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
