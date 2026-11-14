import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { getPortfolioHistory } from '../api/client';
import type { PortfolioHistory, PortfolioHistoryPoint, PositionPnL } from '../api/client';

// ── Types ───────────────────────────────────────────────────────────────────

export interface PricePoint {
  /** Unix timestamp in ms */
  timestamp: number;
  /** Portfolio value in USD */
  value: number;
}

export type TimeRange = '1D' | '1W' | '1M' | 'ALL';

/** Span in seconds for each time range */
const RANGE_SPAN_SEC: Record<TimeRange, number> = {
  '1D': 24 * 60 * 60,
  '1W': 7 * 24 * 60 * 60,
  '1M': 30 * 24 * 60 * 60,
  'ALL': Infinity,
};

// ── Chart geometry helpers ──────────────────────────────────────────────────

const CHART_W = 340;
const CHART_H = 140;
const PADDING_X = 0;
const PADDING_Y = 10;

function buildPath(
  points: PricePoint[],
  w: number,
  h: number,
): { linePath: string; areaPath: string; minVal: number; maxVal: number } {
  if (points.length === 0) {
    return { linePath: '', areaPath: '', minVal: 0, maxVal: 0 };
  }

  const values = points.map((p) => p.value);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const range = maxVal - minVal || 1;

  const plotW = w - PADDING_X * 2;
  const plotH = h - PADDING_Y * 2;

  const coords = points.map((p, i) => {
    const x = PADDING_X + (i / Math.max(1, points.length - 1)) * plotW;
    const y = PADDING_Y + plotH - ((p.value - minVal) / range) * plotH;
    return { x, y };
  });

  // Build smooth line using cardinal spline
  let linePath = `M ${coords[0]!.x} ${coords[0]!.y}`;
  for (let i = 1; i < coords.length; i++) {
    const prev = coords[i - 1]!;
    const curr = coords[i]!;
    const cpx = (prev.x + curr.x) / 2;
    linePath += ` C ${cpx} ${prev.y} ${cpx} ${curr.y} ${curr.x} ${curr.y}`;
  }

  // Area fill: same line but close at bottom
  const last = coords[coords.length - 1]!;
  const first = coords[0]!;
  const areaPath = `${linePath} L ${last.x} ${h} L ${first.x} ${h} Z`;

  return { linePath, areaPath, minVal, maxVal };
}

/** Convert API points ({t: seconds, v: usd}) to chart PricePoints ({timestamp: ms, value}) */
function toPricePoints(apiPoints: PortfolioHistoryPoint[]): PricePoint[] {
  return apiPoints.map((p) => ({ timestamp: p.t * 1000, value: p.v }));
}

/** Filter points to the given time range window */
function filterByRange(points: PricePoint[], range: TimeRange): PricePoint[] {
  if (range === 'ALL' || points.length === 0) return points;
  const cutoff = Date.now() - RANGE_SPAN_SEC[range] * 1000;
  const filtered = points.filter((p) => p.timestamp >= cutoff);
  // Always include at least one point before cutoff for continuity
  if (filtered.length < points.length && filtered.length > 0) {
    const firstFiltered = filtered[0]!;
    const beforeCutoff = points.filter((p) => p.timestamp < firstFiltered.timestamp);
    if (beforeCutoff.length > 0) {
      return [beforeCutoff[beforeCutoff.length - 1]!, ...filtered];
    }
  }
  return filtered.length > 0 ? filtered : points;
}

// ── Sub-components ──────────────────────────────────────────────────────────

const TIME_RANGES: TimeRange[] = ['1D', '1W', '1M', 'ALL'];

function RangeSelector({
  active,
  onChange,
}: {
  active: TimeRange;
  onChange: (r: TimeRange) => void;
}) {
  return (
    <div className="flex gap-1.5 bg-[#FAF9F6] border-2 border-[#111] rounded-[10px] p-1">
      {TIME_RANGES.map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          className={`
            px-3 py-1 rounded-[7px] text-xs font-extrabold transition-all duration-150
            ${r === active
              ? 'bg-[#111] text-white shadow-sm'
              : 'text-gray-500 hover:text-[#111]'
            }
          `}
        >
          {r}
        </button>
      ))}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

interface PnLChartProps {
  /** Account ID to fetch portfolio history for */
  accountId: string;
}

