import { z } from 'zod';

const BASE_URL = (import.meta as ImportMeta & { env: Record<string, string> }).env['VITE_API_URL'] ?? 'http://localhost:3001';

// ── Zod schemas ─────────────────────────────────────────────────────────────

const ErrorEnvelopeSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
});

const CreateAccountResponseSchema = z.object({
  account_id: z.string(),
  created: z.boolean(),
});

const AccountSchema = z.object({
  account_id: z.string(),
  public_key: z.string(),
  created_at: z.string().optional(),
  status: z.enum(['pending', 'active', 'error']).optional(),
});

export type Account = z.infer<typeof AccountSchema>;

// ── Utilities ────────────────────────────────────────────────────────────────

function generateIdempotencyKey(): string {
  return `${Date.now()}-${crypto.randomUUID()}`;
}

class ApiError extends Error {
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

export async function createAccount(
  publicKey: string,
  credentialId: string,
): Promise<{ account_id: string; created: boolean }> {
  const res = await fetch(`${BASE_URL}/v1/accounts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': generateIdempotencyKey(),
    },
    body: JSON.stringify({ public_key: publicKey, credential_id: credentialId }),
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
