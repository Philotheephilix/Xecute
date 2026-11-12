import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAccount, getAccount } from './client';

// Mock import.meta.env
vi.mock('../env', () => ({ VITE_API_URL: 'http://localhost:3001' }));

describe('createAccount', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('crypto', {
      randomUUID: () => 'test-uuid-1234',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends POST to /v1/accounts with correct body', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ account_id: '0stest123', created: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await createAccount('pubkey-base58', 'cred-id-123');
    expect(result).toEqual({ account_id: '0stest123', created: true });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/accounts');
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body['public_key']).toBe('pubkey-base58');
    expect(body['credential_id']).toBe('cred-id-123');
  });

  it('includes Idempotency-Key header', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ account_id: '0stest123', created: true }), { status: 200 }),
    );

    await createAccount('pubkey', 'cred');
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeDefined();
  });

  it('throws ApiError on non-2xx response with error envelope', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Account already exists', code: 'CONFLICT' }), {
        status: 409,
      }),
    );

    await expect(createAccount('pk', 'cid')).rejects.toThrow('Account already exists');
  });

  it('throws on invalid response shape', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ unexpected: 'shape' }), { status: 200 }),
    );

    await expect(createAccount('pk', 'cid')).rejects.toThrow();
  });
});

describe('getAccount', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null on 404', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('', { status: 404 }),
    );

    const result = await getAccount('nonexistent');
    expect(result).toBeNull();
  });

  it('returns account on success', async () => {
    const account = { account_id: '0sabc123', public_key: 'pubkey', status: 'active' as const };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(account), { status: 200 }),
    );

    const result = await getAccount('0sabc123');
    expect(result).toEqual(account);
  });

  it('throws on non-404 error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Server error' }), { status: 500 }),
    );

    await expect(getAccount('0sabc123')).rejects.toThrow('Server error');
  });
});
