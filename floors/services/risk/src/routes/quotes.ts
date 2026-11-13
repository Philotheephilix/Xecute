import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FloorApiError } from '@floors/shared-server';
import { computeFee } from '../pricing.js';
import { signQuote, loadSigningKey, generateQuoteId, type QuotePayload } from '../signing.js';
import { hasCapacity, reserveCapacity } from '../capacity.js';

// ---------------------------------------------------------------------------
// Key ID constant (identifies which signing key was used; registered on-chain)
// ---------------------------------------------------------------------------

const RISK_KEY_ID = process.env['RISK_KEY_ID'] ?? 'risk-v1';

// ---------------------------------------------------------------------------
// Asset configuration
// ---------------------------------------------------------------------------

/** Pyth price feed IDs (post-August 2026 Hermes v2 format) */
const PYTH_FEED_IDS: Record<string, string> = {
  ETH: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  SOL: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  STRK: '0x6a182399ff70ccf3e06024898942028204125a819e519a335ffa4579e66cd870',
};

/** Hardcoded volatility estimates for testnet (annualized). Per spec §3 σ_min values. */
const SIGMA_MIN: Record<string, number> = {
  ETH: 0.50,
  SOL: 0.65,
  STRK: 0.90,
};

/** Hazard rates per day (bridged majors 0.005% = 0.00005). */
const HAZARD: Record<string, number> = {
  ETH: 0.00005,
  SOL: 0.00005,
  STRK: 0.001, // long-tail Tier A: 0.1% per day
};

/** Sleeve identifier per asset. */
const SLEEVE: Record<string, string> = {
  ETH: 'majors_sleeve_v1',
  SOL: 'majors_sleeve_v1',
  STRK: 'majors_sleeve_v1',
};

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const QuoteRequestSchema = z.object({
  asset: z.enum(['ETH', 'SOL', 'STRK']),
  /** Token quantity as decimal string (u128) */
  qty: z.string().regex(/^\d+$/, 'qty must be a non-negative integer string'),
  /** Floor level in basis points: 100–5000 (1%–50%) */
  floor_bps: z.number().int().min(100).max(5000),
  /** Duration in seconds: 1 day to 1 year */
  duration_secs: z.number().int().min(86_400).max(31_536_000),
  /** NEAR account ID of the floor buyer */
  owner: z.string().min(2).max(64),
});

type QuoteRequest = z.infer<typeof QuoteRequestSchema>;

// ---------------------------------------------------------------------------
// Pyth price fetching
// ---------------------------------------------------------------------------

interface PythPrice {
  price: number;
  conf: number;
  exponent: number;
  publishTime: number;
}

