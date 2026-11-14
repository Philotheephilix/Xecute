/**
 * HomeTab — Portfolio dashboard for the Floors Chrome extension popup.
 *
 * Replaces the buy-first flow with a portfolio-centric home screen:
 * - Balance card with USDC + NEAR
 * - PnL chart (SVG, same design as web PnLChart)
 * - Quick action buttons (Buy, Fund, Send)
 * - Active positions summary with close ability
 * - Recent activity feed
 *
 * Preact component. 380x468px content area (380x520 minus 52px nav).
 * Neo-brutalist design: #FAF9F6 bg, white cards, 2px #111 borders,
 * rounded-14px, box-shadow 0 2.5px 0 #111.
 */

import { h, Fragment } from 'preact';
import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';

// ── Constants ──────────────────────────────────────────────────────────────

const API_URL = (import.meta as unknown as { env: Record<string, string | undefined> }).env['VITE_API_URL'] ?? 'http://localhost:3001';

type TimeRange = '1D' | '1W' | '1M' | 'ALL';
type Tab = 'home' | 'portfolio' | 'activity' | 'settings';

interface Position {
  floor_id: string;
  asset: string;
  amount: string;
  floor_price_usd?: number;
  protected_until?: string;
  status: 'active' | 'expired' | 'closed';
}

