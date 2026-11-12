import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  buildIntentsMessage,
  deriveChallenge,
  verifyAgainstSheet,
  type IntentPayload,
  type Transfer,
  type TokenDiff,
} from './index.js';

// ---------------------------------------------------------------------------
// buildIntentsMessage
// ---------------------------------------------------------------------------
describe('buildIntentsMessage', () => {
  it('serialises a transfer intent', () => {
    const t: Transfer = {
      type: 'Transfer',
      receiver_id: 'floors.near',
      amount: '1.5',
      asset: 'nep141:eth.omft.near',
      msg: '{}',
    };
    const msg = buildIntentsMessage([t]);
    const parsed = JSON.parse(msg) as unknown[];
    expect(parsed).toHaveLength(1);
    expect((parsed[0] as Transfer).type).toBe('Transfer');
  });

  it('serialises a token diff intent', () => {
    const td: TokenDiff = {
      type: 'TokenDiff',
      diff: { 'nep141:eth.omft.near': '-1.5', 'usdc.near': '1500' },
    };
    const msg = buildIntentsMessage([td]);
    const parsed = JSON.parse(msg) as unknown[];
    expect((parsed[0] as TokenDiff).diff['nep141:eth.omft.near']).toBe('-1.5');
  });
});

// ---------------------------------------------------------------------------
// deriveChallenge — golden vector
// ---------------------------------------------------------------------------
describe('deriveChallenge', () => {
  it('produces consistent challenge for known payload', () => {
    const nonce = new Uint8Array(32);
    // nonce = [1,2,3,...,32]
    for (let i = 0; i < 32; i++) nonce[i] = i + 1;

    const payload: IntentPayload = {
      message: '[{"type":"Transfer","receiver_id":"floors.near","amount":"1.000000","asset":"nep141:eth.omft.near","msg":"{}"}]',
      nonce,
      recipient: 'intents.near',
    };

    const challenge = deriveChallenge(payload);

    // Must be 32 bytes
    expect(challenge).toHaveLength(32);

    // Stable across calls
    const challenge2 = deriveChallenge(payload);
    expect(challenge).toEqual(challenge2);

    // Golden vector: record the hex and assert it is unchanged
    const hex = Array.from(challenge).map((b) => b.toString(16).padStart(2, '0')).join('');
    // This is a computed golden — we store it and assert stability
    expect(hex).toHaveLength(64); // 32 bytes = 64 hex chars
    // Store the expected value derived from the first run:
    expect(hex).toMatchSnapshot();
  });

  it('different nonce → different challenge', () => {
    const nonce1 = new Uint8Array(32).fill(1);
    const nonce2 = new Uint8Array(32).fill(2);

    const base: Omit<IntentPayload, 'nonce'> = {
      message: '[]',
      recipient: 'intents.near',
    };

    const c1 = deriveChallenge({ ...base, nonce: nonce1 });
    const c2 = deriveChallenge({ ...base, nonce: nonce2 });
    expect(c1).not.toEqual(c2);
  });

  it('different message → different challenge', () => {
    const nonce = new Uint8Array(32).fill(0);
    const c1 = deriveChallenge({ message: '[]', nonce, recipient: 'intents.near' });
    const c2 = deriveChallenge({ message: '[{}]', nonce, recipient: 'intents.near' });
    expect(c1).not.toEqual(c2);
  });

  it('different recipient → different challenge', () => {
    const nonce = new Uint8Array(32).fill(0);
    const c1 = deriveChallenge({ message: '[]', nonce, recipient: 'intents.near' });
    const c2 = deriveChallenge({ message: '[]', nonce, recipient: 'other.near' });
    expect(c1).not.toEqual(c2);
  });

  it('callback_url presence changes challenge', () => {
    const nonce = new Uint8Array(32).fill(0);
    const base: IntentPayload = { message: '[]', nonce, recipient: 'intents.near' };
    const c1 = deriveChallenge(base);
    const c2 = deriveChallenge({ ...base, callback_url: 'https://example.com' });
    expect(c1).not.toEqual(c2);
  });
});

