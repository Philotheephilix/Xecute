import { useState, useEffect, useMemo } from 'react';
import type { Position } from '../api/client';

// ── Extended position type ──────────────────────────────────────────────────

/**
 * Extended position with fields needed for the rich card display.
 * The base Position type from client.ts has: floor_id, asset, amount, floor_price_usd?, protected_until?, status.
 *
 * Additional fields needed from API (not yet returned by GET /v1/accounts/:id/positions):
 *   - opened_at: ISO string — when the floor was opened (for progress bar)
 *   - current_price_usd: number — current market price of the asset
 *   - qty_decimals: number — decimal precision for display (ETH=6, SOL=4)
 *
 * API changes needed:
 *   1. Add `opened_at` to positions response (already in DB, just not returned)
 *   2. New endpoint or field: current market price per asset
 *      - Option A: GET /v1/prices/current?assets=ETH,SOL (from risk service cache)
 *      - Option B: Include `current_price_usd` in positions response (server-side enrichment)
 */
export interface ExtendedPosition extends Position {
  /** When the floor was opened — needed for progress bar */
  opened_at?: string;
  /** Current market price — needed for unrealized PnL */
  current_price_usd?: number;
}

// ── Asset config ────────────────────────────────────────────────────────────

const ASSET_CONFIG: Record<string, {
  name: string;
  /** SVG path for a simple icon */
  icon: string;
  /** Icon background color */
  color: string;
  decimals: number;
}> = {
  ETH: {
    name: 'Ethereum',
    icon: 'M12 2L4 12l8 5.5L20 12 12 2zM12 22l-8-6.5L12 20l8-4.5L12 22z',
    color: 'bg-[#627EEA]',
    decimals: 6,
  },
  SOL: {
    name: 'Solana',
    icon: 'M5 18h14l-2-3H7l-2 3zm0-5h14l-2-3H7l-2 3zm0-5h14l-2-3H7l-2 3z',
    color: 'bg-[#9945FF]',
    decimals: 4,
  },
  BTC: {
    name: 'Bitcoin',
    icon: 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm1 15h-2v-1h-1v-2h1v-4h-1V8h1V7h2v1h1v2h-1v4h1v2h-1v1z',
    color: 'bg-[#F7931A]',
    decimals: 8,
  },
};

