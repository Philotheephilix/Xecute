import { useState, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { getActivity } from '../api/client';
import type { ActivityTransaction, ActivityBuySubmission } from '../api/client';

// ── Types ──────────────────────────────────────────────────────────────────

type FilterTab = 'all' | 'floors' | 'swaps' | 'funding';

type ActivityType = 'floor_opened' | 'sold_to_floor' | 'floor_closed' | 'floor_expired' | 'buy_swap' | 'fund' | 'transfer' | 'account' | 'other';

interface ActivityEvent {
  id: string;
  type: ActivityType;
  description: string;
  amount: string;
  timestamp: Date;
  status: 'completed' | 'pending' | 'failed';
  filterCategory: FilterTab;
  tx_hash?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function getDateGroupLabel(date: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const eventDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (eventDay.getTime() === today.getTime()) return 'Today';
  if (eventDay.getTime() === yesterday.getTime()) return 'Yesterday';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function groupByDate(events: ActivityEvent[]): { label: string; events: ActivityEvent[] }[] {
  const groups = new Map<string, ActivityEvent[]>();
  const sorted = [...events].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  for (const event of sorted) {
    const label = getDateGroupLabel(event.timestamp);
    const group = groups.get(label);
    if (group) {
      group.push(event);
    } else {
      groups.set(label, [event]);
    }
  }

  return Array.from(groups.entries()).map(([label, evts]) => ({ label, events: evts }));
}

function explorerUrl(txHash: string): string {
  return `https://testnet.nearblocks.io/txns/${txHash}`;
}

// ── Mapping from API response ───────────────────────────────────────────────

function mapIconTypeToActivityType(iconType: string, method: string | null): ActivityType {
  if (method === 'sell_to_floor') return 'sold_to_floor';
  if (method === 'close') return 'floor_closed';
  if (method === 'expire') return 'floor_expired';

  switch (iconType) {
    case 'floor': return 'floor_opened';
    case 'swap': return 'buy_swap';
    case 'transfer': return 'transfer';
    case 'account': return 'account';
    default: return 'other';
  }
}

function filterCategoryFor(actType: ActivityType): FilterTab {
  switch (actType) {
    case 'floor_opened':
    case 'sold_to_floor':
    case 'floor_closed':
    case 'floor_expired':
      return 'floors';
    case 'buy_swap':
      return 'swaps';
    case 'fund':
    case 'transfer':
      return 'funding';
    default:
      return 'all';
  }
}

function mapApiTransactions(apiTxns: ActivityTransaction[], accountId: string): ActivityEvent[] {
  return apiTxns.map((tx): ActivityEvent => {
    const actType = mapIconTypeToActivityType(tx.icon_type, tx.method);
    const isIncoming = tx.receiver === accountId;
    const depositDisplay = tx.deposit !== '0' ? tx.deposit : '';
    const amountStr = depositDisplay
      ? (isIncoming ? `+${depositDisplay}` : `-${depositDisplay}`)
      : '';

    return {
      id: tx.tx_hash,
      type: actType,
      description: tx.label,
      amount: amountStr,
      timestamp: new Date(tx.timestamp),
      status: tx.status === 'success' ? 'completed' : 'failed',
      filterCategory: filterCategoryFor(actType),
      tx_hash: tx.tx_hash,
    };
  });
}

function mapBuySubmissions(subs: ActivityBuySubmission[]): ActivityEvent[] {
  return subs.map((s): ActivityEvent => {
    const amountUsd = (Number(s.amount_usdc) / 1_000_000).toFixed(2);
    return {
      id: s.status_id,
      type: 'buy_swap',
      description: `Buy ${s.ticker}`,
      amount: `-$${amountUsd} USDC`,
      timestamp: new Date(s.created_at),
      status: s.status === 'done' ? 'completed'
        : s.status === 'failed' ? 'failed'
          : 'pending',
      filterCategory: 'swaps',
      ...(s.tx_hash ? { tx_hash: s.tx_hash } : {}),
    };
  });
}

function mergeEvents(txnEvents: ActivityEvent[], buyEvents: ActivityEvent[]): ActivityEvent[] {
  const onChainHashes = new Set(txnEvents.map((e) => e.tx_hash).filter(Boolean));
  const uniqueBuys = buyEvents.filter((b) => !b.tx_hash || !onChainHashes.has(b.tx_hash));
  const merged = [...txnEvents, ...uniqueBuys];
  merged.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return merged;
}

// ── Icons ───────────────────────────────────────────────────────────────────

function ActivityIcon({ type }: { type: ActivityType }) {
  const configs: Record<ActivityType, { bg: string; icon: React.ReactNode }> = {
    buy_swap: {
      bg: 'bg-[#29CEB4]',
      icon: (
        <svg className="w-4 h-4 stroke-white fill-none stroke-[2.2]" viewBox="0 0 24 24">
          <path d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
      ),
    },
    floor_opened: {
      bg: 'bg-[#EF7B28]',
      icon: (
        <svg className="w-4 h-4 stroke-white fill-none stroke-[2.2]" viewBox="0 0 24 24">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      ),
    },
    sold_to_floor: {
      bg: 'bg-[#29CEB4]',
      icon: (
        <svg className="w-4 h-4 stroke-white fill-none stroke-[2.2]" viewBox="0 0 24 24">
          <path d="M12 5v14M5 12l7 7 7-7" />
        </svg>
      ),
    },
    floor_closed: {
      bg: 'bg-gray-400',
      icon: (
        <svg className="w-4 h-4 stroke-white fill-none stroke-[2.2]" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10" />
          <path d="M15 9l-6 6M9 9l6 6" />
        </svg>
      ),
    },
    floor_expired: {
      bg: 'bg-gray-400',
      icon: (
        <svg className="w-4 h-4 stroke-white fill-none stroke-[2.2]" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
      ),
    },
    fund: {
      bg: 'bg-[#9662FF]',
      icon: (
        <svg className="w-4 h-4 stroke-white fill-none stroke-[2.5]" viewBox="0 0 24 24">
          <path d="M12 5v14M5 12h14" />
        </svg>
      ),
    },
    transfer: {
      bg: 'bg-blue-500',
      icon: (
        <svg className="w-4 h-4 stroke-white fill-none stroke-[2.2]" viewBox="0 0 24 24">
          <path d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
        </svg>
      ),
    },
    account: {
      bg: 'bg-gray-500',
      icon: (
        <svg className="w-4 h-4 stroke-white fill-none stroke-[2.2]" viewBox="0 0 24 24">
          <path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
      ),
    },
    other: {
      bg: 'bg-gray-400',
      icon: (
        <svg className="w-4 h-4 stroke-white fill-none stroke-[2.2]" viewBox="0 0 24 24">
          <path d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      ),
    },
  };

  const config = configs[type];
  return (
    <div className={`w-9 h-9 ${config.bg} rounded-full border-2 border-[#111] flex items-center justify-center shrink-0`}>
      {config.icon}
    </div>
  );
}

function StatusDot({ status }: { status: ActivityEvent['status'] }) {
  if (status === 'completed') {
    return <span className="w-2 h-2 rounded-full bg-[#29CEB4] border border-[#111] shrink-0" />;
  }
  if (status === 'pending') {
    return <span className="w-2 h-2 rounded-full bg-yellow-400 border border-[#111] shrink-0" />;
  }
  return <span className="w-2 h-2 rounded-full bg-red-500 border border-[#111] shrink-0" />;
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function Activity() {
  const { account, pushSubScreen } = useApp();
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all');
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const accountId = account?.accountId ?? '';

  const fetchEvents = useCallback(async () => {
    if (!accountId) return;
    const data = await getActivity(accountId);
    const txnEvents = mapApiTransactions(data.transactions, accountId);
    const buyEvents = mapBuySubmissions(data.buy_submissions);
    return mergeEvents(txnEvents, buyEvents);
  }, [accountId]);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    setLoading(true);
    fetchEvents()
      .then((merged) => {
        if (!cancelled && merged) setEvents(merged);
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [fetchEvents, accountId]);

  const filteredEvents = activeFilter === 'all'
    ? events
    : events.filter((e) => e.filterCategory === activeFilter);

  const dateGroups = groupByDate(filteredEvents);

  const filters: { key: FilterTab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'floors', label: 'Floors' },
    { key: 'swaps', label: 'Swaps' },
    { key: 'funding', label: 'Funding' },
  ];

  return (
    <div className="tab-content">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 border-b-2 border-[#111] bg-[#FAF9F6]">
        <h1 className="text-xl font-extrabold text-[#111] text-center">Activity</h1>

        {/* Filter tabs */}
        <div className="flex gap-2 mt-4 overflow-x-auto no-scrollbar">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setActiveFilter(f.key)}
              className={`px-4 py-1.5 rounded-full border-2 border-[#111] text-sm font-extrabold whitespace-nowrap transition-colors ${
                activeFilter === f.key
                  ? 'bg-[#EF7B28] text-white'
                  : 'bg-white text-gray-500'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="px-6 py-5">
        {loading ? (
          <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo-sm p-6 text-center">
            <p className="text-sm font-semibold text-gray-500 flex items-center justify-center">
              <span className="w-4 h-4 border-2 border-[#111] border-t-transparent rounded-full animate-spin inline-block mr-2" />
              Loading activity…
            </p>
          </div>
        ) : filteredEvents.length === 0 ? (
          <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo-sm p-8 flex flex-col items-center gap-4 text-center">
            <div className="w-14 h-14 bg-[#FAF9F6] border-2 border-[#111] rounded-full flex items-center justify-center">
              <svg className="w-7 h-7 stroke-gray-400 fill-none stroke-[2]" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
            </div>
            <div>
              <p className="text-base font-extrabold text-[#111]">No activity yet</p>
              <p className="text-sm font-semibold text-gray-500 mt-1">
                Your trades and floor events will appear here
              </p>
            </div>
            <button
              onClick={() => pushSubScreen('fund-account')}
              className="px-6 py-3 bg-[#EF7B28] text-white border-2 border-[#111] rounded-[13px] text-sm font-extrabold shadow-neo-sm shadow-neo-active"
            >
              Buy with Floor
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {dateGroups.map((group) => (
              <div key={group.label}>
                <p className="text-xs font-extrabold text-gray-400 uppercase tracking-wider mb-2">
                  {group.label}
                </p>
                <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo-sm divide-y-2 divide-[#111] overflow-hidden">
                  {group.events.map((event) => (
                    <button
                      key={event.id}
                      onClick={() => {
                        if (event.tx_hash) {
                          window.open(explorerUrl(event.tx_hash), '_blank', 'noopener');
                        }
                      }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left"
                    >
                      <ActivityIcon type={event.type} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-extrabold text-[#111] truncate">
                          {event.description}
                        </p>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <StatusDot status={event.status} />
                          <span className="text-[11px] font-semibold text-gray-400">
                            {formatRelativeTime(event.timestamp)}
                          </span>
                          {event.tx_hash && (
                            <span className="text-[10px] font-mono text-gray-300 truncate max-w-[80px]">
                              {event.tx_hash.slice(0, 8)}…
                            </span>
                          )}
                        </div>
                      </div>
                      <p className="text-sm font-bold text-[#111] text-right shrink-0">
                        {event.amount}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
