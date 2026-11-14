import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { FloorApiError } from '@floors/shared-server';
import type { ApiConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Shared 1Click config (mainnet)
// ---------------------------------------------------------------------------

const ONE_CLICK_BASE = 'https://1click.chaindefuser.com';
const USDC_ASSET_ID = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

const ASSET_IDS: Record<string, string> = {
  ETH: 'nep141:eth.omft.near',
  SOL: 'nep141:sol.omft.near',
  BTC: 'nep141:btc.omft.near',
};

// ---------------------------------------------------------------------------
// Ref Finance testnet pool IDs: ticker → pool_id
// A pool_id of -1 means the pool doesn't exist yet (asset is "coming soon").
// ---------------------------------------------------------------------------

const REF_POOL_IDS: Record<string, number> = {
  ETH: 365,
  SOL: -1, // SOL pool not yet deployed on testnet Ref Finance
  BTC: -1, // BTC pool not yet deployed on testnet Ref Finance
};

// ---------------------------------------------------------------------------
// Per-asset testnet token contracts — resolved at quote time
// ---------------------------------------------------------------------------

const TESTNET_TOKEN_OUT: Record<string, string> = {
  ETH: 'eth.fakes.testnet',
  SOL: 'sol.fakes.testnet',
  BTC: 'btc.fakes.testnet',
};

// ---------------------------------------------------------------------------
// Per-asset token decimals (used for display formatting)
// ---------------------------------------------------------------------------

const TOKEN_DECIMALS: Record<string, number> = {
  ETH: 18,
  SOL: 9,
  BTC: 8,
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
  /** Floor pricing — present when floor_bps + duration_secs were requested */
  floor_price_e6?: string;
  fee_usdc?: string;
  floor_price_display?: string;
  fee_display?: string;
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
// Ref Finance testnet quote helper
// ---------------------------------------------------------------------------

/**
 * Call get_return on Ref Finance to estimate swap output.
 * Uses NEAR RPC view_function (no signing needed).
 */
async function fetchRefFinanceQuote(
  nodeUrl: string,
  refContract: string,
  usdcToken: string,
  tokenOut: string,
  asset: string,
  amountUsdc: string,
): Promise<{ amountOut: string; deadline: string }> {
  const poolId = REF_POOL_IDS[asset];
  if (poolId === undefined) {
    throw new Error(`No Ref Finance pool for asset: ${asset}`);
  }

  const deadline = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 min for testnet

  // NEAR RPC view call to get_return
  const resp = await fetch(nodeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: refContract,
        method_name: 'get_return',
        args_base64: Buffer.from(JSON.stringify({
          pool_id: poolId,
          token_in: usdcToken,
          amount_in: amountUsdc,
          token_out: tokenOut,
        })).toString('base64'),
      },
    }),
  });

  if (!resp.ok) {
    throw new Error(`NEAR RPC failed: HTTP ${resp.status}`);
  }

  const data = await resp.json() as {
    result?: { result?: number[] };
    error?: { message?: string; data?: unknown };
  };

  if (data.error) {
    throw new Error(`NEAR RPC error: ${data.error.message ?? JSON.stringify(data.error.data)}`);
  }

  const resultBytes = data.result?.result;
  if (!resultBytes) {
    throw new Error('No result from Ref Finance get_return');
  }

  // Result is JSON-encoded string of the amount out (e.g. "\"12345\"")
  const resultStr = String.fromCharCode(...resultBytes);
  // Parse the JSON string — it's a quoted string like "\"12345\""
  const amountOut = JSON.parse(resultStr) as string;

  return { amountOut, deadline };
}

// ---------------------------------------------------------------------------
// Draft quote request schema
// ---------------------------------------------------------------------------

const DraftQuoteQuerySchema = z.object({
  asset: z.string().min(1).toUpperCase(),
  usd: z.string().regex(/^\d+(\.\d+)?$/, 'usd must be a positive number string'),
  /** Optional: floor depth in basis points (e.g. 500 = 5%). When present, the draft includes floor pricing. */
  floor_bps: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(100).max(5000)).optional(),
  /** Optional: floor duration in seconds. Required when floor_bps is present. */
  duration_secs: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(3600).max(31536000)).optional(),
});

// ---------------------------------------------------------------------------
// /v1/quotes schema
// ---------------------------------------------------------------------------

