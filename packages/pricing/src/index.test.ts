import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { previewFee } from './index.js';

// ---------------------------------------------------------------------------
// Hardcoded fixtures — these represent expected risk engine outputs
// ---------------------------------------------------------------------------

describe('previewFee — hardcoded fixtures', () => {
  /**
   * Fixture 1: 1 ETH (18 decimals) at $2000 floor, 500 bps floor, 417 bps platform fee
   * qty = 1_000_000_000_000_000_000n (1 ETH in wei)
   * floor_price_e6 = 2_000_000_000n (2000 USDC * 1e6)
   * floor_bps = 500 (5%)
   * platform_fee_bps = 417
   *
   * floor_usdc = ceil(1e18 * 2000e6 / 10^(18+6))
   *            = ceil(2000e24 / 1e24)
   *            = 2000_000_000n (2000 USDC in 6 decimals)
   * fee_usdc = ceil(2000_000_000n * 500 / 10000) = ceil(100_000_000) = 100_000_000
   * platform_fee = ceil(100_000_000 * 417 / 10000) = ceil(4_170_000) = 4_170_000
   * backer_fee = 100_000_000 - 4_170_000 = 95_830_000
   */
  it('fixture 1: 1 ETH @ $2000, 500bps floor, 417bps platform', () => {
    const result = previewFee({
      qty: 1_000_000_000_000_000_000n,
      token_decimals: 18,
      floor_price_e6: 2_000_000_000n,
      floor_bps: 500,
      duration_secs: 86400,
      platform_fee_bps: 417,
    });

    expect(result.floor_usdc).toBe(2_000_000_000n);
    expect(result.fee_usdc).toBe(100_000_000n);
    expect(result.platform_fee_usdc).toBe(4_170_000n);
    expect(result.backer_fee_usdc).toBe(95_830_000n);
  });

  /**
   * Fixture 2: 100 NEAR (24 decimals) at $5 floor, 1000 bps floor, 417 bps platform fee
   * qty = 100 * 10^24
   * floor_price_e6 = 5_000_000n (5 USDC * 1e6)
   * floor_bps = 1000 (10%)
   *
   * floor_usdc = ceil(100e24 * 5e6 / 10^(24+6))
   *            = ceil(500e30 / 1e30) = 500_000_000n (500 USDC in 6 decimals)
   * fee_usdc = ceil(500_000_000 * 1000 / 10000) = 50_000_000
   * platform = ceil(50_000_000 * 417 / 10000) = ceil(2_085_000) = 2_085_000
   * backer = 50_000_000 - 2_085_000 = 47_915_000
   */
  it('fixture 2: 100 NEAR @ $5, 1000bps floor, 417bps platform', () => {
    const result = previewFee({
      qty: 100n * (10n ** 24n),
      token_decimals: 24,
      floor_price_e6: 5_000_000n,
      floor_bps: 1000,
      duration_secs: 86400,
      platform_fee_bps: 417,
    });

    expect(result.floor_usdc).toBe(500_000_000n);
    expect(result.fee_usdc).toBe(50_000_000n);
    expect(result.platform_fee_usdc).toBe(2_085_000n);
    expect(result.backer_fee_usdc).toBe(47_915_000n);
  });

  /**
   * Fixture 3: fractional amount — ensures ceil rounding on floor_usdc
   * 1.000001 tokens (6 decimals) at $1.50 floor (floor_price_e6 = 1_500_000n)
   * qty = 1_000_001n (1.000001 tokens)
   * floor_usdc = ceil(1_000_001 * 1_500_000 / 10^6)
   *            = ceil(1_500_001.5) = 1_500_002n
   */
  it('fixture 3: fractional amount, ceil rounding on floor_usdc', () => {
    const result = previewFee({
      qty: 1_000_001n,
      token_decimals: 6,
      floor_price_e6: 1_500_000n,
      floor_bps: 100,
      duration_secs: 3600,
      platform_fee_bps: 417,
    });

    // floor_usdc = ceil(1_000_001 * 1_500_000 / 1e6) = ceil(1_500_001.5) = 1_500_002
    expect(result.floor_usdc).toBe(1_500_002n);
  });

  /**
   * Fixture 4: zero qty
   */
  it('fixture 4: zero qty → all zero', () => {
    const result = previewFee({
      qty: 0n,
      token_decimals: 18,
      floor_price_e6: 2_000_000_000n,
      floor_bps: 500,
      duration_secs: 3600,
      platform_fee_bps: 417,
    });

    expect(result.floor_usdc).toBe(0n);
    expect(result.fee_usdc).toBe(0n);
    expect(result.platform_fee_usdc).toBe(0n);
    expect(result.backer_fee_usdc).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('previewFee — property tests', () => {
  it('fee_usdc = platform_fee_usdc + backer_fee_usdc', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 30n }),
        fc.integer({ min: 0, max: 24 }),
        fc.bigInt({ min: 1n, max: 10_000_000_000n }),
        fc.integer({ min: 1, max: 10000 }),
        fc.integer({ min: 1, max: 10000 }),
        (qty, token_decimals, floor_price_e6, floor_bps, platform_fee_bps) => {
          const result = previewFee({
            qty,
            token_decimals,
            floor_price_e6,
            floor_bps,
            duration_secs: 86400,
            platform_fee_bps,
          });
          return result.fee_usdc === result.platform_fee_usdc + result.backer_fee_usdc;
        },
      ),
    );
  });

  it('all outputs are non-negative', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 24n }),
        fc.integer({ min: 0, max: 18 }),
        fc.bigInt({ min: 1n, max: 100_000_000n }),
        fc.integer({ min: 1, max: 10000 }),
        fc.integer({ min: 1, max: 10000 }),
        (qty, token_decimals, floor_price_e6, floor_bps, platform_fee_bps) => {
          const result = previewFee({
            qty,
            token_decimals,
            floor_price_e6,
            floor_bps,
            duration_secs: 3600,
            platform_fee_bps,
          });
          return (
            result.floor_usdc >= 0n &&
            result.fee_usdc >= 0n &&
            result.platform_fee_usdc >= 0n &&
            result.backer_fee_usdc >= 0n
          );
        },
      ),
    );
  });

  it('fee_usdc <= floor_usdc (fee cannot exceed floor value)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 24n }),
        fc.integer({ min: 0, max: 18 }),
        fc.bigInt({ min: 1n, max: 100_000_000n }),
        fc.integer({ min: 1, max: 10000 }),
        fc.integer({ min: 1, max: 10000 }),
        (qty, token_decimals, floor_price_e6, floor_bps, platform_fee_bps) => {
          const result = previewFee({
            qty,
            token_decimals,
            floor_price_e6,
            floor_bps,
            duration_secs: 3600,
            platform_fee_bps,
          });
          return result.fee_usdc <= result.floor_usdc;
        },
      ),
    );
  });

  it('higher floor_bps → higher or equal fee', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 18n }),
        fc.integer({ min: 0, max: 18 }),
        fc.bigInt({ min: 1n, max: 100_000_000n }),
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 1, max: 10000 }),
        (qty, token_decimals, floor_price_e6, floor_bps_low, platform_fee_bps) => {
          const floor_bps_high = floor_bps_low * 2;
          const low = previewFee({
            qty, token_decimals, floor_price_e6, floor_bps: floor_bps_low,
            duration_secs: 3600, platform_fee_bps,
          });
          const high = previewFee({
            qty, token_decimals, floor_price_e6, floor_bps: Math.min(floor_bps_high, 10000),
            duration_secs: 3600, platform_fee_bps,
          });
          return high.fee_usdc >= low.fee_usdc;
        },
      ),
    );
  });
});
