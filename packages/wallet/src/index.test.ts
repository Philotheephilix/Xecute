import { describe, it, expect } from 'vitest';
import {
  buildWalletRequest,
  hashWalletRequest,
  hashRequestMessage,
  buildRequestMessage,
  validateWalletRequest,
  ALLOWED_RECEIVERS,
  type ExternalCall,
  type RequestMessage,
} from './index.js';

// ---------------------------------------------------------------------------
// buildWalletRequest
// ---------------------------------------------------------------------------
describe('buildWalletRequest', () => {
  const call: ExternalCall = {
    receiver_id: 'intents.near',
    method_name: 'execute',
    args: btoa('{}'),
  };

  it('returns a WalletRequest with nonce and valid_until_ns', () => {
    const req = buildWalletRequest([call]);
    expect(typeof req.nonce).toBe('string');
    expect(typeof req.valid_until_ns).toBe('string');
    expect(req.external).toHaveLength(1);
    expect(req.external[0]?.receiver_id).toBe('intents.near');
  });

  it('valid_until_ns is in the future', () => {
    const req = buildWalletRequest([call]);
    const nowNs = BigInt(Date.now()) * 1_000_000n;
    expect(BigInt(req.valid_until_ns)).toBeGreaterThan(nowNs);
  });

  it('nonce is a valid u64 decimal string', () => {
    const req = buildWalletRequest([call]);
    const n = BigInt(req.nonce);
    expect(n).toBeGreaterThanOrEqual(0n);
    expect(n).toBeLessThanOrEqual(0xffffffffffffffffn);
  });

  it('uses custom validForMs', () => {
    const req = buildWalletRequest([call], 60_000);
    const expectedMin = BigInt(Date.now() + 55_000) * 1_000_000n;
    const expectedMax = BigInt(Date.now() + 65_000) * 1_000_000n;
    const v = BigInt(req.valid_until_ns);
    expect(v).toBeGreaterThanOrEqual(expectedMin);
    expect(v).toBeLessThanOrEqual(expectedMax);
  });
});

// ---------------------------------------------------------------------------
// hashWalletRequest
// ---------------------------------------------------------------------------
describe('hashWalletRequest', () => {
  it('returns 32 bytes', () => {
    const req = buildWalletRequest([
      { receiver_id: 'intents.near', method_name: 'execute', args: 'e30=' },
    ]);
    const hash = hashWalletRequest(req);
    expect(hash).toHaveLength(32);
    expect(hash).toBeInstanceOf(Uint8Array);
  });

  it('deterministic for same input', () => {
    const req = buildWalletRequest([
      { receiver_id: 'intents.near', method_name: 'test', args: 'e30=' },
    ]);
    const h1 = hashWalletRequest(req);
    const h2 = hashWalletRequest(req);
    expect(h1).toEqual(h2);
  });

  it('different nonce → different hash', () => {
    const base = {
      valid_until_ns: '9999999999999999',
      external: [{ receiver_id: 'intents.near', method_name: 'x', args: 'e30=' }],
    };
    const h1 = hashWalletRequest({ ...base, nonce: '100' });
    const h2 = hashWalletRequest({ ...base, nonce: '101' });
    expect(h1).not.toEqual(h2);
  });

  it('different method → different hash', () => {
    const base = {
      nonce: '1',
      valid_until_ns: '9999999999999999',
    };
    const h1 = hashWalletRequest({
      ...base,
      external: [{ receiver_id: 'intents.near', method_name: 'execute', args: 'e30=' }],
    });
    const h2 = hashWalletRequest({
      ...base,
      external: [{ receiver_id: 'intents.near', method_name: 'transfer', args: 'e30=' }],
    });
    expect(h1).not.toEqual(h2);
  });
});

