import { describe, it, expect } from 'vitest';
import { bsPut, crashModelFair, estimateSigma, computeFee } from '../pricing.js';

// ---------------------------------------------------------------------------
// bsPut
// ---------------------------------------------------------------------------

describe('bsPut', () => {
  it('returns 0 for ATM call at T=0', () => {
    expect(bsPut(100, 100, 0, 0.5)).toBe(0);
  });

  it('returns 0 for zero vol', () => {
    expect(bsPut(100, 100, 1, 0)).toBe(0);
  });

  it('deep ITM put (spot well below strike) is above intrinsic value', () => {
    // K=120, S=80 deep in the money put — intrinsic = K-S = 40, BS >= intrinsic
    const put = bsPut(80, 120, 1, 0.5);
    expect(put).toBeGreaterThan(40);
  });

  it('ATM put with σ=0.5 and T=1 is in the expected range', () => {
    // ATM put S=K=100: fair value ~ K × σ × sqrt(T) / sqrt(2π) ≈ 19.9 at r=0
    const put = bsPut(100, 100, 1, 0.5);
    expect(put).toBeGreaterThan(15);
    expect(put).toBeLessThan(25);
  });

  it('OTM put (spot far above strike) is smaller than ATM put', () => {
    // K=80, S=120 — strike well below spot: put premium < ATM premium
    const otm = bsPut(120, 80, 1, 0.5);
    const atm = bsPut(100, 100, 1, 0.5);
    expect(otm).toBeGreaterThanOrEqual(0);
    expect(otm).toBeLessThan(atm);
  });

  it('always returns non-negative', () => {
    for (const spot of [50, 100, 200, 500]) {
      for (const strike of [40, 80, 100, 120, 200]) {
        for (const t of [0.1, 0.5, 1, 2]) {
          for (const sigma of [0.2, 0.5, 1.0, 2.0]) {
            expect(bsPut(spot, strike, t, sigma)).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });

  it('put increases with volatility (holding everything else fixed)', () => {
    const p1 = bsPut(3000, 2400, 30 / 365, 0.5);
    const p2 = bsPut(3000, 2400, 30 / 365, 0.8);
    const p3 = bsPut(3000, 2400, 30 / 365, 1.2);
    expect(p2).toBeGreaterThan(p1);
    expect(p3).toBeGreaterThan(p2);
  });

  it('put increases with time to expiry (holding everything else fixed)', () => {
    const p1 = bsPut(3000, 2400, 7 / 365, 0.8);
    const p2 = bsPut(3000, 2400, 30 / 365, 0.8);
    const p3 = bsPut(3000, 2400, 90 / 365, 0.8);
    expect(p2).toBeGreaterThan(p1);
    expect(p3).toBeGreaterThan(p2);
  });
});

// ---------------------------------------------------------------------------
// crashModelFair
// ---------------------------------------------------------------------------

describe('crashModelFair', () => {
  it('returns 0 for T=0', () => {
    expect(crashModelFair(2400, 0)).toBe(0);
  });

  it('returns 0 for zero strike', () => {
    expect(crashModelFair(0, 1)).toBe(0);
  });

  it('scales with sqrt of time', () => {
    const c1 = crashModelFair(2400, 1 / 12);  // 1 month
    const c4 = crashModelFair(2400, 4 / 12);  // 4 months
    // c4 / c1 should be ~2 (sqrt(4) = 2)
    const ratio = c4 / c1;
    expect(ratio).toBeCloseTo(2, 0);
  });

  it('scales linearly with strike', () => {
    const c1 = crashModelFair(1000, 1);
    const c2 = crashModelFair(2000, 1);
    expect(c2 / c1).toBeCloseTo(2, 5);
  });
});

// ---------------------------------------------------------------------------
// estimateSigma
// ---------------------------------------------------------------------------

describe('estimateSigma', () => {
  it('returns the maximum of the four inputs', () => {
    expect(estimateSigma(0.3, 0.5, 0.4, 0.6)).toBe(0.6);
    expect(estimateSigma(0.9, 0.5, 0.4, 0.6)).toBe(0.9);
    expect(estimateSigma(0.3, 0.8, 0.4, 0.6)).toBe(0.8);
    expect(estimateSigma(0.3, 0.5, 0.7, 0.6)).toBe(0.7);
  });

  it('uses sigmaMin when all realized vols are lower', () => {
    expect(estimateSigma(0.1, 0.2, 0.15, 0.5)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// computeFee — main fee computation
// ---------------------------------------------------------------------------

describe('computeFee', () => {
  const ethParams = {
    spot: 3000,
    strike: 2400,  // 20% floor discount
    timeYears: 30 / 365,
    sigma1h: 0.80,
    sigma24h: 0.80,
    sigma7d: 0.80,
    sigmaMin: 0.50,
    hazard: 0.00005,
    days: 30,
  };

  it('ETH $3000, strike $2400, 30 days — fee > 0 and reasonable', () => {
    const fee = computeFee(ethParams);
    expect(fee).toBeGreaterThan(0n);
    // Fee on $2400 protected value for 30 days should be at least a few dollars
    expect(fee).toBeGreaterThan(100_000n); // > $0.10 in e6
    // And not absurdly large (not > $500 for this position)
    expect(fee).toBeLessThan(500_000_000n); // < $500 in e6
  });

  it('fee is a bigint', () => {
    const fee = computeFee(ethParams);
    expect(typeof fee).toBe('bigint');
  });

  it('fee is rounded up to nearest cent (10_000 e6 units)', () => {
    const fee = computeFee(ethParams);
    // Must be divisible by 10_000 (1 cent in USDC e6)
    expect(fee % 10_000n).toBe(0n);
  });

  it('higher volatility → higher fee', () => {
    const lowVol = computeFee({ ...ethParams, sigma1h: 0.50, sigma24h: 0.50, sigma7d: 0.50, sigmaMin: 0.50 });
    const highVol = computeFee({ ...ethParams, sigma1h: 1.20, sigma24h: 1.20, sigma7d: 1.20, sigmaMin: 0.50 });
    expect(highVol).toBeGreaterThan(lowVol);
  });

  it('longer duration → higher fee', () => {
    const fee30d = computeFee({ ...ethParams, timeYears: 30 / 365, days: 30 });
    const fee90d = computeFee({ ...ethParams, timeYears: 90 / 365, days: 90 });
    expect(fee90d).toBeGreaterThan(fee30d);
  });

  it('shallower floor (higher strike close to spot) → higher fee than deep OTM', () => {
    // 10% floor: strike = 2700 (near the money put, high premium)
    const shallow = computeFee({ ...ethParams, strike: 2700 });
    // 30% floor: strike = 2100 (further OTM, lower BS put premium)
    const deep = computeFee({ ...ethParams, strike: 2100 });
    // Near-the-money put (K=2700) should have higher premium than deep OTM (K=2100)
    expect(shallow).toBeGreaterThan(deep);
  });

  it('minimum fee floor applies when vol-based fee is very small', () => {
    // Very short duration, deep OTM: BS price near zero, but min fee should kick in
    const fee = computeFee({
      spot: 3000,
      strike: 100,   // deep OTM (97% discount)
      timeYears: 0.001,
      sigma1h: 0.001,
      sigma24h: 0.001,
      sigma7d: 0.001,
      sigmaMin: 0.001,
      hazard: 0.0,
      days: 0.1,
    });
    // min fee = 0.0002 * 100 * 0.1 = $0.002 → rounded up to $0.01 → 10_000 e6
    expect(fee).toBeGreaterThan(0n);
  });

  it('SOL high vol scenario — fee is higher than ETH equivalent', () => {
    const ethFee = computeFee(ethParams);
    const solFee = computeFee({
      ...ethParams,
      sigma1h: 1.20,
      sigma24h: 1.20,
      sigma7d: 1.20,
      sigmaMin: 0.65,
    });
    expect(solFee).toBeGreaterThan(ethFee);
  });

  it('rounds up to cents — never rounds down', () => {
    // Run multiple variants and confirm all divisible by 10_000
    const variants = [
      { ...ethParams, timeYears: 7 / 365, days: 7 },
      { ...ethParams, timeYears: 14 / 365, days: 14 },
      { ...ethParams, spot: 1500, strike: 1200 },
      { ...ethParams, hazard: 0.001, days: 60, timeYears: 60 / 365 },
    ];
    for (const v of variants) {
      const fee = computeFee(v);
      expect(fee % 10_000n).toBe(0n);
    }
  });
});
