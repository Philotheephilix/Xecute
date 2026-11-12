import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { verifyRegistry, _canonicalJson, type Registry, type Token } from './index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const sampleToken: Token = {
  asset_id: 'nep141:eth.omft.near',
  ticker: 'ETH',
  name: 'Ethereum',
  decimals: 18,
  display_decimals: 4,
  pyth_feed: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  eligible: true,
  products: [
    { floor_bps: 500, duration_secs: 86400 },
    { floor_bps: 1000, duration_secs: 604800 },
  ],
};

function makeRegistry(privKey: Uint8Array, overrides?: Partial<Omit<Registry, 'sig'>>): Registry {
  const base = {
    version: 1,
    published_at_ns: '1700000000000000000',
    tokens: [sampleToken],
    ...overrides,
  };
  const canonical = JSON.stringify(base);
  const message = new TextEncoder().encode(canonical);
  const hash = sha256(message);
  const sig = ed25519.sign(hash, privKey);
  return { ...base, sig: base64Encode(sig) };
}

// ---------------------------------------------------------------------------
// Basic sign + verify
// ---------------------------------------------------------------------------

describe('verifyRegistry', () => {
  it('verifies a correctly signed registry', () => {
    const privKey = ed25519.utils.randomPrivateKey();
    const pubKey = ed25519.getPublicKey(privKey);
    const registry = makeRegistry(privKey);

    expect(verifyRegistry(registry, pubKey)).toBe(true);
  });

  it('rejects wrong public key', () => {
    const privKey = ed25519.utils.randomPrivateKey();
    const wrongPrivKey = ed25519.utils.randomPrivateKey();
    const wrongPubKey = ed25519.getPublicKey(wrongPrivKey);
    const registry = makeRegistry(privKey);

    expect(verifyRegistry(registry, wrongPubKey)).toBe(false);
  });

  it('rejects invalid signature string', () => {
    const privKey = ed25519.utils.randomPrivateKey();
    const pubKey = ed25519.getPublicKey(privKey);
    const registry = makeRegistry(privKey);
    const tampered: Registry = { ...registry, sig: 'invalidsig' };

    expect(verifyRegistry(tampered, pubKey)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tamper tests — every field change should cause verification to fail
// ---------------------------------------------------------------------------

describe('verifyRegistry — tamper detection', () => {
  const privKey = ed25519.utils.randomPrivateKey();
  const pubKey = ed25519.getPublicKey(privKey);
  const registry = makeRegistry(privKey);

  it('tamper version → fails', () => {
    const tampered: Registry = { ...registry, version: registry.version + 1 };
    expect(verifyRegistry(tampered, pubKey)).toBe(false);
  });

  it('tamper published_at_ns → fails', () => {
    const tampered: Registry = { ...registry, published_at_ns: '9999999999999999999' };
    expect(verifyRegistry(tampered, pubKey)).toBe(false);
  });

  it('tamper token asset_id → fails', () => {
    const tampered: Registry = {
      ...registry,
      tokens: [{ ...sampleToken, asset_id: 'nep141:evil.near' }],
    };
    expect(verifyRegistry(tampered, pubKey)).toBe(false);
  });

  it('tamper token ticker → fails', () => {
    const tampered: Registry = {
      ...registry,
      tokens: [{ ...sampleToken, ticker: 'EVIL' }],
    };
    expect(verifyRegistry(tampered, pubKey)).toBe(false);
  });

  it('tamper token decimals → fails', () => {
    const tampered: Registry = {
      ...registry,
      tokens: [{ ...sampleToken, decimals: 6 }],
    };
    expect(verifyRegistry(tampered, pubKey)).toBe(false);
  });

  it('tamper token eligible → fails', () => {
    const tampered: Registry = {
      ...registry,
      tokens: [{ ...sampleToken, eligible: false }],
    };
    expect(verifyRegistry(tampered, pubKey)).toBe(false);
  });

  it('tamper product floor_bps → fails', () => {
    const tampered: Registry = {
      ...registry,
      tokens: [
        {
          ...sampleToken,
          products: [{ floor_bps: 9999, duration_secs: 86400 }],
        },
      ],
    };
    expect(verifyRegistry(tampered, pubKey)).toBe(false);
  });

  it('add extra token → fails', () => {
    const evilToken: Token = { ...sampleToken, asset_id: 'nep141:evil.near', ticker: 'EVIL' };
    const tampered: Registry = { ...registry, tokens: [...registry.tokens, evilToken] };
    expect(verifyRegistry(tampered, pubKey)).toBe(false);
  });

  it('remove all tokens → fails', () => {
    const tampered: Registry = { ...registry, tokens: [] };
    expect(verifyRegistry(tampered, pubKey)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// canonicalJson excludes sig
// ---------------------------------------------------------------------------

describe('_canonicalJson', () => {
  it('excludes the sig field', () => {
    const privKey = ed25519.utils.randomPrivateKey();
    const registry = makeRegistry(privKey);
    const canonical = _canonicalJson(registry);
    expect(canonical).not.toContain('"sig"');
    expect(canonical).toContain('"version"');
    expect(canonical).toContain('"tokens"');
  });
});
