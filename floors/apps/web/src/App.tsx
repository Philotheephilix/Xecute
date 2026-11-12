import { useState, useRef, useEffect } from 'react';
import Welcome from './screens/Welcome';
import CreatePasskey from './screens/CreatePasskey';
import CreatingAccount from './screens/CreatingAccount';
import AccountReady from './screens/AccountReady';
import Fund from './screens/Fund';
import Portfolio from './screens/Portfolio';

export type Screen =
  | 'welcome'
  | 'create-passkey'
  | 'creating-account'
  | 'account-ready'
  | 'fund'
  | 'portfolio';

export interface AccountState {
  accountId: string;
  credentialId: string;
  publicKey: string;
}

const SCREEN_ORDER: Screen[] = [
  'welcome',
  'create-passkey',
  'creating-account',
  'account-ready',
  'fund',
  'portfolio',
];

type ScreenClass = 'screen-enter-right' | 'screen-enter-left' | 'screen-active' | 'screen-exit-left' | 'screen-exit-right';

interface ScreenState {
  screen: Screen;
  className: ScreenClass;
}

export default function App() {
  const [account, setAccount] = useState<AccountState | null>(null);
  const [screens, setScreens] = useState<ScreenState[]>([
    { screen: 'welcome', className: 'screen-active' },
  ]);
  const isTransitioning = useRef(false);

  const navigate = (to: Screen) => {
    if (isTransitioning.current) return;

    setScreens((prev) => {
      const active = prev.find((s) => s.className === 'screen-active');
      if (!active || active.screen === to) return prev;

      const fromIdx = SCREEN_ORDER.indexOf(active.screen);
      const toIdx = SCREEN_ORDER.indexOf(to);
      const goingRight = toIdx > fromIdx;

      // Add the target screen off-screen
      const withEntry: ScreenState[] = [
        ...prev.filter((s) => s.screen !== to),
        { screen: to, className: goingRight ? 'screen-enter-right' : 'screen-enter-left' },
      ];

      return withEntry;
    });

    // On next frame, trigger the transition
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        isTransitioning.current = true;
        setScreens((prev) => {
          const active = prev.find((s) => s.className === 'screen-active');
          if (!active) return prev;

          const fromIdx = SCREEN_ORDER.indexOf(active.screen);
          const toIdx = SCREEN_ORDER.indexOf(to);
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
  };

  // Clean up exited screens after transition
  useEffect(() => {
    const timer = setTimeout(() => {
      isTransitioning.current = false;
      setScreens((prev) => {
        const active = prev.find((s) => s.className === 'screen-active');
        if (!active) return prev;
        return [active];
      });
    }, 450);
    return () => clearTimeout(timer);
  }, [screens]);

  const renderScreen = (s: ScreenState) => {
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
      case 'create-passkey':
        return <CreatePasskey {...props} />;
      case 'creating-account':
        return <CreatingAccount {...props} />;
      case 'account-ready':
        return <AccountReady {...props} />;
      case 'fund':
        return <Fund {...props} />;
      case 'portfolio':
        return <Portfolio {...props} />;
    }
  };

  return (
    <div className="relative w-full h-full overflow-hidden bg-[#FAF9F6]">
      {screens.map(renderScreen)}
    </div>
  );
}
