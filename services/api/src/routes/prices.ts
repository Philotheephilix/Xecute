import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { FloorApiError } from '@floors/shared-server';

// ---------------------------------------------------------------------------
// CoinGecko ticker → ID mapping
// ---------------------------------------------------------------------------

const COINGECKO_IDS: Record<string, string> = {
  ETH: 'ethereum',
  BTC: 'bitcoin',
  SOL: 'solana',
  NEAR: 'near',
  STRK: 'starknet',
};

// Reverse map: coingecko id → ticker
const TICKER_BY_CG_ID: Record<string, string> = {};
for (const [ticker, cgId] of Object.entries(COINGECKO_IDS)) {
  TICKER_BY_CG_ID[cgId] = ticker;
}

// ---------------------------------------------------------------------------
// In-memory price cache (30s TTL)
// ---------------------------------------------------------------------------

interface CachedPriceEntry {
  usd: number;
  usd_24h_change: number | null;
}

interface CacheSlot {
  prices: Record<string, CachedPriceEntry>;
  fetched_at: number;
}

const CACHE_TTL_MS = 30_000;
let priceCache: CacheSlot | null = null;

function isCacheFresh(): boolean {
  return priceCache !== null && Date.now() - priceCache.fetched_at < CACHE_TTL_MS;
}

// ---------------------------------------------------------------------------
// CoinGecko fetch
// ---------------------------------------------------------------------------

