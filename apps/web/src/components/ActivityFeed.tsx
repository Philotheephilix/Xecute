import { useState, useRef, useCallback, useEffect } from 'react';
import { getActivity } from '../api/client';
import type { ActivityTransaction, ActivityBuySubmission } from '../api/client';

// ── Types ───────────────────────────────────────────────────────────────────

export type TransactionType =
  | 'buy'
  | 'floor_opened'
  | 'sell_to_floor'
  | 'close'
  | 'expire'
  | 'fund'
  | 'transfer'
  | 'swap'
  | 'account'
  | 'other';

export type TransactionStatus = 'pending' | 'completed' | 'failed';

export interface Transaction {
  id: string;
  type: TransactionType;
  label: string;
  asset: string;
  /** Human-readable amount, e.g. "0.005139" or "20.00" */
  amount: string;
  /** Optional USD value at time of transaction */
  usd_value?: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  status: TransactionStatus;
  /** NEAR transaction hash — links to explorer */
  tx_hash?: string;
}

// ── Config ──────────────────────────────────────────────────────────────────

const TX_TYPE_CONFIG: Record<TransactionType, {
  label: string;
  icon: string;
  bgColor: string;
  sign: '+' | '-' | '';
}> = {
  buy: {
    label: 'Buy',
    icon: 'M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z',
    bgColor: 'bg-[#9662FF]',
    sign: '+',
  },
  floor_opened: {
    label: 'Floor Opened',
    icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
    bgColor: 'bg-[#29CEB4]',
    sign: '',
  },
  sell_to_floor: {
    label: 'Sell to Floor',
    icon: 'M12 15V3m0 12l-4-4m4 4l4-4M2 17l.621 2.485A2 2 0 004.561 21h14.878a2 2 0 001.94-1.515L22 17',
    bgColor: 'bg-[#EF7B28]',
    sign: '-',
  },
  close: {
    label: 'Close',
    icon: 'M6 18L18 6M6 6l12 12',
    bgColor: 'bg-gray-500',
    sign: '',
  },
  expire: {
    label: 'Expired',
    icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
    bgColor: 'bg-gray-400',
    sign: '',
  },
  fund: {
    label: 'Fund',
    icon: 'M12 5v14M5 12h14',
    bgColor: 'bg-[#29CEB4]',
    sign: '+',
  },
  transfer: {
    label: 'Transfer',
    icon: 'M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4',
    bgColor: 'bg-blue-500',
    sign: '',
  },
  swap: {
    label: 'Swap',
    icon: 'M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4',
    bgColor: 'bg-[#9662FF]',
    sign: '',
  },
  account: {
    label: 'Account',
    icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
    bgColor: 'bg-gray-500',
    sign: '',
  },
  other: {
    label: 'Transaction',
    icon: 'M13 10V3L4 14h7v7l9-11h-7z',
    bgColor: 'bg-gray-400',
    sign: '',
  },
};

// ── Mapping helpers ─────────────────────────────────────────────────────────

/** Map API icon_type + method to our TransactionType */
function mapIconType(iconType: string, method: string | null): TransactionType {
  if (method === 'sell_to_floor') return 'sell_to_floor';
  if (method === 'close') return 'close';
  if (method === 'expire') return 'expire';

  switch (iconType) {
    case 'floor': return 'floor_opened';
    case 'swap': return 'swap';
    case 'transfer': return 'transfer';
    case 'account': return 'account';
    default: return 'other';
  }
}

/** Convert API activity transactions to our component format */
function mapApiTransactions(apiTxns: ActivityTransaction[]): Transaction[] {
  return apiTxns.map((tx) => ({
    id: tx.tx_hash,
    type: mapIconType(tx.icon_type, tx.method),
    label: tx.label,
    asset: '',
    amount: tx.deposit !== '0' ? tx.deposit : '',
    timestamp: tx.timestamp,
    status: tx.status === 'success' ? 'completed' as const : 'failed' as const,
    tx_hash: tx.tx_hash,
  }));
}

