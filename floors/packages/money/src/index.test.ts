import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { Amount, roundDown, roundUp } from './index.js';

// ---------------------------------------------------------------------------
// roundDown
// ---------------------------------------------------------------------------
describe('roundDown', () => {
  it('no-op when displayDecimals >= decimals', () => {
    expect(roundDown(1_500_000n, 6, 6)).toBe(1_500_000n);
    expect(roundDown(1_500_000n, 6, 8)).toBe(1_500_000n);
  });

  it('floors positive values', () => {
    // 1_500_000 with 6 decimals → 1.5; display 0 → 1
    expect(roundDown(1_500_000n, 6, 0)).toBe(1n);
    // 1_999_999 → 1 (not 2)
    expect(roundDown(1_999_999n, 6, 0)).toBe(1n);
  });

  it('floors negative values (floors away from zero toward -∞)', () => {
    // -1_500_000 with 6 decimals → -1.5; display 0 → -2
    expect(roundDown(-1_500_000n, 6, 0)).toBe(-2n);
    // -1_000_000 → -1 exactly
    expect(roundDown(-1_000_000n, 6, 0)).toBe(-1n);
  });

  it('handles partial decimal reduction', () => {
    // 1_234_567 at 6 decimals, display 3 → 1_234 (i.e. 1.234 at 3 decimals)
    expect(roundDown(1_234_567n, 6, 3)).toBe(1_234n);
  });

  it('exact value — no rounding needed', () => {
    expect(roundDown(2_000_000n, 6, 0)).toBe(2n);
  });
});

// ---------------------------------------------------------------------------
// roundUp
// ---------------------------------------------------------------------------
describe('roundUp', () => {
  it('no-op when displayDecimals >= decimals', () => {
    expect(roundUp(1_500_000n, 6, 6)).toBe(1_500_000n);
    expect(roundUp(1_500_000n, 6, 8)).toBe(1_500_000n);
  });

  it('ceils positive values', () => {
    // 1_500_000 → 2 (ceil of 1.5)
    expect(roundUp(1_500_000n, 6, 0)).toBe(2n);
    // 1_000_001 → 2 (any fractional part rounds up)
    expect(roundUp(1_000_001n, 6, 0)).toBe(2n);
  });

  it('ceils negative values (toward zero / +∞)', () => {
    // -1_500_000 → -1 (ceil of -1.5)
    expect(roundUp(-1_500_000n, 6, 0)).toBe(-1n);
    // -1_000_000 → -1 exactly
    expect(roundUp(-1_000_000n, 6, 0)).toBe(-1n);
  });

  it('handles partial decimal reduction', () => {
    // 1_234_567 at 6 decimals, display 3 → 1_235 (ceil of 1.234567 at 3 decimals)
    expect(roundUp(1_234_567n, 6, 3)).toBe(1_235n);
  });

  it('exact value — no rounding needed', () => {
    expect(roundUp(2_000_000n, 6, 0)).toBe(2n);
  });
});

// ---------------------------------------------------------------------------
// Amount.parse
// ---------------------------------------------------------------------------
describe('Amount.parse', () => {
  it('parses integer string', () => {
    const a = Amount.parse('1', 6);
    expect(a.raw).toBe(1_000_000n);
    expect(a.decimals).toBe(6);
  });

  it('parses decimal string', () => {
    const a = Amount.parse('1.5', 6);
    expect(a.raw).toBe(1_500_000n);
  });

  it('parses zero', () => {
    expect(Amount.parse('0', 6).raw).toBe(0n);
    expect(Amount.parse('0.0', 6).raw).toBe(0n);
  });

  it('pads short fractional part', () => {
    const a = Amount.parse('1.5', 6);
    expect(a.raw).toBe(1_500_000n);
  });

  it('truncates long fractional part', () => {
    const a = Amount.parse('1.5000009', 6);
    // truncates to 6 → 1.500000
    expect(a.raw).toBe(1_500_000n);
  });

  it('parses negative', () => {
    const a = Amount.parse('-1.5', 6);
    expect(a.raw).toBe(-1_500_000n);
  });

  it('throws on invalid string', () => {
    expect(() => Amount.parse('1.2.3', 6)).toThrow(SyntaxError);
    expect(() => Amount.parse('abc', 6)).toThrow(SyntaxError);
  });

  it('handles no integer part', () => {
    const a = Amount.parse('.5', 6);
    expect(a.raw).toBe(500_000n);
  });
});