const DEFAULT_ASSET_CONFIG = {
  name: 'Token',
  icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
  color: 'bg-gray-500',
  decimals: 6,
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function getAssetConfig(asset: string) {
  // Strip "nep141:" prefix and known suffixes for matching
  const ticker = asset
    .replace(/^nep141:/, '')
    .replace(/\.omft\.near$/, '')
    .replace(/\.fakes\.testnet$/, '')
    .toUpperCase();

  return ASSET_CONFIG[ticker] ?? { ...DEFAULT_ASSET_CONFIG, name: ticker };
}

function formatCountdown(expiresAt: string): {
  text: string;
  urgent: boolean;
  expired: boolean;
} {
  const now = Date.now();
  const expires = new Date(expiresAt).getTime();
  const diff = expires - now;

  if (diff <= 0) {
    return { text: 'Expired', urgent: false, expired: true };
  }

  const hours = Math.floor(diff / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;

  const urgent = hours < 24;

  if (days > 0) {
    return { text: `${days}d ${remainingHours}h remaining`, urgent, expired: false };
  }
  if (hours > 0) {
    return { text: `Expires in ${hours}h ${minutes}m`, urgent, expired: false };
  }
  return { text: `Expires in ${minutes}m`, urgent: true, expired: false };
}

function computeProgress(openedAt?: string, expiresAt?: string): number {
  if (!openedAt || !expiresAt) return 0;
  const start = new Date(openedAt).getTime();
  const end = new Date(expiresAt).getTime();
  const now = Date.now();
  const total = end - start;
  if (total <= 0) return 100;
  const elapsed = now - start;
  return Math.min(100, Math.max(0, (elapsed / total) * 100));
}

function formatUsd(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Status badge ────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: Position['status'] }) {
  const configs: Record<string, { label: string; bg: string; text: string; border: string }> = {
    active: { label: 'ACTIVE', bg: 'bg-[#29CEB4]', text: 'text-[#111]', border: 'border-[#111]' },
    expired: { label: 'EXPIRED', bg: 'bg-gray-200', text: 'text-gray-600', border: 'border-[#111]' },
    closed: { label: 'CLOSED', bg: 'bg-[#EF7B28]', text: 'text-white', border: 'border-[#111]' },
  };
  // sold is not in the Position type from client.ts but may appear from contract events
  const c = configs[status] ?? configs['closed']!;

  return (
    <span className={`px-2 py-0.5 rounded-full text-[11px] font-extrabold ${c.bg} ${c.text} border ${c.border}`}>
      {c.label}
    </span>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

interface PositionCardProps {
  position: ExtendedPosition;
  /** Called when user taps "Sell to Floor" */
  onSellToFloor?: (floorId: string) => void;
  /** Called when user taps "Close" */
  onClose?: (floorId: string) => void;
  /** True while an action is in progress for this position */
  actionLoading?: boolean;
}

/**
 * PositionCard — rich display for a single floor position.
 *
 * Shows:
 * - Asset icon + name + quantity + current value
 * - Floor price with shield icon (protection level)
 * - Unrealized PnL (green/red)
 * - Expiry countdown with urgency styling
 * - Progress bar (time elapsed / total duration)
 * - Sell/Close action buttons (active positions only)
 */
export default function PositionCard({
  position,
  onSellToFloor,
  onClose,
  actionLoading = false,
}: PositionCardProps) {
  const assetConfig = getAssetConfig(position.asset);
  const qty = parseFloat(position.amount);

  // Live countdown ticker
  const [, setTick] = useState(0);
  useEffect(() => {
    if (position.status !== 'active' || !position.protected_until) return;
    const interval = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(interval);
  }, [position.status, position.protected_until]);

  // Countdown
  const countdown = useMemo(
    () => position.protected_until ? formatCountdown(position.protected_until) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [position.protected_until, /* tick forces recompute */],
  );

  // Progress bar
  const progress = useMemo(
    () => computeProgress(position.opened_at, position.protected_until),
    [position.opened_at, position.protected_until],
  );

  // PnL computation (requires current_price_usd)
  const pnl = useMemo(() => {
    if (!position.current_price_usd || !position.floor_price_usd) return null;
    const currentVal = qty * position.current_price_usd;
    const floorVal = qty * position.floor_price_usd;
    const diff = currentVal - floorVal;
    const pct = floorVal > 0 ? (diff / floorVal) * 100 : 0;
    return { currentVal, diff, pct, positive: diff >= 0 };
  }, [qty, position.current_price_usd, position.floor_price_usd]);

  // Current market value
  const currentValue = position.current_price_usd
    ? qty * position.current_price_usd
    : null;

  return (
    <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo p-4">
      {/* Top row: asset info + status badge */}
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-3">
          {/* Asset icon */}
          <div className={`w-10 h-10 ${assetConfig.color} border-2 border-[#111] rounded-[10px] flex items-center justify-center`}>
            <svg className="w-5 h-5 fill-white" viewBox="0 0 24 24">
              <path d={assetConfig.icon} />
            </svg>
          </div>
          <div>
            <p className="text-base font-extrabold text-[#111]">
              {position.amount} {assetConfig.name.length > 10 ? position.asset.replace(/^nep141:/, '').split('.')[0]?.toUpperCase() : assetConfig.name}
            </p>
            {currentValue !== null && (
              <p className="text-sm font-semibold text-gray-500">
                ${formatUsd(currentValue)}
              </p>
            )}
          </div>
        </div>
        <StatusBadge status={position.status} />
      </div>

      {/* Floor price with shield */}
      {position.floor_price_usd !== undefined && (
        <div className="flex items-center gap-1.5 mb-2">
          <svg className="w-4 h-4 text-[#29CEB4]" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3z" />
          </svg>
          <span className="text-sm font-bold text-[#111]">
            Floor at ${formatUsd(position.floor_price_usd)}
          </span>
        </div>
      )}

      {/* Unrealized PnL */}
      {pnl !== null && (
        <div className={`flex items-center gap-1.5 mb-2 text-sm font-bold ${pnl.positive ? 'text-[#29CEB4]' : 'text-red-500'}`}>
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            {pnl.positive
              ? <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
              : <polyline points="22 17 13.5 8.5 8.5 13.5 2 7" />
            }
          </svg>
          {pnl.positive ? '+' : ''}{formatUsd(pnl.diff)} ({pnl.positive ? '+' : ''}{pnl.pct.toFixed(2)}%)
        </div>
      )}

      {/* Expiry countdown */}
      {countdown && position.status === 'active' && (
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span className={`text-xs font-bold ${
                countdown.expired
                  ? 'text-gray-400'
                  : countdown.urgent
                    ? 'text-[#EF7B28]'
                    : 'text-gray-500'
              }`}>
                {countdown.text}
              </span>
            </div>
            <span className="text-[10px] font-bold text-gray-400 tabular-nums">
              {Math.round(progress)}%
            </span>
          </div>

          {/* Progress bar */}
          <div className="w-full h-2 bg-[#FAF9F6] border border-[#111]/10 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                countdown.urgent
                  ? 'bg-[#EF7B28]'
                  : 'bg-[#29CEB4]'
              }`}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Expired / closed date */}
      {position.status !== 'active' && position.protected_until && (
        <p className="text-xs font-semibold text-gray-400 mb-3">
          {position.status === 'expired' ? 'Expired' : 'Closed'}{' '}
          {new Date(position.protected_until).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })}
        </p>
      )}

      {/* Action buttons — active positions only */}
      {position.status === 'active' && (
        <div className="flex gap-2 mt-1">
          <button
            onClick={() => onSellToFloor?.(position.floor_id)}
            disabled={actionLoading}
            className="flex-1 h-10 bg-[#29CEB4] text-[#111] border-2 border-[#111] rounded-[10px] text-xs font-extrabold shadow-neo-sm shadow-neo-active disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            {actionLoading ? (
              <span className="w-3.5 h-3.5 border-2 border-[#111] border-t-transparent rounded-full animate-spin" />
            ) : (
              <>
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3z" />
                </svg>
                Sell to Floor
              </>
            )}
          </button>
          <button
            onClick={() => onClose?.(position.floor_id)}
            disabled={actionLoading}
            className="flex-1 h-10 bg-white text-[#111] border-2 border-[#111] rounded-[10px] text-xs font-extrabold shadow-neo-sm shadow-neo-active disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            {actionLoading ? (
              <span className="w-3.5 h-3.5 border-2 border-[#111] border-t-transparent rounded-full animate-spin" />
            ) : (
              <>
                <svg className="w-3.5 h-3.5 stroke-current fill-none stroke-[2.5]" viewBox="0 0 24 24">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
                Close
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