/** Convert buy_submissions to our component format */
function mapBuySubmissions(subs: ActivityBuySubmission[]): Transaction[] {
  return subs.map((s) => {
    const amountUsd = (Number(s.amount_usdc) / 1_000_000).toFixed(2);
    return {
      id: s.status_id,
      type: 'buy' as TransactionType,
      label: `Buy ${s.ticker}`,
      asset: s.ticker,
      amount: '',
      usd_value: amountUsd,
      timestamp: s.created_at,
      status: s.status === 'done' ? 'completed' as const
        : s.status === 'failed' ? 'failed' as const
          : 'pending' as const,
      ...(s.tx_hash ? { tx_hash: s.tx_hash } : {}),
    };
  });
}

/** Merge and deduplicate: buy_submissions with a tx_hash matching an on-chain tx get merged */
function mergeActivity(apiTxns: Transaction[], buys: Transaction[]): Transaction[] {
  const onChainHashes = new Set(apiTxns.map((t) => t.tx_hash).filter(Boolean));
  // Keep buy submissions that don't duplicate an on-chain tx
  const uniqueBuys = buys.filter((b) => !b.tx_hash || !onChainHashes.has(b.tx_hash));
  const merged = [...apiTxns, ...uniqueBuys];
  merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return merged;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function explorerUrl(txHash: string): string {
  return `https://testnet.nearblocks.io/txns/${txHash}`;
}

// ── Sub-components ──────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: TransactionStatus }) {
  if (status === 'pending') {
    return (
      <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-[#FAF9F6] text-gray-500 border border-gray-300">
        <span className="w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
        PENDING
      </span>
    );
  }
  if (status === 'completed') {
    return (
      <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-[#29CEB4]/15 text-[#1a9e8a] border border-[#29CEB4]/30">
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        DONE
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-red-50 text-red-600 border border-red-200">
      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
      FAILED
    </span>
  );
}

function TransactionRow({ tx, onTap }: { tx: Transaction; onTap: (tx: Transaction) => void }) {
  const config = TX_TYPE_CONFIG[tx.type];
  const displayLabel = tx.label || config.label;
  const displayAmount = tx.usd_value
    ? `$${tx.usd_value}`
    : tx.amount
      ? `${config.sign}${tx.amount}${tx.asset ? ` ${tx.asset}` : ''}`
      : '';

  return (
    <button
      onClick={() => onTap(tx)}
      className="w-full flex items-center gap-3 p-3 rounded-[14px] bg-white border-2 border-[#111] shadow-neo-sm shadow-neo-active text-left"
    >
      {/* Icon circle */}
      <div className={`w-10 h-10 ${config.bgColor} border-2 border-[#111] rounded-[10px] flex items-center justify-center shrink-0`}>
        <svg className="w-5 h-5 stroke-white fill-none stroke-[2.2]" viewBox="0 0 24 24">
          <path d={config.icon} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {/* Label + timestamp */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-extrabold text-[#111] truncate">{displayLabel}</p>
        <p className="text-[11px] font-semibold text-gray-400">{formatTimestamp(tx.timestamp)}</p>
      </div>

      {/* Amount + status */}
      <div className="flex flex-col items-end gap-1 shrink-0">
        {displayAmount && (
          <p className="text-sm font-extrabold text-[#111]">{displayAmount}</p>
        )}
        <StatusBadge status={tx.status} />
      </div>
    </button>
  );
}

// ── Pull-to-refresh hook ────────────────────────────────────────────────────

function usePullToRefresh(onRefresh: () => Promise<void>) {
  const [pulling, setPulling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const startY = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const THRESHOLD = 60;

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (containerRef.current && containerRef.current.scrollTop === 0) {
      startY.current = e.touches[0]?.clientY ?? 0;
      setPulling(true);
    }
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!pulling || refreshing) return;
    const currentY = e.touches[0]?.clientY ?? 0;
    const diff = Math.max(0, currentY - startY.current);
    setPullDistance(Math.min(diff * 0.5, 100));
  }, [pulling, refreshing]);

  const handleTouchEnd = useCallback(async () => {
    if (pullDistance >= THRESHOLD && !refreshing) {
      setRefreshing(true);
      setPullDistance(THRESHOLD);
      await onRefresh();
      setRefreshing(false);
    }
    setPulling(false);
    setPullDistance(0);
  }, [pullDistance, refreshing, onRefresh]);

  return {
    containerRef,
    pullDistance,
    refreshing,
    handlers: {
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
    },
  };
}

// ── Main component ──────────────────────────────────────────────────────────

interface ActivityFeedProps {
  /** Account ID for fetching transactions from the API */
  accountId: string;
  /** Override transactions for testing or when parent already has data */
  transactions?: Transaction[];
  /** Max items to show before "Show more" */
  limit?: number;
  /** Called when user taps a completed transaction — open explorer or detail */
  onTransactionTap?: (tx: Transaction) => void;
}

/**
 * ActivityFeed — chronological list of all user transactions.
 * Fetches from GET /v1/accounts/:account_id/activity.
 */
export default function ActivityFeed({
  accountId,
  transactions: externalTxns,
  limit = 20,
  onTransactionTap,
}: ActivityFeedProps) {
  const [txns, setTxns] = useState<Transaction[]>(externalTxns ?? []);
  const [loading, setLoading] = useState(!externalTxns);
  const [expanded, setExpanded] = useState(false);

  const fetchActivity = useCallback(async () => {
    if (!accountId) return;
    try {
      const data = await getActivity(accountId);
      const onChain = mapApiTransactions(data.transactions);
      const buys = mapBuySubmissions(data.buy_submissions);
      const merged = mergeActivity(onChain, buys);
      setTxns(merged.slice(0, limit));
    } catch (err) {
      console.warn('[floors] ActivityFeed fetch error:', err);
    }
  }, [accountId, limit]);

  useEffect(() => {
    if (externalTxns) return;
    let cancelled = false;
    setLoading(true);
    fetchActivity().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [fetchActivity, externalTxns]);

  const visibleTxns = expanded ? txns : txns.slice(0, 5);
  const hasMore = txns.length > 5 && !expanded;

  const handleRefresh = useCallback(async () => {
    await fetchActivity();
  }, [fetchActivity]);

  const { containerRef, pullDistance, refreshing, handlers } = usePullToRefresh(handleRefresh);

  const handleTap = useCallback((tx: Transaction) => {
    if (onTransactionTap) {
      onTransactionTap(tx);
      return;
    }
    if (tx.status === 'completed' && tx.tx_hash) {
      window.open(explorerUrl(tx.tx_hash), '_blank', 'noopener');
    }
  }, [onTransactionTap]);

  if (loading) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-xs font-extrabold text-gray-500 uppercase tracking-wider">Activity</h3>
        </div>
        <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo-sm p-6 text-center">
          <p className="text-sm font-semibold text-gray-500 flex items-center justify-center">
            <span className="w-4 h-4 border-2 border-[#111] border-t-transparent rounded-full animate-spin inline-block mr-2" />
            Loading activity…
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      {...handlers}
      className="flex flex-col gap-2"
    >
      {/* Pull-to-refresh indicator */}
      {(pullDistance > 0 || refreshing) && (
        <div
          className="flex items-center justify-center overflow-hidden transition-[height] duration-200"
          style={{ height: refreshing ? 40 : pullDistance * 0.6 }}
        >
          <div className={`w-5 h-5 border-2 border-[#111] border-t-transparent rounded-full ${refreshing ? 'animate-spin' : ''}`} />
        </div>
      )}

      {/* Section header */}
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-xs font-extrabold text-gray-500 uppercase tracking-wider">Activity</h3>
        {refreshing && (
          <span className="text-[10px] font-bold text-gray-400">Refreshing...</span>
        )}
      </div>

      {/* Transaction list */}
      {visibleTxns.length === 0 ? (
        <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo-sm p-6 text-center">
          <p className="text-sm font-extrabold text-[#111]">No activity yet</p>
          <p className="text-xs font-semibold text-gray-500 mt-1">
            Transactions appear here after you fund or trade.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {visibleTxns.map((tx) => (
            <TransactionRow key={tx.id} tx={tx} onTap={handleTap} />
          ))}
        </div>
      )}

      {/* Show more */}
      {hasMore && (
        <button
          onClick={() => setExpanded(true)}
          className="w-full py-2.5 text-xs font-extrabold text-[#9662FF] bg-white border-2 border-[#111] rounded-[12px] shadow-neo-sm shadow-neo-active"
        >
          Show {txns.length - 5} more
        </button>
      )}
    </div>
  );
}