async function fetchCoinGeckoPrices(
  cgIds: string[],
): Promise<Record<string, { usd: number; usd_24h_change?: number }>> {
  const idsParam = cgIds.join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${idsParam}&vs_currencies=usd&include_24hr_change=true`;

  const resp = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  });

  if (!resp.ok) {
    throw new Error(`CoinGecko returned ${resp.status}`);
  }

  return (await resp.json()) as Record<string, { usd: number; usd_24h_change?: number }>;
}

// ---------------------------------------------------------------------------
// Pyth fallback — fetch spot prices via Hermes v2
// ---------------------------------------------------------------------------

const PYTH_FEED_IDS: Record<string, string> = {
  ETH: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  BTC: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  SOL: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  NEAR: '0xc415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750',
  STRK: '0x6a182399ff70ccf3e06024898942028204125a819e519a335ffa4579e66cd870',
};

async function fetchPythPrices(
  tickers: string[],
): Promise<Record<string, CachedPriceEntry>> {
  const feedIds = tickers
    .map((t) => PYTH_FEED_IDS[t])
    .filter((id): id is string => id !== undefined);

  if (feedIds.length === 0) return {};

  const idsParam = feedIds.map((id) => `ids[]=${id}`).join('&');
  const url = `https://hermes.pyth.network/v2/updates/price/latest?${idsParam}`;

  const headers: Record<string, string> = { Accept: 'application/json' };
  const pythApiKey = process.env['PYTH_API_KEY'];
  if (pythApiKey) {
    headers['X-Pyth-API-Key'] = pythApiKey;
  }

  const resp = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(5_000),
  });

  if (!resp.ok) {
    throw new Error(`Pyth returned ${resp.status}`);
  }

  const body = (await resp.json()) as {
    parsed?: Array<{
      id: string;
      price: { price: string; expo: number };
    }>;
  };

  const result: Record<string, CachedPriceEntry> = {};
  const feedToTicker = new Map<string, string>();
  for (const t of tickers) {
    const fid = PYTH_FEED_IDS[t];
    if (fid) feedToTicker.set(fid.replace(/^0x/, ''), t);
  }

  for (const entry of body.parsed ?? []) {
    const ticker = feedToTicker.get(entry.id.replace(/^0x/, ''));
    if (!ticker) continue;
    const multiplier = Math.pow(10, entry.price.expo);
    result[ticker] = {
      usd: Number(entry.price.price) * multiplier,
      usd_24h_change: null, // Pyth does not provide 24h change
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Unified fetch: CoinGecko primary, Pyth fallback
// ---------------------------------------------------------------------------

async function refreshPrices(tickers: string[]): Promise<Record<string, CachedPriceEntry>> {
  const cgIds = tickers
    .map((t) => COINGECKO_IDS[t])
    .filter((id): id is string => id !== undefined);

  const prices: Record<string, CachedPriceEntry> = {};

  // Primary: CoinGecko
  try {
    if (cgIds.length > 0) {
      const cgData = await fetchCoinGeckoPrices(cgIds);
      for (const [cgId, data] of Object.entries(cgData)) {
        const ticker = TICKER_BY_CG_ID[cgId];
        if (ticker) {
          prices[ticker] = {
            usd: data.usd,
            usd_24h_change: data.usd_24h_change ?? null,
          };
        }
      }
    }
  } catch {
    // CoinGecko failed — fall through to Pyth for missing tickers
  }

  // Fallback: Pyth for any tickers still missing
  const missing = tickers.filter((t) => !(t in prices));
  if (missing.length > 0) {
    try {
      const pythPrices = await fetchPythPrices(missing);
      Object.assign(prices, pythPrices);
    } catch {
      // Both sources failed for these tickers — they stay absent from response
    }
  }

  return prices;
}

// ---------------------------------------------------------------------------
// Query schema
// ---------------------------------------------------------------------------

const PriceQuerySchema = z.object({
  assets: z.string().min(1, 'assets query param required'),
});

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerPriceRoutes(app: FastifyInstance): void {
  /**
   * GET /v1/prices/current?assets=ETH,BTC,SOL,NEAR
   *
   * Returns current USD prices + 24h change for the requested assets.
   * CoinGecko primary source, Pyth fallback. 30s in-memory cache.
   *
   * Response: { prices: { ETH: { usd, usd_24h_change }, ... }, cached: boolean }
   */
  app.get('/v1/prices/current', async (request: FastifyRequest, reply: FastifyReply) => {
    const queryResult = PriceQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        'assets query parameter is required (comma-separated tickers)',
        false,
        400,
        { issues: queryResult.error.issues },
      );
    }

    const rawTickers = queryResult.data.assets
      .split(',')
      .map((t) => t.trim().toUpperCase())
      .filter((t) => t.length > 0);

    // Validate all tickers are known
    const supported = new Set(Object.keys(COINGECKO_IDS));
    const unknown = rawTickers.filter((t) => !supported.has(t));
    if (unknown.length > 0) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        `Unsupported asset(s): ${unknown.join(', ')}. Supported: ${[...supported].join(', ')}`,
        false,
        400,
      );
    }

    // Deduplicate
    const tickers = [...new Set(rawTickers)];

    // Serve from cache if fresh
    if (isCacheFresh() && priceCache) {
      const cached: Record<string, CachedPriceEntry> = {};
      let allHit = true;
      for (const t of tickers) {
        const entry = priceCache.prices[t];
        if (entry) {
          cached[t] = entry;
        } else {
          allHit = false;
          break;
        }
      }
      if (allHit) {
        return reply.status(200).send({ prices: cached, cached: true });
      }
    }

    // Fetch fresh prices
    const allPrices = await refreshPrices(tickers);

    // Update cache
    priceCache = {
      prices: { ...(priceCache?.prices ?? {}), ...allPrices },
      fetched_at: Date.now(),
    };

    // Build response — only requested tickers
    const responsePrices: Record<string, CachedPriceEntry> = {};
    for (const t of tickers) {
      const entry = allPrices[t];
      if (entry) {
        responsePrices[t] = entry;
      }
    }

    if (Object.keys(responsePrices).length === 0) {
      throw new FloorApiError(
        'INTERNAL_ERROR',
        'Could not fetch prices from any source',
        true,
        503,
      );
    }

    return reply.status(200).send({ prices: responsePrices, cached: false });
  });
}
