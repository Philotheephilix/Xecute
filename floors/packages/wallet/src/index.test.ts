import { describe, it, expect } from 'vitest';
import {
  buildWalletRequest,
  hashWalletRequest,
  validateWalletRequest,
  ALLOWED_RECEIVERS,
  type ExternalCall,
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
// validateWalletRequest
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
