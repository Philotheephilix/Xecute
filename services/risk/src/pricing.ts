// ---------------------------------------------------------------------------
// Risk engine pricing — Black-Scholes + crash model + hazard loading
//
// Internal floating-point math; final output is bigint USDC e6 (rounded up).
// ---------------------------------------------------------------------------

import { createRequire } from 'node:module';
// Use built-in Math — no external dependencies

// ---------------------------------------------------------------------------
// Black-Scholes put option price (rate = 0)
// ---------------------------------------------------------------------------

/** Standard normal CDF via Horner approximation (Abramowitz & Stegun 26.2.17). */
function normCdf(x: number): number {
  const a1 = 0.31938153;
  const a2 = -0.356563782;
  const a3 = 1.781477937;
  const a4 = -1.821255978;
  const a5 = 1.330274429;
  const p = 0.2316419;
  const k = 1.0 / (1.0 + p * Math.abs(x));
  const poly = k * (a1 + k * (a2 + k * (a3 + k * (a4 + k * a5))));
  const pdf = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  const cdf = 1.0 - pdf * poly;
  return x >= 0 ? cdf : 1.0 - cdf;
}

/**
 * Black-Scholes put price with r = 0 (no cost of carry).
 * put = K × N(-d2) − spot × N(-d1)
 */
export function bsPut(
  spot: number,
  strike: number,
  timeYears: number,
  sigma: number,
  _r = 0,
): number {
  if (timeYears <= 0 || sigma <= 0 || spot <= 0 || strike <= 0) return 0;
  const sqrtT = Math.sqrt(timeYears);
  const d1 = (Math.log(spot / strike) + 0.5 * sigma * sigma * timeYears) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const put = strike * normCdf(-d2) - spot * normCdf(-d1);
  return Math.max(0, put);
}

// ---------------------------------------------------------------------------
// Crash model
// ---------------------------------------------------------------------------

/**
 * Simple crash model fair value approximation.
 * crash_model_fair(K, T) = K × 0.02 × sqrt(T)
 * Provides a floor for tail risk not captured well by log-normal BS.
 */
export function crashModelFair(strike: number, timeYears: number): number {
  if (timeYears <= 0 || strike <= 0) return 0;
  return strike * 0.02 * Math.sqrt(timeYears);
}

// ---------------------------------------------------------------------------
// Volatility estimate
// ---------------------------------------------------------------------------

/**
 * Conservative volatility: max of realised windows and asset floor.
 */
export function estimateSigma(
  sigma1h: number,
  sigma24h: number,
  sigma7d: number,
  sigmaMin: number,
): number {
  return Math.max(sigma1h, sigma24h, sigma7d, sigmaMin);
}

// ---------------------------------------------------------------------------
// Full fee computation
// ---------------------------------------------------------------------------

export interface ComputeFeeParams {
  /** current spot price (USD) */
  spot: number;
  /** K = (1−d) × min(spot_pyth, ...) i.e. the floor strike price */
  strike: number;
  /** duration in years */
  timeYears: number;
  /** 1h realized vol (annualized) */
  sigma1h: number;
  /** 24h realized vol (annualized) */
  sigma24h: number;
  /** 7d realized vol (annualized) */
  sigma7d: number;
  /** minimum vol floor (e.g. 0.60 = 60%) */
  sigmaMin: number;
  /** hazard rate per day (e.g. 0.00005 = 0.005% per day for bridged majors) */
  hazard: number;
  /** floor duration in days */
  days: number;
}

/**
 * Compute floor fee.
 *
 * σ̂ = max(σ_1h, σ_24h, σ_7d, σ_min)
 * fair = max(Put(K, T, 1.25σ̂), crash_model_fair(K, T))
 * fee_usd = 1.20 × fair + hazard × K × days
 * floor_min = $0.02 per $100 protected per day = 0.0002 × K × days
 * fee_usd = max(fee_usd, floor_min)
 * fee_e6 = ceil(fee_usd × 1_000_000) — round up to nearest micro-USDC
 * then round_up_cents: ceil(fee_e6 / 10_000) × 10_000 (USDC has 6 decimals; 1 cent = 10_000 e6)
 *
 * Returns fee in USDC e6 as bigint.
 */
export function computeFee(params: ComputeFeeParams): bigint {
  const {
    spot,
    strike,
    timeYears,
    sigma1h,
    sigma24h,
    sigma7d,
    sigmaMin,
    hazard,
    days,
  } = params;

  // Volatility estimate
  const sigmaHat = estimateSigma(sigma1h, sigma24h, sigma7d, sigmaMin);

  // Fair value = max(BS put at 1.25σ̂, crash model)
  const bsPrice = bsPut(spot, strike, timeYears, 1.25 * sigmaHat);
  const crashPrice = crashModelFair(strike, timeYears);
  const fair = Math.max(bsPrice, crashPrice);

  // Fee before floor
  const feePre = 1.20 * fair + hazard * strike * days;

  // Minimum fee floor: $0.02 per $100 protected per day = 0.0002 * K * days
  const minFee = 0.0002 * strike * days;

  const feeUsd = Math.max(feePre, minFee);

  // Convert to USDC e6, round up to nearest cent (1 cent = 0.01 USD = 10_000 e6)
  // Step 1: multiply by 1_000_000 and ceil to get micro-USDC
  const feeE6Raw = Math.ceil(feeUsd * 1_000_000);
  // Step 2: round up to nearest cent (10_000 micro-USDC per cent)
  const centUnit = 10_000;
  const feeE6 = Math.ceil(feeE6Raw / centUnit) * centUnit;

  return BigInt(feeE6);
}
