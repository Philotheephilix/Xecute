import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encodeBase58, createPasskey, signWithPasskey } from './passkey';

// ── encodeBase58 ─────────────────────────────────────────────────────────────

describe('encodeBase58', () => {
  it('encodes empty bytes to empty string', () => {
    expect(encodeBase58(new Uint8Array(0))).toBe('');
  });

  it('encodes single zero byte as "1"', () => {
    expect(encodeBase58(new Uint8Array([0]))).toBe('1');
  });

  it('encodes known value correctly', () => {
    // [0, 0, 1] → two leading zeros → "11" + base58 of 1
    const result = encodeBase58(new Uint8Array([0, 0, 1]));
    expect(result.startsWith('11')).toBe(true);
    expect(result.length).toBeGreaterThan(2);
  });

  it('produces only valid base58 characters', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 255, 128, 64]);
    const result = encodeBase58(bytes);
    expect(/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/.test(result)).toBe(true);
  });
});

// ── createPasskey ─────────────────────────────────────────────────────────────

describe('createPasskey', () => {
  const mockRawPublicKey = new Uint8Array(65).fill(4); // uncompressed EC point sentinel
  const mockCredential = {
    type: 'public-key',
    id: 'mock-credential-id',
    rawId: new Uint8Array(16).fill(1).buffer,
    response: {
      clientDataJSON: new Uint8Array(32).buffer,
      attestationObject: new Uint8Array(64).buffer,
      getPublicKey: () => mockRawPublicKey.buffer,
      getPublicKeyAlgorithm: () => -7,
    } as unknown as AuthenticatorAttestationResponse,
    getClientExtensionResults: () => ({}),
    authenticatorAttachment: null,
    toJSON: () => ({}),
  } as unknown as PublicKeyCredential;

  beforeEach(() => {
    vi.stubGlobal('navigator', {
      credentials: {
        create: vi.fn().mockResolvedValue(mockCredential),
      },
    });
    vi.stubGlobal('window', {
      location: { hostname: 'localhost' },
    });
    vi.stubGlobal('crypto', {
      getRandomValues: (arr: Uint8Array) => {
        arr.fill(42);
        return arr;
      },
      randomUUID: () => 'test-uuid',
    });
  });

  it('calls navigator.credentials.create', async () => {
    await createPasskey();
    expect(navigator.credentials.create).toHaveBeenCalledOnce();
  });

  it('returns credentialId as base64url string', async () => {
    const { credentialId } = await createPasskey();
    // base64url — no +, /, or =
    expect(/^[A-Za-z0-9\-_]+$/.test(credentialId)).toBe(true);
  });

  it('returns publicKey as base58 string', async () => {
    const { publicKey } = await createPasskey();
    expect(/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/.test(publicKey)).toBe(true);
  });

  it('throws when credentials.create returns null', async () => {
    (navigator.credentials.create as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(createPasskey()).rejects.toThrow();
  });
});

// ── signWithPasskey ──────────────────────────────────────────────────────────

describe('signWithPasskey', () => {
  const mockSignature = new Uint8Array(64).fill(7);
  const mockAuthData = new Uint8Array(37).fill(8);
  const mockClientData = new Uint8Array(36).fill(9);

  const mockAssertion = {
    type: 'public-key',
    id: 'mock-credential-id',
    rawId: new Uint8Array(16).fill(1).buffer,
    response: {
      signature: mockSignature.buffer,
      authenticatorData: mockAuthData.buffer,
      clientDataJSON: mockClientData.buffer,
    } as unknown as AuthenticatorAssertionResponse,
    getClientExtensionResults: () => ({}),
    authenticatorAttachment: null,
    toJSON: () => ({}),
  } as unknown as PublicKeyCredential;

  beforeEach(() => {
    vi.stubGlobal('navigator', {
      credentials: {
        get: vi.fn().mockResolvedValue(mockAssertion),
      },
    });
    vi.stubGlobal('crypto', {
      getRandomValues: (arr: Uint8Array) => { arr.fill(42); return arr; },
      randomUUID: () => 'test-uuid',
    });
  });

  it('calls navigator.credentials.get', async () => {
    const challenge = new Uint8Array(32).fill(1);
    // Use a valid base64url credentialId (base64 of 16 bytes of 0x01)
    const credentialId = btoa(String.fromCharCode(...new Uint8Array(16).fill(1)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    await signWithPasskey(challenge, credentialId);
    expect(navigator.credentials.get).toHaveBeenCalledOnce();
  });

  it('returns signature, authenticatorData, clientDataJSON', async () => {
    const challenge = new Uint8Array(32).fill(1);
    const credentialId = btoa(String.fromCharCode(...new Uint8Array(16).fill(1)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const result = await signWithPasskey(challenge, credentialId);
    expect(result.signature).toBeInstanceOf(Uint8Array);
    expect(result.authenticatorData).toBeInstanceOf(Uint8Array);
    expect(result.clientDataJSON).toBeInstanceOf(Uint8Array);
  });
});
