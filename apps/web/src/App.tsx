import { useState, useRef, useEffect, useCallback } from 'react';
import Welcome from './screens/Welcome';
import SignIn from './screens/SignIn';
import InviteCode from './screens/InviteCode';
import CreatePasskey from './screens/CreatePasskey';
import CreatingAccount from './screens/CreatingAccount';
import AccountReady from './screens/AccountReady';
import EnableTrading from './screens/EnableTrading';
import SetupDefaults from './screens/SetupDefaults';
import Fund from './screens/Fund';
import Home from './screens/Home';
import Portfolio from './screens/Portfolio';
import Activity from './screens/Activity';
import Settings from './screens/Settings';
import PositionDetail from './screens/PositionDetail';
import BottomNav from './components/BottomNav';
import { AppProvider, useApp as useAppFromContext } from './context/AppContext';
import type { Tab, SubScreen, OnboardingScreen, AppPhase } from './context/AppContext';

// Re-export types that existing onboarding screens import from '../App'
// Include 'portfolio' for backward compat — onboarding screens navigate('portfolio')
export type Screen = OnboardingScreen | 'portfolio';
export type { AccountState } from './context/AppContext';

// ── Onboarding screen order (for slide direction) ───────────────────────────

const ONBOARDING_ORDER: OnboardingScreen[] = [
  'welcome',
  'sign-in',
  'invite-code',
  'create-passkey',
  'creating-account',
  'account-ready',
  'setup-defaults',
  'enable-trading',
  'fund',
];

type ScreenClass = 'screen-enter-right' | 'screen-enter-left' | 'screen-active' | 'screen-exit-left' | 'screen-exit-right';

interface ScreenState {
  screen: OnboardingScreen;
  className: ScreenClass;
}

// ── Initial phase detection ─────────────────────────────────────────────────

function getInitialPhase(): AppPhase {
  const accountId = localStorage.getItem('floors:account_id');
  const credentialId = localStorage.getItem('floors:credential_id');
  if (accountId && credentialId) {
    return { phase: 'main', tab: 'home' };
  }
  if (accountId) {
    return { phase: 'onboarding', screen: 'sign-in' };
  }
  return { phase: 'onboarding', screen: 'welcome' };
}

function getInitialAccount() {
  const accountId = localStorage.getItem('floors:account_id');
  const credentialId = localStorage.getItem('floors:credential_id');
  const publicKey = localStorage.getItem('floors:public_key');
  const compressedKeyHex = localStorage.getItem('floors:compressed_key');
  if (accountId && credentialId && publicKey && compressedKeyHex) {
    return { accountId, credentialId, publicKey, compressedKeyHex };
  }
  return null;
}