// ---------------------------------------------------------------------------
// Amount.format
// ---------------------------------------------------------------------------
describe('Amount.format', () => {
  it('formats with full decimals', () => {
    expect(new Amount(1_500_000n, 6).format()).toBe('1.500000');
  });

  it('formats with fewer display decimals', () => {
    expect(new Amount(1_500_000n, 6).format(2)).toBe('1.50');
  });

  it('formats zero', () => {
    expect(new Amount(0n, 6).format()).toBe('0.000000');
  });

  it('formats negative', () => {
    expect(new Amount(-1_500_000n, 6).format()).toBe('-1.500000');
  });

  it('formats 0 displayDecimals', () => {
    expect(new Amount(1_500_000n, 6).format(0)).toBe('1');
  });

  it('formats large number', () => {
    expect(new Amount(1_234_567_890_000n, 6).format(2)).toBe('1234567.89');
  });
});

// ---------------------------------------------------------------------------
// Amount.formatUsd
// ---------------------------------------------------------------------------
describe('Amount.formatUsd', () => {
  it('formats simple dollar amount', () => {
    // 1_000_000 in 6 decimals = $1.00
    expect(new Amount(1_000_000n, 6).formatUsd()).toBe('$1.00');
  });

  it('adds thousand separators', () => {
    // 1_234_560_000 in 6 decimals = $1,234.56
    expect(new Amount(1_234_560_000n, 6).formatUsd()).toBe('$1,234.56');
  });

  it('handles zero', () => {
    expect(new Amount(0n, 6).formatUsd()).toBe('$0.00');
  });

  it('formats negative', () => {
    expect(new Amount(-1_000_000n, 6).formatUsd()).toBe('-$1.00');
  });

  it('handles 2-decimal input directly', () => {
    // 100 cents = $1.00
    expect(new Amount(100n, 2).formatUsd()).toBe('$1.00');
  });
});

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------
describe('Amount arithmetic', () => {
  const a = new Amount(1_000_000n, 6);
  const b = new Amount(500_000n, 6);

  it('add', () => {
    expect(a.add(b).raw).toBe(1_500_000n);
  });

  it('sub', () => {
    expect(a.sub(b).raw).toBe(500_000n);
  });

  it('mul', () => {
    expect(a.mul(3n).raw).toBe(3_000_000n);
  });

  it('throws on mismatched decimals', () => {
    const c = new Amount(1n, 2);
    expect(() => a.add(c)).toThrow();
    expect(() => a.sub(c)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// scale / round
// ---------------------------------------------------------------------------
describe('Amount.scale', () => {
  it('upscales without loss', () => {
    const a = new Amount(1_000_000n, 6);
    const b = a.scale(8, 'floor');
    expect(b.raw).toBe(100_000_000n);
    expect(b.decimals).toBe(8);
  });

  it('downscales with floor', () => {
    const a = new Amount(1_500_000n, 6);
    const b = a.scale(0, 'floor');
    expect(b.raw).toBe(1n);
  });

  it('downscales with ceil', () => {
    const a = new Amount(1_500_000n, 6);
    const b = a.scale(0, 'ceil');
    expect(b.raw).toBe(2n);
  });

  it('downscales with trunc', () => {
    const a = new Amount(1_500_000n, 6);
    const b = a.scale(0, 'trunc');
    expect(b.raw).toBe(1n);
  });

  it('ceil exact — no adjustment (covers scaleRaw ceil return q)', () => {
    // 2_000_000 at 6 decimals scaled to 0 with ceil: r === 0n → return q
    const a = new Amount(2_000_000n, 6);
    const b = a.scale(0, 'ceil');
    expect(b.raw).toBe(2n);
  });
});

describe('Amount.round', () => {
  it('rounds to display decimals and restores', () => {
    const a = new Amount(1_234_567n, 6);
    // round to 3 decimals with ceil: 1.234567 → 1.235 → 1_235_000
    const b = a.round(3, 'ceil');
    expect(b.decimals).toBe(6);
    expect(b.raw).toBe(1_235_000n);
  });
});

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------
describe('Amount comparisons', () => {
  const a = new Amount(1_000_000n, 6);
  const b = new Amount(2_000_000n, 6);

  it('eq', () => {
    expect(a.eq(a)).toBe(true);
    expect(a.eq(b)).toBe(false);
  });

  it('lt / lte', () => {
    expect(a.lt(b)).toBe(true);
    expect(b.lt(a)).toBe(false);
    expect(a.lte(a)).toBe(true);
  });

  it('gt / gte', () => {
    expect(b.gt(a)).toBe(true);
    expect(b.gte(b)).toBe(true);
  });

  it('isZero', () => {
    expect(new Amount(0n, 6).isZero()).toBe(true);
    expect(a.isZero()).toBe(false);
  });

  it('throws on mismatched decimals', () => {
    const c = new Amount(1n, 2);
    expect(() => a.eq(c)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Coverage gap tests
// ---------------------------------------------------------------------------
describe('coverage gaps', () => {
  it('ceil exact (r === 0n) — no adjustment needed', () => {
    // 2_000_000 at 6 decimals, display 0 → exact 2, ceil returns q without +1
    const result = roundUp(2_000_000n, 6, 0);
    expect(result).toBe(2n);
  });

  it('constructor rejects invalid decimals', () => {
    expect(() => new Amount(0n, -1)).toThrow(RangeError);
    expect(() => new Amount(0n, 1.5)).toThrow(RangeError);
  });

  it('format rejects invalid displayDecimals', () => {
    const a = new Amount(1_000_000n, 6);
    expect(() => a.format(-1)).toThrow(RangeError);
    expect(() => a.format(1.5)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// toString / toJSON
// ---------------------------------------------------------------------------
describe('toString / toJSON', () => {
  it('toString same as format()', () => {
    const a = new Amount(1_500_000n, 6);
    expect(a.toString()).toBe(a.format());
  });

  it('toJSON same as format()', () => {
    const a = new Amount(1_500_000n, 6);
    expect(a.toJSON()).toBe(a.format());
  });
});

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------
describe('property tests', () => {
  it('parse(format(x, d), d) === x for non-negative amounts', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        fc.integer({ min: 0, max: 12 }),
        (raw, decimals) => {
          const a = new Amount(raw, decimals);
          const formatted = a.format();
          const parsed = Amount.parse(formatted, decimals);
          return parsed.raw === a.raw;
        },
      ),
    );
  });

  it('parse(format(x, d), d) === x for negative amounts', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 18n), max: 0n }),
        fc.integer({ min: 0, max: 12 }),
        (raw, decimals) => {
          const a = new Amount(raw, decimals);
          const formatted = a.format();
          const parsed = Amount.parse(formatted, decimals);
          return parsed.raw === a.raw;
        },
      ),
    );
  });

  it('roundDown result never exceeds original', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.integer({ min: 1, max: 18 }),
        fc.integer({ min: 0, max: 18 }),
        (raw, decimals, display) => {
          const dd = Math.min(display, decimals);
          const result = roundDown(raw, decimals, dd);
          const shift = BigInt(10) ** BigInt(decimals - dd);
          return result * shift <= raw;
        },
      ),
    );
  });

  it('roundUp result never is below original (when scaled back)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.integer({ min: 1, max: 18 }),
        fc.integer({ min: 0, max: 18 }),
        (raw, decimals, display) => {
          const dd = Math.min(display, decimals);
          const result = roundUp(raw, decimals, dd);
          const shift = BigInt(10) ** BigInt(decimals - dd);
          return result * shift >= raw;
        },
      ),
    );
  });

  it('add is commutative', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }),
        fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }),
        fc.integer({ min: 0, max: 12 }),
        (r1, r2, dec) => {
          const a = new Amount(r1, dec);
          const b = new Amount(r2, dec);
          return a.add(b).raw === b.add(a).raw;
        },
      ),
    );
  });
});
