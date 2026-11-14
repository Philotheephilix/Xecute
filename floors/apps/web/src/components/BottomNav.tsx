import type { ReactNode } from 'react';
import type { Tab } from '../context/AppContext';

// ── Inline SVG icons ────────────────────────────────────────────────────────

function HomeIcon({ active }: { active: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      {active ? (
        <path
          d="M3 10.5L12 3l9 7.5V20a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1V10.5z"
          fill="#EF7B28"
          stroke="#111"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M3 10.5L12 3l9 7.5V20a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1V10.5z"
          stroke="#111"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function PortfolioIcon({ active }: { active: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      {active ? (
        <>
          <rect x="3" y="3" width="18" height="18" rx="3" fill="#EF7B28" stroke="#111" strokeWidth="1.5" />
          <polyline points="7 14 10 10 14 13 17 8" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </>
      ) : (
        <>
          <rect x="3" y="3" width="18" height="18" rx="3" stroke="#111" strokeWidth="1.8" fill="none" />
          <polyline points="7 14 10 10 14 13 17 8" stroke="#111" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </>
      )}
    </svg>
  );
}

function ActivityIcon({ active }: { active: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      {active ? (
        <>
          <circle cx="12" cy="12" r="9" fill="#EF7B28" stroke="#111" strokeWidth="1.5" />
          <polyline points="12 7 12 12 15 14" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="9" stroke="#111" strokeWidth="1.8" />
          <polyline points="12 7 12 12 15 14" stroke="#111" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

function SettingsIcon({ active }: { active: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      {active ? (
        <path
          d="M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"
          fill="#EF7B28"
          stroke="#111"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"
          stroke="#111"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      )}
    </svg>
  );
}

// ── Tab config ──────────────────────────────────────────────────────────────

interface TabConfig {
  id: Tab;
  label: string;
  Icon: (props: { active: boolean }) => ReactNode;
  badge?: 'number' | 'dot';
}

const TABS: TabConfig[] = [
  { id: 'home', label: 'Home', Icon: HomeIcon },
  { id: 'portfolio', label: 'Portfolio', Icon: PortfolioIcon, badge: 'number' },
  { id: 'activity', label: 'Activity', Icon: ActivityIcon, badge: 'dot' },
  { id: 'settings', label: 'Settings', Icon: SettingsIcon },
];

// ── Component ───────────────────────────────────────────────────────────────

interface BottomNavProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  positionCount?: number;
  pendingTxCount?: number;
}

export default function BottomNav({
  activeTab,
  onTabChange,
  positionCount = 0,
  pendingTxCount = 0,
}: BottomNavProps) {
  return (
    <nav className="bottom-nav" aria-label="Main navigation">
      {TABS.map(({ id, label, Icon, badge }) => {
        const isActive = activeTab === id;
        const showNumberBadge = badge === 'number' && positionCount > 0;
        const showDotBadge = badge === 'dot' && pendingTxCount > 0;

        return (
          <button
            key={id}
            onClick={() => onTabChange(id)}
            className={`flex flex-col items-center justify-center gap-0.5 flex-1 h-full active:translate-y-[1px] transition-transform ${
              isActive ? 'opacity-100' : 'opacity-40'
            }`}
            aria-label={label}
            aria-current={isActive ? 'page' : undefined}
          >
            <div className="relative">
              <Icon active={isActive} />

              {/* Number badge (Portfolio) */}
              {showNumberBadge && (
                <span className="absolute -top-1.5 -right-2.5 min-w-[18px] h-[18px] bg-[#EF7B28] text-white text-[10px] font-extrabold border border-[#111] rounded-full flex items-center justify-center px-1">
                  {positionCount > 99 ? '99+' : positionCount}
                </span>
              )}

              {/* Dot badge (Activity) */}
              {showDotBadge && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-[#EF7B28] border border-[#111] rounded-full" />
              )}
            </div>

            <span
              className={`text-[10px] leading-tight ${
                isActive
                  ? 'font-extrabold text-[#111]'
                  : 'font-bold text-gray-400'
              }`}
            >
              {label}
            </span>

            {/* Active indicator dot */}
            {isActive && (
              <span className="w-1 h-1 rounded-full bg-[#EF7B28]" />
            )}
          </button>
        );
      })}
    </nav>
  );
}
