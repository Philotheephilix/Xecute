import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';
import type { Position } from '../api/client';
import { getPositions } from '../api/client';

// ── Types ───────────────────────────────────────────────────────────────────

export interface AccountState {
  accountId: string;
  credentialId: string;
  publicKey: string;
  /** 66-char hex-encoded compressed SEC1 P-256 public key (33 bytes) */
  compressedKeyHex: string;
  /** Invite code supplied during onboarding; present only when invite mode was active */
  inviteCode?: string;
}

export type Tab = 'home' | 'portfolio' | 'activity' | 'settings';

export type SubScreen = 'position-detail' | 'fund-account';

export type OnboardingScreen =
  | 'welcome'
  | 'sign-in'
  | 'invite-code'
  | 'create-passkey'
  | 'creating-account'
  | 'account-ready'
  | 'enable-trading'
  | 'setup-defaults'
  | 'fund';

export type AppPhase =
  | { phase: 'onboarding'; screen: OnboardingScreen }
  | { phase: 'main'; tab: Tab; subScreen?: SubScreen; subScreenParams?: Record<string, string> };

// ── Context value ───────────────────────────────────────────────────────────

export interface AppContextValue {
  account: AccountState | null;
  setAccount: (a: AccountState | null) => void;
  positions: Position[];
  balances: { near: string | null; usdc: string | null };
  refreshPositions: () => Promise<void>;
  isLoadingPositions: boolean;

  // Navigation
  switchTab: (tab: Tab) => void;
  pushSubScreen: (sub: SubScreen, params?: Record<string, string>) => void;
  popSubScreen: () => void;
  signOut: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

// ── Hook ────────────────────────────────────────────────────────────────────

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

// ── Provider ────────────────────────────────────────────────────────────────

interface AppProviderProps {
  children: ReactNode;
  account: AccountState | null;
  setAccount: (a: AccountState | null) => void;
  switchTab: (tab: Tab) => void;
  pushSubScreen: (sub: SubScreen, params?: Record<string, string>) => void;
  popSubScreen: () => void;
  signOut: () => void;
}

export function AppProvider({
  children,
  account,
  setAccount,
  switchTab,
  pushSubScreen,
  popSubScreen,
  signOut,
}: AppProviderProps) {
  const [positions, setPositions] = useState<Position[]>([]);
  const [balances, setBalances] = useState<{ near: string | null; usdc: string | null }>({
    near: null,
    usdc: null,
  });
  const [isLoadingPositions, setIsLoadingPositions] = useState(false);

  const refreshPositions = useCallback(async () => {
    if (!account) return;
    setIsLoadingPositions(true);
    try {
      const { positions: pos, near_balance, usdc_balance } = await getPositions(account.accountId);
      setPositions(pos);
      setBalances({ near: near_balance, usdc: usdc_balance });
    } catch {
      setPositions([]);
      setBalances({ near: null, usdc: null });
    } finally {
      setIsLoadingPositions(false);
    }
  }, [account]);

  // Fetch positions on mount and when account changes
  useEffect(() => {
    if (account) {
      void refreshPositions();
    } else {
      setPositions([]);
      setBalances({ near: null, usdc: null });
    }
  }, [account, refreshPositions]);

  const value: AppContextValue = {
    account,
    setAccount,
    positions,
    balances,
    refreshPositions,
    isLoadingPositions,
    switchTab,
    pushSubScreen,
    popSubScreen,
    signOut,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