// ---------------------------------------------------------------------------
// hashRequestMessage — contract format (verified against Rust test vectors)
// ---------------------------------------------------------------------------
describe('hashRequestMessage', () => {
  function toHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  it('matches Rust test vector 1: empty request, UNIX_EPOCH', () => {
    const msg: RequestMessage = {
      pay_for_gas: false,
      chain_id: 'mainnet',
      signer_id: '0s0000000000000000000000000000000000000000',
      nonce: 0,
      created_at: '1970-01-01T00:00:00Z',
      timeout_secs: 3600,
      request: {},
    };
    const hash = hashRequestMessage(msg);
    expect(toHex(hash)).toBe('a8df85c0e8793716904fd57e9bef7d83b12773508bd3c9fca554afbfb108d4b5');
  });

  it('matches Rust test vector 2: v1.signer function_call', () => {
    const msg: RequestMessage = {
      chain_id: 'mainnet',
      signer_id: '0se5eba21e8f191e1880e453794bc551dfa50a3419',
      nonce: 2845491008,
      created_at: '2026-07-07T11:13:29Z',
      timeout_secs: 3600,
      request: {
        external: [{
          receiver_id: 'v1.signer',
          actions: [{
            action: 'function_call',
            payload: {
              function_name: 'sign',
              args: 'eyJyZXF1ZXN0Ijp7InBheWxvYWRfdjIiOnsiRWNkc2EiOiIwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIn0sImRvbWFpbl9pZCI6MCwicGF0aCI6IiJ9fQ==',
              deposit: '1',
            },
          }],
        }],
      },
    };
    const hash = hashRequestMessage(msg);
    expect(toHex(hash)).toBe('7c8560b51380551676a54dac49dcc1e009af3020556cde8e1e2172782ffd6775');
  });

  it('returns 32 bytes', () => {
    const msg: RequestMessage = {
      chain_id: 'testnet',
      signer_id: '0s0000000000000000000000000000000000000000',
      nonce: 42,
      created_at: '2026-01-01T00:00:00Z',
      timeout_secs: 3600,
      request: {},
    };
    const hash = hashRequestMessage(msg);
    expect(hash).toHaveLength(32);
    expect(hash).toBeInstanceOf(Uint8Array);
  });

  it('deterministic for same input', () => {
    const msg: RequestMessage = {
      chain_id: 'testnet',
      signer_id: '0s0000000000000000000000000000000000000000',
      nonce: 1,
      created_at: '2026-01-01T00:00:00Z',
      timeout_secs: 3600,
      request: {},
    };
    const h1 = hashRequestMessage(msg);
    const h2 = hashRequestMessage(msg);
    expect(h1).toEqual(h2);
  });
});