// ---------------------------------------------------------------------------
// verifyAgainstSheet
// ---------------------------------------------------------------------------
describe('verifyAgainstSheet', () => {
  function makeTransferPayload(
    asset: string,
    amount: string,
    receiver_id = 'floors.near',
  ): IntentPayload {
    const msg = buildIntentsMessage([
      { type: 'Transfer', receiver_id, amount, asset, msg: '{}' },
    ]);
    return { message: msg, nonce: new Uint8Array(32), recipient: 'intents.near' };
  }

  it('returns empty array when payload matches sheet', () => {
    const payload = makeTransferPayload('nep141:eth.omft.near', '1.5');
    const mismatches = verifyAgainstSheet(payload, {
      asset: 'nep141:eth.omft.near',
      qty: '1.5',
    });
    expect(mismatches).toHaveLength(0);
  });

  it('detects asset mismatch', () => {
    const payload = makeTransferPayload('nep141:eth.omft.near', '1.5');
    const mismatches = verifyAgainstSheet(payload, {
      asset: 'nep141:btc.omft.near',
      qty: '1.5',
    });
    expect(mismatches.length).toBeGreaterThan(0);
    expect(mismatches.some((m) => m.includes('asset'))).toBe(true);
  });

  it('detects qty mismatch', () => {
    const payload = makeTransferPayload('nep141:eth.omft.near', '1.5');
    const mismatches = verifyAgainstSheet(payload, {
      asset: 'nep141:eth.omft.near',
      qty: '2.0',
    });
    expect(mismatches.length).toBeGreaterThan(0);
    expect(mismatches.some((m) => m.includes('amount') || m.includes('qty'))).toBe(true);
  });

  it('detects receiver_id mismatch', () => {
    const payload = makeTransferPayload('nep141:eth.omft.near', '1.5', 'bad.near');
    const mismatches = verifyAgainstSheet(payload, {
      asset: 'nep141:eth.omft.near',
      qty: '1.5',
      receiver_id: 'floors.near',
    });
    expect(mismatches.length).toBeGreaterThan(0);
  });

  it('invalid JSON → returns error', () => {
    const payload: IntentPayload = {
      message: 'not-json',
      nonce: new Uint8Array(32),
      recipient: 'intents.near',
    };
    const mismatches = verifyAgainstSheet(payload, { asset: 'x', qty: '1' });
    expect(mismatches.length).toBeGreaterThan(0);
  });

  it('empty intents array → returns error', () => {
    const payload: IntentPayload = {
      message: '[]',
      nonce: new Uint8Array(32),
      recipient: 'intents.near',
    };
    const mismatches = verifyAgainstSheet(payload, { asset: 'x', qty: '1' });
    expect(mismatches.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Property test: any field change → verifyAgainstSheet returns non-empty
// ---------------------------------------------------------------------------
describe('property: field tamper detection', () => {
  const baseAsset = 'nep141:eth.omft.near';
  const baseQty = '1.000000';
  const baseReceiver = 'floors.near';

  function makePayload(asset: string, qty: string, receiver: string): IntentPayload {
    const msg = buildIntentsMessage([
      { type: 'Transfer', receiver_id: receiver, amount: qty, asset, msg: '{}' },
    ]);
    return { message: msg, nonce: new Uint8Array(32), recipient: 'intents.near' };
  }

  it('tampered asset detected', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => s !== baseAsset),
        (tamperedAsset) => {
          const payload = makePayload(tamperedAsset, baseQty, baseReceiver);
          const mismatches = verifyAgainstSheet(payload, {
            asset: baseAsset,
            qty: baseQty,
            receiver_id: baseReceiver,
          });
          return mismatches.length > 0;
        },
      ),
    );
  });

  it('tampered qty detected', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => s !== baseQty),
        (tamperedQty) => {
          const payload = makePayload(baseAsset, tamperedQty, baseReceiver);
          const mismatches = verifyAgainstSheet(payload, {
            asset: baseAsset,
            qty: baseQty,
            receiver_id: baseReceiver,
          });
          return mismatches.length > 0;
        },
      ),
    );
  });

  it('tampered receiver detected', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => s !== baseReceiver),
        (tamperedReceiver) => {
          const payload = makePayload(baseAsset, baseQty, tamperedReceiver);
          const mismatches = verifyAgainstSheet(payload, {
            asset: baseAsset,
            qty: baseQty,
            receiver_id: baseReceiver,
          });
          return mismatches.length > 0;
        },
      ),
    );
  });
});