async function fetchPythPrice(asset: string): Promise<PythPrice> {
  const feedId = PYTH_FEED_IDS[asset];
  if (!feedId) throw new FloorApiError('ASSET_NOT_SUPPORTED', `No Pyth feed for ${asset}`, false, 400);

  const url = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedId}`;
  const resp = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) {
    throw new FloorApiError('INTERNAL_ERROR', `Pyth returned ${resp.status}`, true, 503);
  }

  const body = (await resp.json()) as {
    parsed?: Array<{
      price: { price: string; conf: string; expo: number; publish_time: number };
    }>;
  };

  const parsed = body.parsed?.[0];
  if (!parsed) {
    throw new FloorApiError('INTERNAL_ERROR', 'No Pyth price data', true, 503);
  }

  const { price: priceStr, conf: confStr, expo, publish_time } = parsed.price;
  const multiplier = Math.pow(10, expo);
  return {
    price: Number(priceStr) * multiplier,
    conf: Number(confStr) * multiplier,
    exponent: expo,
    publishTime: publish_time,
  };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

async function quoteHandler(request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply): Promise<void> {
    const bodyResult = QuoteRequestSchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError('VALIDATION_ERROR', 'Invalid quote request', false, 400, {
        issues: bodyResult.error.issues,
      });
    }

    const { asset, qty, floor_bps, duration_secs, owner } = bodyResult.data as QuoteRequest;

    // -----------------------------------------------------------------------
    // 1. Fetch spot price from Pyth
    // -----------------------------------------------------------------------
    let spotPrice: number;
    try {
      const pyth = await fetchPythPrice(asset);

      // Staleness check: reject if price is older than 60 s
      const ageSecs = Math.floor(Date.now() / 1000) - pyth.publishTime;
      if (ageSecs > 60) {
        throw new FloorApiError('INTERNAL_ERROR', 'Pyth price is stale', true, 503);
      }

      spotPrice = pyth.price;
    } catch (err) {
      if (err instanceof FloorApiError) throw err;
      throw new FloorApiError('INTERNAL_ERROR', 'Failed to fetch Pyth price', true, 503);
    }

    // -----------------------------------------------------------------------
    // 2. Compute floor strike price
    //    K = (1 − d) × spot,  where d = floor_bps / 10_000
    // -----------------------------------------------------------------------
    const d = floor_bps / 10_000;
    const strike = spotPrice * (1 - d);

    // -----------------------------------------------------------------------
    // 3. Compute fee using risk engine
    // -----------------------------------------------------------------------
    const timeYears = duration_secs / 31_536_000;
    const days = duration_secs / 86_400;
    const sigmaMin = SIGMA_MIN[asset] ?? 0.90;
    const hazard = HAZARD[asset] ?? 0.001;

    // For testnet: use sigma_min as the realized vol estimate (no live vol data)
    const fee_e6 = computeFee({
      spot: spotPrice,
      strike,
      timeYears,
      sigma1h: sigmaMin,
      sigma24h: sigmaMin,
      sigma7d: sigmaMin,
      sigmaMin,
      hazard,
      days,
    });

    // -----------------------------------------------------------------------
    // 4. Capacity check
    //    Notional = strike × qty_whole_tokens expressed in USDC e6
    //    For simplicity: floor_price_e6 = strike × 1_000_000
    // -----------------------------------------------------------------------
    const floor_price_e6 = BigInt(Math.round(strike * 1_000_000));
    const qtyBigint = BigInt(qty);

    // Approximate token decimals: ETH=18, SOL=9, STRK=18
    const TOKEN_DECIMALS: Record<string, number> = { ETH: 18, SOL: 9, STRK: 18 };
    const tokenDecimals = TOKEN_DECIMALS[asset] ?? 18;
    const divisor = 10n ** BigInt(tokenDecimals);
    // notional_e6 = ceil(qty * floor_price_e6 / 10^token_decimals)
    const notional_e6 = (qtyBigint * floor_price_e6 + divisor - 1n) / divisor;

    if (!hasCapacity(asset, notional_e6)) {
      throw new FloorApiError('RATE_LIMITED', 'Sleeve capacity exceeded for this asset', false, 400);
    }

    // -----------------------------------------------------------------------
    // 5. Build and sign the quote
    // -----------------------------------------------------------------------
    const quoteIdBytes = generateQuoteId();
    const quoteIdHex = Buffer.from(quoteIdBytes).toString('hex');
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 20); // 20-second lifetime
    const sleeve = SLEEVE[asset] ?? 'majors_sleeve_v1';

    const quotePayload: QuotePayload = {
      id: quoteIdBytes,
      owner,
      asset,
      qty: qtyBigint,
      floor_price_e6,
      fee_usdc: fee_e6,
      sleeve,
      expires_at: expiresAt,
    };

    const privateKey = loadSigningKey();
    const sig = signQuote(quotePayload, privateKey);
    const sigBase64 = Buffer.from(sig).toString('base64');

    // -----------------------------------------------------------------------
    // 6. Reserve capacity for this in-flight quote (TTL = 20 s)
    // -----------------------------------------------------------------------
    reserveCapacity(quoteIdHex, asset, notional_e6, 20_000);

    // -----------------------------------------------------------------------
    // 7. Log and respond
    // -----------------------------------------------------------------------
    request.log.info(
      {
        asset,
        owner,
        quote_id: quoteIdHex,
        floor_bps,
        duration_secs,
        fee_usdc: fee_e6.toString(),
        event: 'risk_quote_generated',
      },
      'Quote signed',
    );

    return reply.status(200).send({
      v: '1',
      quote_id: quoteIdHex,
      owner,
      asset,
      qty,
      floor_bps,
      duration_secs,
      floor_price_e6: floor_price_e6.toString(),
      fee_usdc: fee_e6.toString(),
      sleeve,
      expires_at: Number(expiresAt),                              // seconds (for signing payload)
      expires_at_ns: (BigInt(expiresAt) * 1_000_000_000n).toString(), // nanoseconds (for FloorQuote)
      sig: sigBase64,
      key_id: RISK_KEY_ID,
    });
}

// ---------------------------------------------------------------------------
// Route registration — both paths serve the same handler
// ---------------------------------------------------------------------------

export function registerRiskQuoteRoutes(app: FastifyInstance): void {
  app.post('/v1/risk/quote', quoteHandler);
  // Alias at the spec-defined internal path (doc 32 §7)
  app.post('/internal/floor-quotes', quoteHandler);
}
