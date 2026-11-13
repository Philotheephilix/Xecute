import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { FloorApiError } from '@floors/shared-server';
import type { FloorQuote } from '@floors/types';

// ---------------------------------------------------------------------------
// Shared 1Click config
// ---------------------------------------------------------------------------

const ONE_CLICK_BASE = 'https://1click.chaindefuser.com';
const USDC_ASSET_ID = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

const ASSET_IDS: Record<string, string> = {
  ETH: 'nep141:eth.omft.near',
  SOL: 'nep141:sol.omft.near',
};

// ---------------------------------------------------------------------------
// In-memory quote cache (15s TTL)
// ---------------------------------------------------------------------------

interface CachedDraftQuote {
  quote_id: string;
  asset: string;
  pay_usdc: string;
  est_qty: string;
  expires_at: string;
  deposit_address: string | null;
  display: {
    you_pay: string;
    est_amount: string;
    expires: string;
  };
  cached_at: number;
}

const draftCache = new Map<string, CachedDraftQuote>();
const DRAFT_TTL_MS = 15_000;

function cleanDraftCache(): void {
  const now = Date.now();
  for (const [key, val] of draftCache.entries()) {
    if (now - val.cached_at > DRAFT_TTL_MS) {
      draftCache.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// 1Click quote helper
// ---------------------------------------------------------------------------

interface OneClickQuoteResponse {
  quote: {
    amountIn: string;
    amountOut: string;
    minAmountOut: string;
    depositAddress?: string;
    deadline?: string;
  };
  timestamp?: string;
}

async function fetch1ClickQuote(
  destinationAsset: string,
  amountUsdc: string,
): Promise<{ amountOut: string; depositAddress: string | null; deadline: string }> {
  const deadline = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
  const resp = await fetch(`${ONE_CLICK_BASE}/v0/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dry: true,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: USDC_ASSET_ID,
      depositType: 'INTENTS',
      destinationAsset,
      amount: amountUsdc,
      refundTo: 'floors-api.near',
      refundType: 'INTENTS',
      recipient: 'floors-api.near',
      recipientType: 'INTENTS',
      deadline,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`1Click quote failed: HTTP ${resp.status}: ${text}`);
  }

  const data = await resp.json() as OneClickQuoteResponse;
  return {
    amountOut: data.quote.amountOut,
    depositAddress: data.quote.depositAddress ?? null,
    // dry quotes don't have a deadline in the response — use the one we sent
    deadline: data.quote.deadline ?? deadline,
  };
}

// ---------------------------------------------------------------------------
// Draft quote request schema
// ---------------------------------------------------------------------------

const DraftQuoteQuerySchema = z.object({
  asset: z.string().min(1).toUpperCase(),
  usd: z.string().regex(/^\d+(\.\d+)?$/, 'usd must be a positive number string'),
});

// ---------------------------------------------------------------------------
// Legacy /v1/quotes schema
// ---------------------------------------------------------------------------

const QuoteRequestSchema = z.object({
  asset: z.string().min(1),
  qty: z.string().min(1),
  floor_bps: z.number().int().min(1).max(10000),
  duration_secs: z.number().int().positive(),
});

function generateQuoteId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerQuoteRoutes(app: FastifyInstance): void {
  /**
   * GET /v1/quotes/draft
   *
   * Returns a real 1Click quote for buying `asset` with `usd` USD worth of USDC.
   * Cached 15s per (asset, usd) pair.
   *
   * Response: { quote_id, asset, pay_usdc, est_qty, expires_at, display }
   */
  app.get('/v1/quotes/draft', async (request: FastifyRequest, reply: FastifyReply) => {
    const queryResult = DraftQuoteQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        'Invalid draft quote request',
        false,
        400,
        { issues: queryResult.error.issues },
      );
    }

    const { asset, usd } = queryResult.data;

    const destinationAsset = ASSET_IDS[asset];
    if (destinationAsset === undefined) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        `Unsupported asset: ${asset}. Supported: ${Object.keys(ASSET_IDS).join(', ')}`,
        false,
        400,
      );
    }

    // Amount in USDC micro-units (6 decimals) — bigint only, no floats
    // usd is a whole-or-decimal string like "10" or "10.50"
    const [wholePart = '0', fracPart = ''] = usd.split('.');
    const fracPadded = fracPart.slice(0, 6).padEnd(6, '0');
    const amountUsdc = (BigInt(wholePart) * 1_000_000n + BigInt(fracPadded)).toString();
    const cacheKey = `${asset}:${amountUsdc}`;

    // Check cache
    cleanDraftCache();
    const cached = draftCache.get(cacheKey);
    if (cached !== undefined) {
      const { cached_at: _unused, deposit_address: _dep, ...rest } = cached;
      return reply.status(200).send(rest);
    }

    // Fetch real quote from 1Click
    let quoteData: Awaited<ReturnType<typeof fetch1ClickQuote>>;
    try {
      quoteData = await fetch1ClickQuote(destinationAsset, amountUsdc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      request.log.error({ err, asset, amountUsdc, event: 'draft_quote_error' }, '1Click draft quote failed');
      throw new FloorApiError('RELAYER_ERROR', `1Click quote failed: ${msg}`, true, 502);
    }

    const quote_id = generateQuoteId();
    const expiresAt = new Date(quoteData.deadline).toISOString();
    const expiresDate = new Date(quoteData.deadline);
    const expiresInSec = Math.max(0, Math.round((expiresDate.getTime() - Date.now()) / 1000));

    // Format display values
    // est_qty: amountOut is in the destination asset's base units (ETH = 18 decimals)
    const amountOut = BigInt(quoteData.amountOut);
    const ETH_DECIMALS = 18n;
    const ETH_DIVISOR = 10n ** ETH_DECIMALS;

    // Format to 6 significant decimal places
    const wholeEth = amountOut / ETH_DIVISOR;
    const fracEth = amountOut % ETH_DIVISOR;
    const fracStr = fracEth.toString().padStart(18, '0').slice(0, 6);
    const estAmount = `${wholeEth.toString()}.${fracStr}`;

    const youPay = usd;

    const result: CachedDraftQuote = {
      quote_id,
      asset,
      pay_usdc: amountUsdc,
      est_qty: quoteData.amountOut,
      expires_at: expiresAt,
      deposit_address: quoteData.depositAddress,
      display: {
        you_pay: youPay,
        est_amount: estAmount,
        expires: `${expiresInSec}s`,
      },
      cached_at: Date.now(),
    };

    draftCache.set(cacheKey, result);

    request.log.info({ asset, amountUsdc, quote_id, estAmount, event: 'draft_quote_fetched' }, 'Draft quote from 1Click');

    const { cached_at: _a, deposit_address: _b, ...responseBody } = result;
    return reply.status(200).send(responseBody);
  });

  /**
   * POST /v1/quotes  (legacy — kept for backwards compat, now uses real 1Click pricing)
   */
  app.post('/v1/quotes', async (request: FastifyRequest, reply: FastifyReply) => {
    const bodyResult = QuoteRequestSchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        'Invalid quote request',
        false,
        400,
        { issues: bodyResult.error.issues },
      );
    }

    const { asset, qty, floor_bps, duration_secs } = bodyResult.data;
    const assetUpper = asset.toUpperCase();

    const expiresAtNs = BigInt(Date.now() + duration_secs * 1000) * BigInt(1_000_000);

    // Try to get real 1Click pricing; fall back to stub if unavailable
    let floor_price_e6 = '1000000'; // $1.00 stub fallback
    let fee_usdc = '100';

    const destinationAsset = ASSET_IDS[assetUpper];
    if (destinationAsset !== undefined) {
      try {
        // Use $1 USD as the quote amount to get a price indication
        const oneUsdUsdc = '1000000';
        const priceData = await fetch1ClickQuote(destinationAsset, oneUsdUsdc);
        // amountOut is qty of ETH for $1 USD → price = 1e6 / amountOut (in base units)
        const amountOut = BigInt(priceData.amountOut);
        if (amountOut > 0n) {
          // price per token in USDC micro-units
          const ETH_DECIMALS = 18n;
          const ETH_DIVISOR = 10n ** ETH_DECIMALS;
          // price_e6 = 1e6 * 1e18 / amountOut  (USDC micro-units per token)
          floor_price_e6 = ((BigInt(1_000_000) * ETH_DIVISOR) / amountOut).toString();
          fee_usdc = (BigInt(floor_price_e6) * BigInt(floor_bps) / BigInt(10_000) / BigInt(1_000_000)).toString();
          if (fee_usdc === '0') fee_usdc = '100';
        }
      } catch {
        // Keep stub fallback
      }
    }

    const quote: FloorQuote = {
      v: 1,
      id: generateQuoteId(),
      owner: 'pending.floors.near',
      asset: asset,
      qty,
      floor_bps,
      duration_secs,
      floor_price_e6,
      fee_usdc,
      sleeve: 'stub_sleeve',
      pyth_feed: '0x0000000000000000000000000000000000000000000000000000000000000000',
      expires_at_ns: expiresAtNs.toString(),
      key_id: 0,
    };

    const sig = 'stub_sig_' + quote.id.slice(0, 16);

    request.log.info({ asset: assetUpper, quote_id: quote.id }, 'quote_generated');

    return reply.status(200).send({ quote, sig });
  });
}

// Export cache accessor for submit route (to validate quote_id)
export function getDraftQuoteByQuoteId(quoteId: string): CachedDraftQuote | undefined {
  cleanDraftCache();
  for (const val of draftCache.values()) {
    if (val.quote_id === quoteId) {
      return val;
    }
  }
  return undefined;
}
