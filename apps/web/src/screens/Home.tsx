import { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';

/** Compute days remaining from an ISO date string. */
function daysLeft(iso: string): string {
  try {
    const diff = new Date(iso).getTime() - Date.now();
    if (diff <= 0) return 'Expired';
    const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
    if (days === 1) return '1d left';
    return `${days}d left`;
  } catch {
    return '—';
  }
}

const MARKET_ROWS = [
  { symbol: 'ETH', name: 'Ethereum', color: '#627EEA', geckoId: 'ethereum' },
  { symbol: 'BTC', name: 'Bitcoin', color: '#F7931A', geckoId: 'bitcoin' },
  { symbol: 'SOL', name: 'Solana', color: '#9945FF', geckoId: 'solana' },
  { symbol: 'NEAR', name: 'NEAR', color: '#29CEB4', geckoId: 'near' },
];

const COINGECKO_IDS = MARKET_ROWS.map((r) => r.geckoId).join(',');
const COINGECKO_URL = `https://api.coingecko.com/api/v3/simple/price?ids=${COINGECKO_IDS}&vs_currencies=usd&include_24hr_change=true`;

type MarketPrices = Record<string, { usd: number; usd_24h_change: number }>;

function useMarketPrices() {
  const [prices, setPrices] = useState<MarketPrices | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchPrices() {
      try {
        const res = await fetch(COINGECKO_URL);
        if (!res.ok) return;
        const data: MarketPrices = await res.json();
        if (!cancelled) setPrices(data);
      } catch {
        /* network error — keep prices null, UI shows "—" */
      }
    }

    fetchPrices();
    const interval = setInterval(fetchPrices, 60_000); // refresh every 60s

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return prices;
}

export default function Home() {
  const { account, positions, balances, isLoadingPositions, switchTab, pushSubScreen } = useApp();
  const marketPrices = useMarketPrices();

  if (!account) return null;

  const activePositions = positions.filter((p) => p.status === 'active');

  return (
    <div className="tab-content">
      <div className="flex flex-col px-6 pt-4 pb-6 gap-5">

        {/* Header */}
        <div className="flex items-center justify-between pt-4">
          <span className="text-xl font-extrabold text-[#111] tracking-tight">Xecute</span>
          <button
            onClick={() => switchTab('settings')}
            className="w-10 h-10 bg-[#EF7B28] border-2 border-[#111] rounded-full shadow-neo-sm shadow-neo-active flex items-center justify-center"
            aria-label="Settings"
          >
            <svg className="w-5 h-5 fill-current text-white" viewBox="0 0 24 24">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z" />
            </svg>
          </button>
        </div>

        {/* Balance Summary Card */}
        <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo p-5">
          <p className="text-xs font-extrabold text-gray-500 mb-1">USDC BALANCE</p>
          <p className="text-4xl font-extrabold text-[#111]">
            {isLoadingPositions ? (
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 border-2 border-[#111] border-t-transparent rounded-full animate-spin" />
                <span className="text-lg">Loading…</span>
              </span>
            ) : balances.usdc != null ? (
              `$${balances.usdc}`
            ) : (
              '—'
            )}
          </p>
          {!isLoadingPositions && balances.near != null && (
            <p className="text-sm font-semibold text-gray-400 mt-1">{balances.near} NEAR</p>
          )}
        </div>

        {/* Quick Action Pills */}
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => pushSubScreen('fund-account')}
            aria-label="Fund"
            className="h-[88px] bg-white rounded-[18px] border-2 border-[#111] shadow-neo flex flex-col items-center justify-center gap-2 shadow-neo-active"
          >
            <svg className="w-6 h-6 stroke-current fill-none stroke-[2.2]" viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span className="text-sm font-extrabold text-[#111]">Fund</span>
          </button>
          <button
            onClick={() => window.open('https://chromewebstore.google.com/', '_blank')}
            aria-label="Trade — install Xecute extension"
            className="h-[88px] bg-white rounded-[18px] border-2 border-[#111] shadow-neo flex flex-col items-center justify-center gap-2 shadow-neo-active"
          >
            <svg className="w-6 h-6 stroke-current fill-none stroke-[2.2]" viewBox="0 0 24 24">
              <path d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            <span className="text-sm font-extrabold text-[#111]">Trade</span>
            <span className="text-[9px] font-bold text-gray-400 -mt-1">Install extension</span>
          </button>
        </div>

        {/* Active Floors Summary */}
        {isLoadingPositions ? null : activePositions.length > 0 ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-base font-extrabold text-[#111]">Your Positions</span>
              <button
                onClick={() => switchTab('portfolio')}
                className="text-xs font-extrabold text-[#EF7B28]"
              >
                View all &rarr;
              </button>
            </div>
            <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo-sm divide-y-2 divide-[#111] overflow-hidden">
              {activePositions.slice(0, 3).map((pos) => (
                <div key={pos.floor_id} className="flex items-center justify-between px-4 py-3">
                  <div className="flex flex-col">
                    <span className="text-sm font-extrabold text-[#111]">
                      {pos.amount} {pos.asset}
                    </span>
                    {pos.floor_price_usd !== undefined && (
                      <span className="text-xs font-semibold text-gray-500">
                        Floor ${pos.floor_price_usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    )}
                  </div>
                  {pos.protected_until && (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-[#29CEB4] text-[#111] border border-[#111]">
                      {daysLeft(pos.protected_until)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo p-5 flex flex-col items-center gap-3 text-center">
            <div className="w-12 h-12 bg-[#FAF9F6] border-2 border-[#111] rounded-[13px] flex items-center justify-center">
              <svg className="w-6 h-6 stroke-current fill-none stroke-[2.2] text-[#111]" viewBox="0 0 24 24">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-extrabold text-[#111]">Get Started</p>
              <p className="text-xs font-semibold text-gray-500 mt-1">
                Buy crypto with floor protection
              </p>
            </div>
            <button
              onClick={() => pushSubScreen('fund-account')}
              className="w-full h-[44px] bg-[#EF7B28] text-white border-2 border-[#111] rounded-[13px] text-sm font-extrabold shadow-neo-sm shadow-neo-active"
            >
              Buy with Floor
            </button>
          </div>
        )}

        {/* Market Prices */}
        <div className="flex flex-col gap-2">
          <span className="text-base font-extrabold text-[#111]">Markets</span>
          <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo-sm divide-y-2 divide-[#111] overflow-hidden">
            {MARKET_ROWS.map(({ symbol, name, color, geckoId }) => {
              const info = marketPrices?.[geckoId];
              const price = info?.usd;
              const change = info?.usd_24h_change;
              const changePositive = change != null && change >= 0;
              const changeColor = change == null ? 'text-gray-300' : changePositive ? 'text-green-600' : 'text-red-500';

              return (
                <div key={symbol} className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-8 h-8 rounded-full border-2 border-[#111] flex items-center justify-center text-[11px] font-extrabold text-white"
                      style={{ backgroundColor: color }}
                    >
                      {symbol.slice(0, 2)}
                    </div>
                    <div className="flex flex-col">
                      <span className="text-sm font-extrabold text-[#111]">{name}</span>
                      <span className="text-[10px] font-semibold text-gray-400">{symbol}</span>
                    </div>
                  </div>
                  <div className="flex flex-col items-end">
                    <span className="text-sm font-extrabold text-[#111]">
                      {price != null
                        ? `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : '—'}
                    </span>
                    <span className={`text-[10px] font-semibold ${changeColor}`}>
                      {change != null
                        ? `${changePositive ? '+' : ''}${change.toFixed(2)}%`
                        : '—'}
                    </span>
                  </div>
                </div>
              );
            })}
            {!marketPrices && (
              <div className="px-4 py-2 text-center">
                <span className="text-[10px] font-semibold text-gray-400">Loading prices…</span>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