/**
 * PnLChart — portfolio value line chart with time range selector.
 *
 * Fetches real data from GET /v1/accounts/:id/portfolio-history.
 * Pure SVG implementation — no chart library needed.
 * Touch/hover shows value at the hovered point.
 */
export default function PnLChart({ accountId }: PnLChartProps) {
  const [range, setRange] = useState<TimeRange>('1W');
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [animating, setAnimating] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);

  // API data
  const [history, setHistory] = useState<PortfolioHistory | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    setLoading(true);
    getPortfolioHistory(accountId)
      .then((data) => {
        if (!cancelled) setHistory(data);
      })
      .catch(() => {
        if (!cancelled) setHistory(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [accountId]);

  // Convert and filter
  const allPoints = useMemo(
    () => (history ? toPricePoints(history.points) : []),
    [history],
  );
  const points = useMemo(
    () => filterByRange(allPoints, range),
    [allPoints, range],
  );

  const { linePath, areaPath, minVal, maxVal } = useMemo(
    () => buildPath(points, CHART_W, CHART_H),
    [points],
  );

  const currentValue = history?.current_value ?? 0;
  const usdcValue = history?.usdc_value ?? currentValue;
  const positionValue = history?.position_value ?? 0;
  const positionsPnl = history?.positions_pnl ?? [];

  // Current displayed value
  const displayValue = hoverIndex !== null
    ? points[hoverIndex]?.value ?? currentValue
    : currentValue;

  // Change calculation
  const firstValue = points[0]?.value ?? 0;
  const lastValue = points[points.length - 1]?.value ?? 0;
  const absoluteChange = lastValue - firstValue;
  const percentChange = firstValue > 0 ? (absoluteChange / firstValue) * 100 : 0;
  const isPositive = absoluteChange >= 0;
  const lineColor = isPositive ? '#29CEB4' : '#EF4444';
  const gradientId = `pnl-gradient-${range}`;

  // Animate on range change
  const handleRangeChange = useCallback((r: TimeRange) => {
    setAnimating(true);
    setHoverIndex(null);
    setRange(r);
  }, []);

  useEffect(() => {
    if (animating) {
      const timer = setTimeout(() => setAnimating(false), 400);
      return () => clearTimeout(timer);
    }
  }, [animating, range]);

  // Touch/mouse interaction
  const handleInteraction = useCallback(
    (clientX: number) => {
      if (!svgRef.current || points.length === 0) return;
      const rect = svgRef.current.getBoundingClientRect();
      const relX = clientX - rect.left;
      const ratio = relX / rect.width;
      const idx = Math.round(ratio * (points.length - 1));
      setHoverIndex(Math.max(0, Math.min(points.length - 1, idx)));
    },
    [points],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => handleInteraction(e.clientX),
    [handleInteraction],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      if (touch) handleInteraction(touch.clientX);
    },
    [handleInteraction],
  );

  const handleLeave = useCallback(() => setHoverIndex(null), []);

  // Hover dot position
  const hoverPoint = hoverIndex !== null ? points[hoverIndex] : null;
  const hoverX = hoverIndex !== null
    ? PADDING_X + (hoverIndex / Math.max(1, points.length - 1)) * (CHART_W - PADDING_X * 2)
    : 0;
  const hoverY = hoverPoint && maxVal !== minVal
    ? PADDING_Y + (CHART_H - PADDING_Y * 2) - ((hoverPoint.value - minVal) / (maxVal - minVal)) * (CHART_H - PADDING_Y * 2)
    : 0;

  // Hover timestamp
  const hoverTimestamp = hoverPoint
    ? new Date(hoverPoint.timestamp).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : null;

  // Loading state
  if (loading) {
    return (
      <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo p-5">
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="text-xs font-extrabold text-gray-500 mb-0.5 uppercase tracking-wider">
              Portfolio Value
            </p>
            <div className="h-9 w-32 bg-gray-100 rounded-lg animate-pulse" />
          </div>
          <RangeSelector active={range} onChange={handleRangeChange} />
        </div>
        <div className="h-[140px] flex items-center justify-center">
          <span className="w-5 h-5 border-2 border-[#111] border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  // Empty state: no data or API unavailable
  if (!history || allPoints.length === 0) {
    return (
      <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo p-5">
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="text-xs font-extrabold text-gray-500 mb-0.5 uppercase tracking-wider">
              Portfolio Value
            </p>
            <p className="text-3xl font-extrabold text-[#111] tabular-nums">$0.00</p>
          </div>
          <RangeSelector active={range} onChange={handleRangeChange} />
        </div>
        <div className="h-[140px] flex items-center justify-center">
          <p className="text-sm font-semibold text-gray-400">No data yet</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo p-5">
      {/* Value header */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="text-xs font-extrabold text-gray-500 mb-0.5 uppercase tracking-wider">
            {hoverTimestamp ?? 'Portfolio Value'}
          </p>
          <p className="text-3xl font-extrabold text-[#111] tabular-nums">
            ${displayValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
          <p className={`text-sm font-bold mt-0.5 ${isPositive ? 'text-[#29CEB4]' : 'text-red-500'}`}>
            {isPositive ? '+' : ''}{absoluteChange.toFixed(2)} ({isPositive ? '+' : ''}{percentChange.toFixed(2)}%)
          </p>
        </div>

        <RangeSelector active={range} onChange={handleRangeChange} />
      </div>

      {/* SVG Chart */}
      <div className="relative -mx-2">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          className={`w-full h-auto select-none transition-opacity duration-300 ${animating ? 'opacity-40' : 'opacity-100'}`}
          preserveAspectRatio="none"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleLeave}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleLeave}
        >
          {/* Gradient fill */}
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={lineColor} stopOpacity="0.15" />
              <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Area fill */}
          {areaPath && (
            <path
              d={areaPath}
              fill={`url(#${gradientId})`}
              className="transition-all duration-300"
            />
          )}

          {/* Line */}
          {linePath && (
            <path
              d={linePath}
              fill="none"
              stroke={lineColor}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="transition-all duration-300"
            />
          )}

          {/* Hover crosshair */}
          {hoverIndex !== null && hoverPoint && (
            <>
              <line
                x1={hoverX}
                y1={PADDING_Y}
                x2={hoverX}
                y2={CHART_H - PADDING_Y}
                stroke="#111"
                strokeWidth="1"
                strokeDasharray="3,3"
                opacity="0.3"
              />
              <circle
                cx={hoverX}
                cy={hoverY}
                r="5"
                fill="white"
                stroke={lineColor}
                strokeWidth="2.5"
              />
            </>
          )}
        </svg>
      </div>

      {/* Value breakdown: USDC + Positions */}
      {(positionValue > 0 || positionsPnl.length > 0) && (
        <div className="mt-3 pt-3 border-t border-gray-100">
          <div className="flex justify-between text-xs font-bold text-gray-500 mb-2">
            <span>USDC: ${usdcValue.toFixed(2)}</span>
            <span>Positions: ${positionValue.toFixed(2)}</span>
          </div>

          {/* Per-position PnL rows */}
          {positionsPnl.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {positionsPnl.map((pos) => (
                <PositionPnLRow key={pos.floor_id} pos={pos} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Compact row showing per-position PnL inside the chart card */
function PositionPnLRow({ pos }: { pos: PositionPnL }) {
  const isProfit = pos.pnl_usd >= 0;
  const pnlColor = isProfit ? 'text-[#29CEB4]' : 'text-red-500';

  return (
    <div className="flex items-center justify-between py-1 px-1 rounded-lg hover:bg-gray-50 transition-colors">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-xs font-extrabold text-[#111]">{pos.asset}</span>
        <span className="text-[10px] font-semibold text-gray-400 truncate">
          {pos.qty} @ ${pos.current_price.toLocaleString('en-US', { maximumFractionDigits: 0 })}
        </span>
        {pos.protected && (
          <span className="text-[9px] font-bold text-[#29CEB4] bg-[#29CEB4]/10 px-1.5 py-0.5 rounded-full">
            PROTECTED
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <span className={`text-xs font-bold ${pnlColor}`}>
          {isProfit ? '+' : ''}{pos.pnl_usd.toFixed(2)}
        </span>
        <span className={`text-[10px] font-semibold ${pnlColor}`}>
          ({isProfit ? '+' : ''}{pos.pnl_pct.toFixed(1)}%)
        </span>
      </div>
    </div>
  );
}