// ---------------------------------------------------------------------------
// buildRequestMessage
// ---------------------------------------------------------------------------
describe('buildRequestMessage', () => {
  it('creates a valid RequestMessage', () => {
    const msg = buildRequestMessage('testnet', '0s1234567890abcdef1234567890abcdef12345678', [{
      receiver_id: 'intents.near',
      actions: [{
        action: 'function_call',
        payload: {
          function_name: 'add_public_key',
          args: btoa('{"public_key":"test"}'),
          deposit: '0',
        },
      }],
    }]);

    expect(msg.chain_id).toBe('testnet');
    expect(msg.signer_id).toBe('0s1234567890abcdef1234567890abcdef12345678');
    expect(typeof msg.nonce).toBe('number');
    expect(msg.nonce).toBeGreaterThanOrEqual(0);
    expect(msg.nonce).toBeLessThanOrEqual(0xFFFFFFFF);
    expect(msg.timeout_secs).toBe(3600);
    expect(msg.request.external).toHaveLength(1);
    expect(msg.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('created_at is in the past (60s lag)', () => {
    const msg = buildRequestMessage('testnet', '0s0000000000000000000000000000000000000000', []);
    const createdAtMs = new Date(msg.created_at).getTime();
    const nowMs = Date.now();
    // Should be roughly 60s in the past (allow 5s tolerance)
    expect(nowMs - createdAtMs).toBeGreaterThan(55_000);
    expect(nowMs - createdAtMs).toBeLessThan(65_000);
  });
});

// ---------------------------------------------------------------------------
// validateWalletRequest (legacy)
// ---------------------------------------------------------------------------
describe('validateWalletRequest', () => {
  function futureNs(): string {
    return (BigInt(Date.now() + 300_000) * 1_000_000n).toString();
  }

  it('valid request → empty violations', () => {
    const req = buildWalletRequest([
      { receiver_id: 'intents.near', method_name: 'execute', args: 'e30=' },
    ]);
    expect(validateWalletRequest(req)).toHaveLength(0);
  });

  it('invalid nonce → violation', () => {
    const violations = validateWalletRequest({
      nonce: 'not-a-number',
      valid_until_ns: futureNs(),
      external: [{ receiver_id: 'intents.near', method_name: 'x', args: '' }],
    });
    expect(violations.some((v) => v.includes('nonce'))).toBe(true);
  });

  it('expired valid_until_ns → violation', () => {
    const violations = validateWalletRequest({
      nonce: '1',
      valid_until_ns: '1', // 1 nanosecond — long past
      external: [{ receiver_id: 'intents.near', method_name: 'x', args: '' }],
    });
    expect(violations.some((v) => v.includes('expired'))).toBe(true);
  });

  it('empty external → violation', () => {
    const violations = validateWalletRequest({
      nonce: '1',
      valid_until_ns: futureNs(),
      external: [],
    });
    expect(violations.some((v) => v.includes('empty'))).toBe(true);
  });

  it('disallowed receiver → violation', () => {
    const violations = validateWalletRequest({
      nonce: '1',
      valid_until_ns: futureNs(),
      external: [{ receiver_id: 'evil.near', method_name: 'x', args: '' }],
    });
    expect(violations.some((v) => v.includes('allowed'))).toBe(true);
  });

  it('empty method_name → violation', () => {
    const violations = validateWalletRequest({
      nonce: '1',
      valid_until_ns: futureNs(),
      external: [{ receiver_id: 'intents.near', method_name: '', args: '' }],
    });
    expect(violations.some((v) => v.includes('method_name'))).toBe(true);
  });

  it('all allowed receivers pass', () => {
    for (const receiver of ALLOWED_RECEIVERS) {
      const violations = validateWalletRequest({
        nonce: '1',
        valid_until_ns: futureNs(),
        external: [{ receiver_id: receiver, method_name: 'execute', args: '' }],
      });
      const receiverViolations = violations.filter((v) => v.includes('receiver_id'));
      expect(receiverViolations).toHaveLength(0);
    }
  });

  it('negative attached_near → violation', () => {
    const violations = validateWalletRequest({
      nonce: '1',
      valid_until_ns: futureNs(),
      external: [
        {
          receiver_id: 'intents.near',
          method_name: 'x',
          args: '',
          attached_near: '-1',
        },
      ],
    });
    expect(violations.some((v) => v.includes('attached_near'))).toBe(true);
  });

  it('negative gas → violation', () => {
    const violations = validateWalletRequest({
      nonce: '1',
      valid_until_ns: futureNs(),
      external: [
        {
          receiver_id: 'intents.near',
          method_name: 'x',
          args: '',
          gas: '-100',
        },
      ],
    });
    expect(violations.some((v) => v.includes('gas'))).toBe(true);
  });

  it('invalid attached_near string → violation', () => {
    const violations = validateWalletRequest({
      nonce: '1',
      valid_until_ns: futureNs(),
      external: [
        {
          receiver_id: 'intents.near',
          method_name: 'x',
          args: '',
          attached_near: 'not-a-number',
        },
      ],
    });
    expect(violations.some((v) => v.includes('attached_near'))).toBe(true);
  });

  it('invalid gas string → violation', () => {
    const violations = validateWalletRequest({
      nonce: '1',
      valid_until_ns: futureNs(),
      external: [
        {
          receiver_id: 'intents.near',
          method_name: 'x',
          args: '',
          gas: 'abc',
        },
      ],
    });
    expect(violations.some((v) => v.includes('gas'))).toBe(true);
  });

  it('invalid valid_until_ns string → violation', () => {
    const violations = validateWalletRequest({
      nonce: '1',
      valid_until_ns: 'not-a-number',
      external: [{ receiver_id: 'intents.near', method_name: 'x', args: '' }],
    });
    expect(violations.some((v) => v.includes('valid_until_ns'))).toBe(true);
  });

  it('negative valid_until_ns → violation', () => {
    const violations = validateWalletRequest({
      nonce: '1',
      valid_until_ns: '-1',
      external: [{ receiver_id: 'intents.near', method_name: 'x', args: '' }],
    });
    expect(violations.some((v) => v.includes('non-negative') || v.includes('expired'))).toBe(true);
  });

  it('nonce out of range → violation', () => {
    const violations = validateWalletRequest({
      nonce: '-1',
      valid_until_ns: futureNs(),
      external: [{ receiver_id: 'intents.near', method_name: 'x', args: '' }],
    });
    expect(violations.some((v) => v.includes('nonce'))).toBe(true);
  });
});