export default function App() {
  const [account, setAccount] = useState(getInitialAccount);
  const [phase, setPhase] = useState<AppPhase>(getInitialPhase);

  // ── Onboarding transition state ───────────────────────────────────────────
  const initialOnboardingScreen =
    phase.phase === 'onboarding' ? phase.screen : 'welcome';

  const [screens, setScreens] = useState<ScreenState[]>([
    { screen: initialOnboardingScreen, className: 'screen-active' },
  ]);
  const isTransitioning = useRef(false);
  const pendingNavigate = useRef<OnboardingScreen | null>(null);

  // Navigate within onboarding OR transition to main phase
  const navigate = useCallback((to: Screen) => {
    // 'portfolio' means "transition to main phase"
    if (to === 'portfolio') {
      setPhase({ phase: 'main', tab: 'home' });
      return;
    }

    if (isTransitioning.current) {
      pendingNavigate.current = to;
      return;
    }

    setScreens((prev) => {
      const active = prev.find((s) => s.className === 'screen-active');
      if (!active || active.screen === to) return prev;

      const fromIdx = ONBOARDING_ORDER.indexOf(active.screen);
      const toIdx = ONBOARDING_ORDER.indexOf(to);
      const goingRight = toIdx > fromIdx;

      const withEntry: ScreenState[] = [
        ...prev.filter((s) => s.screen !== to),
        { screen: to, className: goingRight ? 'screen-enter-right' : 'screen-enter-left' },
      ];

      return withEntry;
    });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        isTransitioning.current = true;
        setScreens((prev) => {
          const active = prev.find((s) => s.className === 'screen-active');
          if (!active) return prev;

          const fromIdx = ONBOARDING_ORDER.indexOf(active.screen);
          const toIdx = ONBOARDING_ORDER.indexOf(to);
          const goingRight = toIdx > fromIdx;

          return prev.map((s) => {
            if (s.screen === to) {
              return { ...s, className: 'screen-active' };
            }
            if (s.screen === active.screen) {
              return { ...s, className: goingRight ? 'screen-exit-left' : 'screen-exit-right' };
            }
            return s;
          });
        });
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clean up exited onboarding screens; flush queued navigation
  useEffect(() => {
    if (phase.phase !== 'onboarding') return;
    const timer = setTimeout(() => {
      isTransitioning.current = false;
      setScreens((prev) => {
        const active = prev.find((s) => s.className === 'screen-active');
        if (!active) return prev;
        return [active];
      });
      const next = pendingNavigate.current;
      if (next !== null) {
        pendingNavigate.current = null;
        navigate(next);
      }
    }, 450);
    return () => clearTimeout(timer);
  }, [screens, navigate, phase.phase]);

  // ── Main phase navigation ─────────────────────────────────────────────────

  const switchTab = useCallback((tab: Tab) => {
    setPhase({ phase: 'main', tab });
  }, []);

  const pushSubScreen = useCallback((sub: SubScreen, params?: Record<string, string>) => {
    setPhase((prev) => {
      if (prev.phase !== 'main') return prev;
      return { phase: 'main' as const, tab: prev.tab, subScreen: sub, ...(params ? { subScreenParams: params } : {}) };
    });
  }, []);

  const popSubScreen = useCallback(() => {
    setPhase((prev) => {
      if (prev.phase !== 'main') return prev;
      return { phase: 'main' as const, tab: prev.tab };
    });
  }, []);

  const signOut = useCallback(() => {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('floors:')) keysToRemove.push(key);
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));

    setAccount(null);
    setPhase({ phase: 'onboarding', screen: 'welcome' });
    setScreens([{ screen: 'welcome', className: 'screen-active' }]);
  }, []);

  // ── Render helpers ────────────────────────────────────────────────────────

  const renderOnboardingScreen = (s: ScreenState) => {
    const props = {
      key: s.screen,
      navigate,
      account,
      setAccount,
      className: `screen ${s.className}`,
    };

    switch (s.screen) {
      case 'welcome':
        return <Welcome {...props} />;
      case 'sign-in':
        return <SignIn {...props} />;
      case 'invite-code':
        return <InviteCode {...props} />;
      case 'create-passkey':
        return <CreatePasskey {...props} />;
      case 'creating-account':
        return <CreatingAccount {...props} />;
      case 'account-ready':
        return <AccountReady {...props} />;
      case 'enable-trading':
        return <EnableTrading {...props} />;
      case 'setup-defaults':
        return <SetupDefaults {...props} />;
      case 'fund':
        return <Fund {...props} />;
    }
  };

  // ── Phase rendering ───────────────────────────────────────────────────────

  if (phase.phase === 'onboarding') {
    return (
      <div className="relative w-full h-full overflow-hidden bg-[#FAF9F6]">
        {screens.map(renderOnboardingScreen)}
      </div>
    );
  }

  // Main phase
  const activeTab = phase.tab;
  const subScreen = phase.subScreen;
  const subScreenParams = phase.subScreenParams;

  return (
    <AppProvider
      account={account}
      setAccount={setAccount}
      switchTab={switchTab}
      pushSubScreen={pushSubScreen}
      popSubScreen={popSubScreen}
      signOut={signOut}
    >
      <div className="relative w-full h-full overflow-hidden bg-[#FAF9F6]">
        {/* Tab content — all 4 tabs mounted, show/hide for scroll preservation */}
        <div style={{ display: activeTab === 'home' && !subScreen ? 'block' : 'none' }}>
          <Home />
        </div>
        <div style={{ display: activeTab === 'portfolio' && !subScreen ? 'block' : 'none' }}>
          <Portfolio />
        </div>
        <div style={{ display: activeTab === 'activity' && !subScreen ? 'block' : 'none' }}>
          <Activity />
        </div>
        <div style={{ display: activeTab === 'settings' && !subScreen ? 'block' : 'none' }}>
          <Settings />
        </div>

        {/* Sub-screen overlay */}
        {subScreen === 'position-detail' && (
          <div className="absolute inset-0 z-20 bg-[#FAF9F6]">
            <PositionDetail params={subScreenParams ?? {}} />
          </div>
        )}
        {subScreen === 'fund-account' && (
          <div className="absolute inset-0 z-20 bg-[#FAF9F6]">
            <FundSubScreen />
          </div>
        )}

        {/* Bottom navigation */}
        <BottomNav
          activeTab={activeTab}
          onTabChange={switchTab}
        />
      </div>
    </AppProvider>
  );
}

// ── Fund as sub-screen wrapper ──────────────────────────────────────────────

function FundSubScreen() {
  const { account, setAccount, popSubScreen } = useAppFromContext();

  const fundNavigate = useCallback((_to: Screen) => {
    popSubScreen();
  }, [popSubScreen]);

  return (
    <Fund
      navigate={fundNavigate}
      account={account}
      setAccount={setAccount}
      className="absolute inset-0 overflow-y-auto bg-[#FAF9F6]"
    />
  );
}