interface PricePoint {
  timestamp: number;
  value: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

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

function formatUsd(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Fetch real portfolio history from API and convert to PricePoint[]. */
async function fetchPortfolioHistory(accountId: string): Promise<{
  points: PricePoint[];
  change24h: number;
  changePct24h: number;
  /** Server-computed total (USDC + positions) — authoritative, no client-side double-counting */
  apiCurrentValue: number;
} | null> {
  try {
    const res = await fetch(`${API_URL}/v1/accounts/${encodeURIComponent(accountId)}/portfolio-history`);
    if (!res.ok) return null;
    const data = await res.json() as {
      points: Array<{ t: number; v: number }>;
      current_value: number;
      change_24h: number;
      change_pct_24h: number;
    };
    const points: PricePoint[] = data.points.map(p => ({
      timestamp: p.t * 1000, // API returns unix seconds, chart expects ms
      value: p.v,
    }));
    return {
      points,
      change24h: data.change_24h,
      changePct24h: data.change_pct_24h,
      apiCurrentValue: data.current_value,
    };
  } catch {
    return null;
  }
}

/** Filter points to a time range window. */
function filterByRange(points: PricePoint[], range: TimeRange): PricePoint[] {
  if (points.length === 0) return points;
  const now = Date.now();
  let cutoff: number;
  switch (range) {
    case '1D': cutoff = now - 24 * 60 * 60 * 1000; break;
    case '1W': cutoff = now - 7 * 24 * 60 * 60 * 1000; break;
    case '1M': cutoff = now - 30 * 24 * 60 * 60 * 1000; break;
    case 'ALL': return points;
  }
  const filtered = points.filter(p => p.timestamp >= cutoff);
  // Always include at least the last point before the cutoff for context
  if (filtered.length === 0) return points.length > 0 ? [points[points.length - 1]!] : [];
  if (filtered[0] !== points[0]) {
    // Prepend the last point before the cutoff
    const idx = points.indexOf(filtered[0]!);
    if (idx > 0) filtered.unshift(points[idx - 1]!);
  }
  return filtered;
}

// ── Chart geometry ─────────────────────────────────────────────────────────

const CHART_W = 340;
const CHART_H = 120;
const PADDING_X = 0;
const PADDING_Y = 8;

function buildPath(points: PricePoint[], w: number, _h: number) {
  if (points.length === 0) return { linePath: '', areaPath: '', minVal: 0, maxVal: 0 };

  const values = points.map(p => p.value);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const range = maxVal - minVal || 1;
  const plotW = w - PADDING_X * 2;
  const plotH = CHART_H - PADDING_Y * 2;

  const coords = points.map((p, i) => ({
    x: PADDING_X + (i / Math.max(1, points.length - 1)) * plotW,
    y: PADDING_Y + plotH - ((p.value - minVal) / range) * plotH,
  }));

  let linePath = `M ${coords[0]!.x} ${coords[0]!.y}`;
  for (let i = 1; i < coords.length; i++) {
    const prev = coords[i - 1]!;
    const curr = coords[i]!;
    const cpx = (prev.x + curr.x) / 2;
    linePath += ` C ${cpx} ${prev.y} ${cpx} ${curr.y} ${curr.x} ${curr.y}`;
  }

  const last = coords[coords.length - 1]!;
  const first = coords[0]!;
  const areaPath = `${linePath} L ${last.x} ${CHART_H} L ${first.x} ${CHART_H} Z`;

  return { linePath, areaPath, minVal, maxVal };
}

// ── Price fetching ────────────────────────────────────────────────────────

interface CurrentPricesHT {
  [ticker: string]: { usd: number; usd_24h_change: number | null };
}

async function fetchCurrentPricesHT(tickers: string[]): Promise<CurrentPricesHT> {
  if (tickers.length === 0) return {};
  try {
    const res = await fetch(`${API_URL}/v1/prices/current?assets=${tickers.join(',')}`);
    if (!res.ok) return {};
    const data = await res.json() as { prices: CurrentPricesHT };
    return data.prices ?? {};
  } catch {
    return {};
  }
}

// ── Sub-components ─────────────────────────────────────────────────────────

const TIME_RANGES: TimeRange[] = ['1D', '1W', '1M', 'ALL'];

function RangeSelector({ active, onChange }: { active: TimeRange; onChange: (r: TimeRange) => void }) {
  return (
    <div style={{ display: 'flex', gap: '4px', background: '#FAF9F6', border: '2px solid #111', borderRadius: '10px', padding: '3px' }}>
      {TIME_RANGES.map(r => (
        <button
          key={r}
          onClick={() => onChange(r)}
          style={{
            padding: '3px 10px',
            borderRadius: '7px',
            fontSize: '11px',
            fontWeight: 800,
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
            background: r === active ? '#111' : 'transparent',
            color: r === active ? 'white' : '#9ca3af',
            transition: 'all 0.15s',
          }}
        >
          {r}
        </button>
      ))}
    </div>
  );
}

// ── Portfolio Chart ────────────────────────────────────────────────────────

function PortfolioChart({ currentValue, accountId, positions }: { currentValue: number; accountId: string; positions: Position[] }) {
  const [range, setRange] = useState<TimeRange>('ALL');
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [allPoints, setAllPoints] = useState<PricePoint[]>([]);
  const [change24h, setChange24h] = useState(0);
  const [changePct24h, setChangePct24h] = useState(0);
  const [chartLoading, setChartLoading] = useState(true);
  const [currentPricesHT, setCurrentPricesHT] = useState<CurrentPricesHT>({});
  /** Server-reported total (USDC + positions) — the authoritative value */
  const [apiCurrentValue, setApiCurrentValue] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Fetch real portfolio history — includes current_value with positions already counted
  useEffect(() => {
    if (!accountId) { setChartLoading(false); return; }
    let cancelled = false;
    setChartLoading(true);
    fetchPortfolioHistory(accountId).then(result => {
      if (cancelled) return;
      if (result) {
        setAllPoints(result.points);
        setChange24h(result.change24h);
        setChangePct24h(result.changePct24h);
        setApiCurrentValue(result.apiCurrentValue);
      }
      setChartLoading(false);
    });
    return () => { cancelled = true; };
  }, [accountId]);

  // Extract unique tickers from positions for price fetching (breakdown display only)
  const htTickers = useMemo(() => {
    const tickers = new Set<string>();
    for (const pos of positions) {
      const t = pos.asset.replace(/^nep141:/, '').replace(/\.omft\.near$/, '').replace(/\.fakes\.testnet$/, '').split('.')[0]?.toUpperCase();
      if (t) tickers.add(t);
    }
    return [...tickers];
  }, [positions]);

  // Fetch current prices + auto-refresh every 30s (for breakdown display)
  useEffect(() => {
    if (htTickers.length === 0) return;
    let cancelled = false;
    const doFetch = () => {
      fetchCurrentPricesHT(htTickers).then(prices => {
        if (!cancelled && Object.keys(prices).length > 0) setCurrentPricesHT(prices);
      });
    };
    doFetch();
    const interval = setInterval(doFetch, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [htTickers.join(',')]);

  // Breakdown for display only — NOT used to compute portfolio total
  const activePositions = positions.filter(p => p.status === 'active');
  const breakdown = useMemo(() => {
    const items: Array<{
      ticker: string;
      qty: number;
      value: number;
      isProtected: boolean;
    }> = [];
    for (const pos of activePositions) {
      const ticker = pos.asset.replace(/^nep141:/, '').replace(/\.omft\.near$/, '').replace(/\.fakes\.testnet$/, '').split('.')[0]?.toUpperCase() ?? pos.asset;
      const qty = parseFloat(pos.amount) || 0;
      const floorPrice = pos.floor_price_usd ?? null;
      const priceEntry = currentPricesHT[ticker];
      const spotPrice = priceEntry?.usd ?? null;
      const isProtected = floorPrice !== null && spotPrice !== null && spotPrice < floorPrice;
      const effectivePrice = isProtected ? floorPrice! : (spotPrice ?? floorPrice ?? 0);
      items.push({ ticker, qty, value: qty * effectivePrice, isProtected });
    }
    return items;
  }, [activePositions, currentPricesHT]);

  // Portfolio total: use the API's current_value (which already includes positions).
  // Fall back to USDC-only if the API didn't return current_value.
  // Do NOT add positionsValue on top — that would double-count.
  const liveTotal = apiCurrentValue ?? currentValue;

  // Do NOT append a client-side computed point — the API's last point is authoritative
  const augmentedPoints = allPoints;

  const points = useMemo(() => filterByRange(augmentedPoints, range), [augmentedPoints, range]);
  const { linePath, areaPath, minVal, maxVal } = useMemo(
    () => buildPath(points, CHART_W, CHART_H),
    [points],
  );

  const displayValue = hoverIndex !== null
    ? points[hoverIndex]?.value ?? liveTotal
    : liveTotal;

  const firstValue = points[0]?.value ?? 0;
  const lastValue = points[points.length - 1]?.value ?? 0;
  const absoluteChange = lastValue - firstValue;
  const percentChange = firstValue > 0 ? (absoluteChange / firstValue) * 100 : 0;
  const isPositive = absoluteChange >= 0;
  const lineColor = isPositive ? '#29CEB4' : '#EF4444';
  const gradientId = `pnl-grad-${range}`;

  const handleInteraction = useCallback((clientX: number) => {
    if (!svgRef.current || points.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const relX = clientX - rect.left;
    const ratio = relX / rect.width;
    const idx = Math.round(ratio * (points.length - 1));
    setHoverIndex(Math.max(0, Math.min(points.length - 1, idx)));
  }, [points]);

  const hoverPoint = hoverIndex !== null ? points[hoverIndex] : null;
  const hoverX = hoverIndex !== null
    ? PADDING_X + (hoverIndex / Math.max(1, points.length - 1)) * (CHART_W - PADDING_X * 2)
    : 0;
  const hoverY = hoverPoint && maxVal !== minVal
    ? PADDING_Y + (CHART_H - PADDING_Y * 2) - ((hoverPoint.value - minVal) / (maxVal - minVal)) * (CHART_H - PADDING_Y * 2)
    : 0;

  const hoverTimestamp = hoverPoint
    ? new Date(hoverPoint.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : null;

  // Empty / loading states
  if (chartLoading) {
    return (
      <div style={{
        background: 'white', border: '2px solid #111', borderRadius: '14px',
        boxShadow: '0 2.5px 0 #111', padding: '14px',
        display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '160px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ display: 'inline-block', width: '14px', height: '14px', border: '2px solid #111', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          <span style={{ fontSize: '13px', fontWeight: 600, color: '#9ca3af' }}>Loading chart…</span>
        </div>
      </div>
    );
  }

  if (allPoints.length < 2) {
    return (
      <div style={{
        background: 'white', border: '2px solid #111', borderRadius: '14px',
        boxShadow: '0 2.5px 0 #111', padding: '20px 14px',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: '8px', minHeight: '120px', textAlign: 'center',
      }}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
        <p style={{ fontSize: '13px', fontWeight: 700, color: '#9ca3af' }}>
          Make your first trade to see portfolio history
        </p>
      </div>
    );
  }

  return (
    <div style={{
      background: 'white',
      border: '2px solid #111',
      borderRadius: '14px',
      boxShadow: '0 2.5px 0 #111',
      padding: '14px',
    }}>
      {/* Value header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
        <div>
          <p style={{ fontSize: '10px', fontWeight: 800, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '2px' }}>
            {hoverTimestamp ?? 'Portfolio Value'}
          </p>
          <p style={{ fontSize: '24px', fontWeight: 800, color: '#111', fontVariantNumeric: 'tabular-nums' }}>
            ${formatUsd(displayValue)}
          </p>
          <p style={{ fontSize: '12px', fontWeight: 700, marginTop: '2px', color: isPositive ? '#29CEB4' : '#EF4444' }}>
            {isPositive ? '+' : ''}{absoluteChange.toFixed(2)} ({isPositive ? '+' : ''}{percentChange.toFixed(2)}%)
          </p>
        </div>
        <RangeSelector active={range} onChange={r => { setRange(r); setHoverIndex(null); }} />
      </div>

      {/* SVG Chart */}
      <div style={{ margin: '0 -4px' }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          style={{ width: '100%', height: 'auto', userSelect: 'none' }}
          preserveAspectRatio="none"
          onMouseMove={(e: MouseEvent) => handleInteraction(e.clientX)}
          onMouseLeave={() => setHoverIndex(null)}
          onTouchMove={(e: TouchEvent) => { const t = e.touches[0]; if (t) handleInteraction(t.clientX); }}
          onTouchEnd={() => setHoverIndex(null)}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color={lineColor} stop-opacity="0.15" />
              <stop offset="100%" stop-color={lineColor} stop-opacity="0" />
            </linearGradient>
          </defs>
          {areaPath && <path d={areaPath} fill={`url(#${gradientId})`} />}
          {linePath && <path d={linePath} fill="none" stroke={lineColor} stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />}
          {hoverIndex !== null && hoverPoint && (
            <>
              <line x1={hoverX} y1={PADDING_Y} x2={hoverX} y2={CHART_H - PADDING_Y} stroke="#111" stroke-width="1" stroke-dasharray="3,3" opacity="0.3" />
              <circle cx={hoverX} cy={hoverY} r="4" fill="white" stroke={lineColor} stroke-width="2" />
            </>
          )}
        </svg>
      </div>

      {/* Portfolio breakdown */}
      {hoverIndex === null && (currentValue > 0 || breakdown.length > 0) && (
        <div style={{ borderTop: '1.5px solid #e5e7eb', marginTop: '10px', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '5px' }}>
          {currentValue > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '11px', fontWeight: 700, color: '#6b7280' }}>USDC</span>
              <span style={{ fontSize: '11px', fontWeight: 800, color: '#111', fontVariantNumeric: 'tabular-nums' }}>
                ${formatUsd(currentValue)}
              </span>
            </div>
          )}
          {breakdown.map((b, i) => (
            <div key={`${b.ticker}-${i}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '11px', fontWeight: 700, color: '#6b7280' }}>
                {b.ticker} ({b.qty < 0.01 ? b.qty.toFixed(4) : b.qty.toFixed(2)})
              </span>
              <span style={{ fontSize: '11px', fontWeight: 800, color: '#111', fontVariantNumeric: 'tabular-nums', display: 'flex', alignItems: 'center', gap: '4px' }}>
                ${formatUsd(b.value)}
                {b.isProtected && (
                  <span style={{
                    fontSize: '9px', fontWeight: 800, color: '#29CEB4',
                    background: '#29CEB41A', padding: '1px 5px', borderRadius: '4px',
                  }}>
                    Protected
                  </span>
                )}
              </span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #e5e7eb', paddingTop: '5px', marginTop: '2px' }}>
            <span style={{ fontSize: '12px', fontWeight: 800, color: '#111' }}>Total</span>
            <span style={{ fontSize: '12px', fontWeight: 800, color: '#111', fontVariantNumeric: 'tabular-nums' }}>
              ${formatUsd(liveTotal)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Active Position Row ────────────────────────────────────────────────────

function PositionRow({ pos, onTap }: { pos: Position; onTap: () => void }) {
  const assetColors: Record<string, string> = {
    ETH: '#627EEA', BTC: '#F7931A', SOL: '#9945FF', NEAR: '#29CEB4',
  };
  const ticker = pos.asset.replace(/^nep141:/, '').replace(/\.omft\.near$/, '').replace(/\.fakes\.testnet$/, '').toUpperCase();
  const color = assetColors[ticker] ?? '#9662FF';

  return (
    <button
      onClick={onTap}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 12px',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{
          width: '32px', height: '32px', borderRadius: '50%',
          border: '2px solid #111', background: color,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '10px', fontWeight: 800, color: 'white',
        }}>
          {ticker.slice(0, 2)}
        </div>
        <div style={{ textAlign: 'left' }}>
          <div style={{ fontSize: '13px', fontWeight: 800, color: '#111' }}>
            {pos.amount} {ticker}
          </div>
          {pos.floor_price_usd !== undefined && (
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#6b7280' }}>
              Floor ${formatUsd(pos.floor_price_usd)}
            </div>
          )}
        </div>
      </div>
      {pos.protected_until && (
        <span style={{
          padding: '2px 8px', borderRadius: '99px',
          fontSize: '10px', fontWeight: 800,
          background: '#29CEB4', color: '#111',
          border: '1px solid #111',
        }}>
          {daysLeft(pos.protected_until)}
        </span>
      )}
    </button>
  );
}

// ── On-chain activity types ───────────────────────────────────────────────

interface ActivityTransaction {
  tx_hash: string;
  receipt_id: string;
  type: string;
  method: string | null;
  label: string;
  receiver: string;
  predecessor: string;
  timestamp: string;
  status: string;
  deposit: string;
  icon_type: 'swap' | 'floor' | 'transfer' | 'account' | 'other';
  actions: Array<{ action: string; method?: string | null }>;
}

const ICON_COLORS: Record<ActivityTransaction['icon_type'], string> = {
  swap: '#29CEB4',
  floor: '#EF7B28',
  transfer: '#9662FF',
  account: '#627EEA',
  other: '#9ca3af',
};

function ActivityIcon({ iconType }: { iconType: ActivityTransaction['icon_type'] }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      {iconType === 'swap' && <><path d="M16 3l4 4-4 4" /><path d="M20 7H4" /><path d="M8 21l-4-4 4-4" /><path d="M4 17h16" /></>}
      {iconType === 'floor' && <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />}
      {iconType === 'transfer' && <><path d="M22 2L11 13" /><path d="M22 2L15 22l-4-9-9-4 20-7z" /></>}
      {iconType === 'account' && <><circle cx="12" cy="7" r="4" /><path d="M5.5 21a6.5 6.5 0 0113 0" /></>}
      {iconType === 'other' && <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>}
    </svg>
  );
}

function activityRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Main Component ─────────────────────────────────────────────────────────

interface HomeTabProps {
  accountId: string;
  onSwitchTab: (tab: Tab) => void;
  onBuy: () => void;
  onFund: () => void;
}

export default function HomeTab({ accountId, onSwitchTab, onBuy, onFund }: HomeTabProps) {
  const [positions, setPositions] = useState<Position[]>([]);
  const [usdcBalance, setUsdcBalance] = useState<string | null>(null);
  const [nearBalance, setNearBalance] = useState<string | null>(null);
  const [recentOnChainTxns, setRecentOnChainTxns] = useState<ActivityTransaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!accountId) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);

    // Fetch positions and activity in parallel
    const positionsP = fetch(`${API_URL}/v1/accounts/${encodeURIComponent(accountId)}/positions`)
      .then(res => res.ok ? res.json() : null)
      .catch(() => null);
    const activityP = fetch(`${API_URL}/v1/accounts/${encodeURIComponent(accountId)}/activity`)
      .then(res => res.ok ? res.json() : null)
      .catch(() => null);

    Promise.all([positionsP, activityP]).then(([posData, actData]) => {
      if (cancelled) return;

      if (posData && posData.positions) {
        const mapped: Position[] = (posData.positions as Array<{
          floor_id: string;
          asset: string;
          amount?: string;
          qty?: string;
          floor_price_usd?: number;
          floor_price_e6?: string;
          protected_until?: string;
          expires_at?: string;
          status?: string;
        }>).map(p => {
          const floorPriceUsd = p.floor_price_usd ?? (p.floor_price_e6 ? Number(p.floor_price_e6) / 1_000_000 : undefined);
          const pos: Position = {
            floor_id: p.floor_id,
            asset: p.asset,
            amount: p.qty ?? p.amount ?? '0',
            status: (p.status as Position['status']) ?? 'active',
          };
          if (floorPriceUsd !== undefined) pos.floor_price_usd = floorPriceUsd;
          const protectedUntil = p.protected_until ?? p.expires_at;
          if (protectedUntil !== undefined) pos.protected_until = protectedUntil;
          return pos;
        });
        setPositions(mapped);
        setUsdcBalance(posData.usdc_balance ?? null);
        setNearBalance(posData.near_balance ?? null);
      }

      if (actData && actData.transactions) {
        setRecentOnChainTxns((actData.transactions as ActivityTransaction[]).slice(0, 3));
      }
    }).finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [accountId]);

  const activePositions = positions.filter(p => p.status === 'active');
  const portfolioValue = usdcBalance != null ? parseFloat(usdcBalance) : 0;

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div style={{
      width: '380px',
      height: '468px',
      overflowY: 'auto',
      overflowX: 'hidden',
      background: '#FAF9F6',
      fontFamily: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    }} class="no-scrollbar">
      <div style={{ display: 'flex', flexDirection: 'column', padding: '14px 16px 16px', gap: '12px' }}>

        {/* ── Balance Card ────────────────────────────── */}
        <div style={{
          background: 'white', border: '2px solid #111',
          borderRadius: '14px', boxShadow: '0 2.5px 0 #111',
          padding: '14px 16px',
        }}>
          <p style={{ fontSize: '10px', fontWeight: 800, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>
            USDC BALANCE
          </p>
          <p style={{ fontSize: '28px', fontWeight: 800, color: '#111' }}>
            {loading ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ display: 'inline-block', width: '14px', height: '14px', border: '2px solid #111', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                <span style={{ fontSize: '14px' }}>Loading…</span>
              </span>
            ) : usdcBalance != null ? `$${usdcBalance}` : '—'}
          </p>
          {!loading && nearBalance != null && (
            <p style={{ fontSize: '12px', fontWeight: 600, color: '#9ca3af', marginTop: '2px' }}>{nearBalance} NEAR</p>
          )}
        </div>

        {/* ── Quick Actions ───────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
          {/* Buy */}
          <button
            onClick={onBuy}
            style={{
              height: '64px', background: '#EF7B28', border: '2px solid #111',
              borderRadius: '14px', boxShadow: '0 2.5px 0 #111',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px',
              cursor: 'pointer', fontFamily: 'inherit',
            }}
            class="shadow-neo-active"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            <span style={{ fontSize: '12px', fontWeight: 800, color: 'white' }}>Buy</span>
          </button>
          {/* Fund */}
          <button
            onClick={onFund}
            style={{
              height: '64px', background: 'white', border: '2px solid #111',
              borderRadius: '14px', boxShadow: '0 2.5px 0 #111',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px',
              cursor: 'pointer', fontFamily: 'inherit',
            }}
            class="shadow-neo-active"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span style={{ fontSize: '12px', fontWeight: 800, color: '#111' }}>Fund</span>
          </button>
          {/* Send (disabled) */}
          <button
            disabled
            style={{
              height: '64px', background: '#e5e7eb', border: '2px solid #111',
              borderRadius: '14px', boxShadow: '0 2.5px 0 #111',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '2px',
              cursor: 'not-allowed', fontFamily: 'inherit', opacity: 0.5,
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" />
            </svg>
            <span style={{ fontSize: '12px', fontWeight: 800, color: '#111' }}>Send</span>
            <span style={{ fontSize: '8px', fontWeight: 700, color: '#9ca3af', marginTop: '-2px' }}>Soon</span>
          </button>
        </div>

        {/* ── Portfolio Chart ─────────────────────────── */}
        <PortfolioChart currentValue={portfolioValue} accountId={accountId} positions={positions} />

        {/* ── Active Positions ────────────────────────── */}
        {!loading && activePositions.length > 0 && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
              <span style={{ fontSize: '14px', fontWeight: 800, color: '#111' }}>Your Positions</span>
              <button
                onClick={() => onSwitchTab('portfolio')}
                style={{ background: 'none', border: 'none', fontSize: '11px', fontWeight: 800, color: '#EF7B28', cursor: 'pointer', fontFamily: 'inherit' }}
              >
                {'View all →'}
              </button>
            </div>
            <div style={{
              background: 'white', border: '2px solid #111',
              borderRadius: '14px', boxShadow: '0 2.5px 0 #111',
              overflow: 'hidden',
            }}>
              {activePositions.slice(0, 3).map((pos, i) => (
                <Fragment key={pos.floor_id}>
                  {i > 0 && <div style={{ height: '2px', background: '#111' }} />}
                  <PositionRow pos={pos} onTap={() => onSwitchTab('portfolio')} />
                </Fragment>
              ))}
            </div>
          </div>
        )}

        {/* ── Empty state CTA ─────────────────────────── */}
        {!loading && activePositions.length === 0 && (
          <div style={{
            background: 'white', border: '2px solid #111',
            borderRadius: '14px', boxShadow: '0 2.5px 0 #111',
            padding: '20px 16px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', textAlign: 'center',
          }}>
            <div style={{
              width: '44px', height: '44px', background: '#FAF9F6',
              border: '2px solid #111', borderRadius: '12px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            </div>
            <div>
              <p style={{ fontSize: '13px', fontWeight: 800, color: '#111' }}>Buy crypto with floor protection</p>
              <p style={{ fontSize: '11px', fontWeight: 600, color: '#9ca3af', marginTop: '4px' }}>
                Your positions will appear here
              </p>
            </div>
            <button
              onClick={onBuy}
              class="shadow-neo-active"
              style={{
                width: '100%', height: '40px',
                background: '#EF7B28', color: 'white',
                border: '2px solid #111', borderRadius: '12px',
                fontSize: '13px', fontWeight: 800,
                boxShadow: '0 2.5px 0 #111',
                cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              Get Started
            </button>
          </div>
        )}

        {/* ── Recent Activity — real on-chain transactions ── */}
        {!loading && recentOnChainTxns.length > 0 && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
              <span style={{ fontSize: '14px', fontWeight: 800, color: '#111' }}>Recent Activity</span>
              <button
                onClick={() => onSwitchTab('activity')}
                style={{ background: 'none', border: 'none', fontSize: '11px', fontWeight: 800, color: '#EF7B28', cursor: 'pointer', fontFamily: 'inherit' }}
              >
                {'See all →'}
              </button>
            </div>
            <div style={{
              background: 'white', border: '2px solid #111',
              borderRadius: '14px', boxShadow: '0 2.5px 0 #111',
              overflow: 'hidden',
            }}>
              {recentOnChainTxns.map((tx, i) => {
                const iconColor = ICON_COLORS[tx.icon_type] ?? '#9ca3af';
                return (
                  <Fragment key={`${tx.tx_hash}-${tx.receipt_id}`}>
                    {i > 0 && <div style={{ height: '1px', background: '#e5e7eb' }} />}
                    <a
                      href={`https://testnet.nearblocks.io/txns/${tx.tx_hash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px' }}>
                        <div style={{
                          width: '30px', height: '30px', borderRadius: '50%',
                          border: '2px solid #111',
                          background: iconColor,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          flexShrink: 0,
                        }}>
                          <ActivityIcon iconType={tx.icon_type} />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ fontSize: '12px', fontWeight: 800, color: '#111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {tx.label}
                          </p>
                          <p style={{ fontSize: '10px', fontWeight: 600, color: '#9ca3af' }}>
                            {activityRelativeTime(tx.timestamp)}
                          </p>
                        </div>
                        <div style={{ flexShrink: 0 }}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={tx.status === 'success' ? '#29CEB4' : '#EF4444'} strokeWidth="3" strokeLinecap="round">
                            {tx.status === 'success'
                              ? <polyline points="20 6 9 17 4 12" />
                              : <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>}
                          </svg>
                        </div>
                      </div>
                    </a>
                  </Fragment>
                );
              })}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