const QuoteRequestSchema = z.object({
  asset: z.string().min(1),
  qty: z.string().min(1),
  account_id: z.string().min(1).optional(),
  /** Optional floor parameters — if omitted, no floor quote is requested */
  floor: z.object({
    bps: z.number().int().min(100).max(5000),
    duration_secs: z.number().int().min(3600).max(31536000),
  }).optional(),
  // Legacy flat fields (kept for backwards compat) — also optional
  floor_bps: z.number().int().min(100).max(5000).optional(),
  duration_secs: z.number().int().min(3600).max(31536000).optional(),
});

function generateQuoteId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerQuoteRoutes(app: FastifyInstance, riskUrl: string, apiConfig?: ApiConfig): void {
  const isMainnet = apiConfig?.NEAR_NETWORK_ID === 'mainnet';

  /**
   * GET /v1/quotes/draft
   *
   * Returns a swap quote for buying `asset` with `usd` USD worth of USDC.
   * Mainnet: 1Click quote. Testnet/sandbox: Ref Finance get_return.
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

    const { asset, usd, floor_bps, duration_secs } = queryResult.data;
    const wantsFloorPricing = floor_bps !== undefined && duration_secs !== undefined;

    // Validate asset is supported on the current network
    if (isMainnet) {
      if (ASSET_IDS[asset] === undefined) {
        throw new FloorApiError(
          'VALIDATION_ERROR',
          `Unsupported asset: ${asset}. Supported: ${Object.keys(ASSET_IDS).join(', ')}`,
          false,
          400,
        );
      }
    } else {
      if (REF_POOL_IDS[asset] === undefined) {
        throw new FloorApiError(
          'VALIDATION_ERROR',
          `Unsupported asset: ${asset}. Supported: ${Object.keys(REF_POOL_IDS).join(', ')}`,
          false,
          400,
        );
      }
      // Pool ID -1 means asset is recognized but pool not deployed yet
      if (REF_POOL_IDS[asset] === -1) {
        return reply.status(200).send({
          quote_id: null,
          asset,
          pay_usdc: null,
          est_qty: null,
          expires_at: null,
          available: false,
          reason: `${asset} trading coming soon`,
          display: {
            you_pay: usd,
            est_amount: '—',
            expires: '—',
          },
        });
      }
    }

    // Amount in USDC micro-units (6 decimals) — bigint only, no floats
    // usd is a whole-or-decimal string like "10" or "10.50"
    const [wholePart = '0', fracPart = ''] = usd.split('.');
    const fracPadded = fracPart.slice(0, 6).padEnd(6, '0');
    const amountUsdc = (BigInt(wholePart) * 1_000_000n + BigInt(fracPadded)).toString();
    const cacheKey = wantsFloorPricing
      ? `${asset}:${amountUsdc}:f${floor_bps}:d${duration_secs}`
      : `${asset}:${amountUsdc}`;

    // Check cache
    cleanDraftCache();
    const cached = draftCache.get(cacheKey);
    if (cached !== undefined) {
      const { cached_at: _unused, deposit_address: _dep, ...rest } = cached;
      return reply.status(200).send(rest);
    }

    // Fetch quote — route by network
    let quoteData: { amountOut: string; depositAddress?: string | null; deadline: string };
    if (isMainnet) {
      // Mainnet: 1Click quote
      const destinationAsset = ASSET_IDS[asset]!;
      try {
        quoteData = await fetch1ClickQuote(destinationAsset, amountUsdc);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        request.log.error({ err, asset, amountUsdc, event: 'draft_quote_error' }, '1Click draft quote failed');
        throw new FloorApiError('RELAYER_ERROR', `1Click quote failed: ${msg}`, true, 502);
      }
    } else {
      // Testnet/sandbox: Ref Finance get_return view call
      try {
        // Resolve the output token contract for this asset
        const tokenOut = asset === 'SOL'
          ? (apiConfig?.SOL_TOKEN ?? TESTNET_TOKEN_OUT['SOL']!)
          : (apiConfig?.ETH_TOKEN ?? TESTNET_TOKEN_OUT[asset] ?? 'eth.fakes.testnet');

        const refResult = await fetchRefFinanceQuote(
          apiConfig?.NEAR_NODE_URL ?? 'https://rpc.testnet.fastnear.com',
          apiConfig?.REF_FINANCE_CONTRACT ?? 'ref-finance-101.testnet',
          apiConfig?.USDC_TOKEN ?? 'usdc.fakes.testnet',
          tokenOut,
          asset,
          amountUsdc,
        );
        quoteData = { amountOut: refResult.amountOut, depositAddress: null, deadline: refResult.deadline };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        request.log.error({ err, asset, amountUsdc, event: 'draft_quote_error' }, 'Ref Finance quote failed');
        throw new FloorApiError('RELAYER_ERROR', `Ref Finance quote failed: ${msg}`, true, 502);
      }
    }

    const quote_id = generateQuoteId();
    const expiresAt = new Date(quoteData.deadline).toISOString();
    const expiresDate = new Date(quoteData.deadline);
    const expiresInSec = Math.max(0, Math.round((expiresDate.getTime() - Date.now()) / 1000));

    // Format display values
    // est_qty: amountOut is in the destination asset's base units
    const amountOut = BigInt(quoteData.amountOut);
    const decimals = TOKEN_DECIMALS[asset] ?? 18;
    const divisor = 10n ** BigInt(decimals);

    // Format to 6 significant decimal places
    const wholeUnits = amountOut / divisor;
    const fracUnits = amountOut % divisor;
    const fracStr = fracUnits.toString().padStart(decimals, '0').slice(0, 6);
    const estAmount = `${wholeUnits.toString()}.${fracStr}`;

    const youPay = usd;

    // ── Floor pricing (optional) ─────────────────────────────────────────────
    // When floor_bps + duration_secs are present, call the risk service for
    // floor pricing so the extension can show cost before the user confirms.
    let floorPriceE6: string | undefined;
    let feeUsdc: string | undefined;
    let floorPriceDisplay: string | undefined;
    let feeDisplay: string | undefined;

    if (wantsFloorPricing) {
      try {
        const riskResp = await fetch(`${riskUrl}/v1/risk/quote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            asset: asset.toUpperCase(),
            qty: quoteData.amountOut,
            floor_bps: floor_bps,
            duration_secs: duration_secs,
            owner: 'draft',
            valid_until_ns: (BigInt(Date.now() + 30_000) * 1_000_000n).toString(),
          }),
          signal: AbortSignal.timeout(5_000),
        });

        if (riskResp.ok) {
          const riskData = await riskResp.json() as Record<string, unknown>;
          floorPriceE6 = String(riskData['floor_price_e6'] ?? '');
          feeUsdc = String(riskData['fee_usdc'] ?? '');

          // Human-readable display values
          if (floorPriceE6) {
            const cents = Number(floorPriceE6);
            const dollars = cents / 1_000_000;
            floorPriceDisplay = `$${dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
          }
          if (feeUsdc) {
            const raw = Number(feeUsdc);
            const dollars = raw / 1_000_000;
            feeDisplay = `$${dollars.toFixed(2)}`;
          }
        } else {
          // Non-fatal: log and return quote without floor pricing
          const text = await riskResp.text().catch(() => '');
          request.log.warn(
            { status: riskResp.status, body: text, event: 'draft_floor_quote_failed' },
            'Risk service returned error for draft floor quote',
          );
        }
      } catch (err) {
        // Non-fatal: risk service unreachable — return quote without floor pricing
        request.log.warn(
          { err, event: 'draft_floor_quote_error' },
          'Risk service unreachable for draft floor quote',
        );
      }
    }

    const result: CachedDraftQuote = {
      quote_id,
      asset,
      pay_usdc: amountUsdc,
      est_qty: quoteData.amountOut,
      expires_at: expiresAt,
      deposit_address: quoteData.depositAddress ?? null,
      display: {
        you_pay: youPay,
        est_amount: estAmount,
        expires: `${expiresInSec}s`,
      },
      ...(floorPriceE6 ? { floor_price_e6: floorPriceE6 } : {}),
      ...(feeUsdc ? { fee_usdc: feeUsdc } : {}),
      ...(floorPriceDisplay ? { floor_price_display: floorPriceDisplay } : {}),
      ...(feeDisplay ? { fee_display: feeDisplay } : {}),
      cached_at: Date.now(),
    };

    draftCache.set(cacheKey, result);

    request.log.info(
      { asset, amountUsdc, quote_id, estAmount, source: isMainnet ? '1click' : 'ref-finance', event: 'draft_quote_fetched' },
      isMainnet ? 'Draft quote from 1Click' : 'Draft quote from Ref Finance',
    );

    const { cached_at: _a, deposit_address: _b, ...responseBody } = result;
    return reply.status(200).send(responseBody);
  });

  /**
   * POST /v1/quotes
   *
   * Returns a spot quote. If `floor` is provided in the body, also fetches a
   * floor quote from the risk service and attaches it as `floor` in the response.
   *
   * Response (no floor): { quote_id, asset, qty }
   * Response (with floor): { quote_id, asset, qty, floor: { ... } }
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

    const { asset, qty, account_id, floor } = bodyResult.data;
    const quote_id = generateQuoteId();

    // Determine floor params — support both nested `floor` object and legacy flat fields
    const floorBps = floor?.bps ?? bodyResult.data.floor_bps;
    const floorDurationSecs = floor?.duration_secs ?? bodyResult.data.duration_secs;
    const hasFloorBps = floorBps !== undefined;
    const hasFloorDuration = floorDurationSecs !== undefined;
    const wantsFloor = floor !== undefined || (hasFloorBps && hasFloorDuration);

    // If only one of floor_bps / duration_secs is provided (but not the other), reject
    if (hasFloorBps !== hasFloorDuration && floor === undefined) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        hasFloorBps
          ? 'duration_secs is required when floor_bps is provided'
          : 'floor_bps is required when duration_secs is provided',
        false,
        400,
        { issues: [{ path: [hasFloorBps ? 'duration_secs' : 'floor_bps'], message: 'Required' }] },
      );
    }

    request.log.info({ asset, quote_id, wants_floor: wantsFloor }, 'quote_requested');

    if (!wantsFloor) {
      // Simple quote without floor
      return reply.status(200).send({ quote_id, asset, qty });
    }

    // Floor quote — call risk service
    let floorQuote: Record<string, unknown>;
    try {
      const riskResp = await fetch(`${riskUrl}/v1/risk/quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asset: asset.toUpperCase(),
          qty,
          floor_bps: floorBps,
          duration_secs: floorDurationSecs,
          owner: account_id ?? 'anonymous',
          valid_until_ns: (BigInt(Date.now() + 30_000) * 1_000_000n).toString(),
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!riskResp.ok) {
        const text = await riskResp.text().catch(() => '');
        request.log.warn({ status: riskResp.status, body: text }, 'risk service returned error');
        throw new FloorApiError(
          'FLOOR_QUOTE_UNAVAILABLE',
          `Risk service returned ${riskResp.status}`,
          true,
          503,
        );
      }

      const riskData = await riskResp.json() as Record<string, unknown>;

      floorQuote = {
        v: 1,
        id: riskData['quote_id'],
        owner: account_id ?? 'anonymous',
        floor_price_e6: riskData['floor_price_e6'],
        fee_usdc: riskData['fee_usdc'],
        sleeve: riskData['sleeve'],
        sig: riskData['sig'],
        key_id: riskData['key_id'] ?? 0,
        pyth_feed: riskData['pyth_feed'] ?? '',
        expires_at_ns: riskData['expires_at'] !== undefined
          ? (BigInt(String(riskData['expires_at'])) * 1_000_000_000n).toString()
          : undefined,
        floor_bps: floorBps,
        duration_secs: floorDurationSecs,
        // Use the NEP141 asset ID from risk service (e.g. nep141:eth.fakes.testnet)
        // not the bare ticker from the user request
        asset: riskData['asset'] ?? asset,
        qty,
      };
    } catch (err) {
      if (err instanceof FloorApiError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      request.log.warn({ err, event: 'floor_quote_fetch_failed' }, 'Risk service unreachable');
      throw new FloorApiError(
        'FLOOR_QUOTE_UNAVAILABLE',
        `Floor quote unavailable: ${msg}`,
        true,
        503,
      );
    }

    request.log.info({ asset, quote_id, floor_bps: floorBps }, 'floor_quote_generated');

    // Extract sig from floor quote for top-level response shape
    const { sig: floorSig, ...quoteBody } = floorQuote as Record<string, unknown>;
    return reply.status(200).send({ quote_id, quote: quoteBody, sig: floorSig });
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
