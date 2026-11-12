import { useEffect } from 'react';
import type { Screen, AccountState } from '../App';

interface Props {
  navigate: (to: Screen) => void;
  account: AccountState | null;
  setAccount: (a: AccountState | null) => void;
  className: string;
}

export default function CreatingAccount({ navigate, account, className }: Props) {
  useEffect(() => {
    // In S5: stub — just wait 2s then succeed
    const timer = setTimeout(() => {
      navigate('account-ready');
    }, 2000);
    return () => clearTimeout(timer);
  }, [navigate, account]);

  return (
    <div className={className}>
      <div className="flex flex-col items-center justify-center min-h-full px-6 py-12 gap-8">
        {/* Spinner */}
        <div className="relative">
          <div className="w-20 h-20 border-4 border-[#EF7B28] border-t-transparent rounded-full animate-spin" />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-8 h-8 border-2 border-[#111] rounded-full bg-white shadow-neo-sm" />
          </div>
        </div>

        {/* Status text */}
        <div className="flex flex-col items-center gap-2 text-center">
          <h2 className="text-2xl font-extrabold text-[#111]">Setting up your account…</h2>
          <p className="text-base font-semibold text-gray-500">
            Creating your NEAR wallet. This takes a moment.
          </p>
        </div>

        {/* Progress steps */}
        <div className="flex flex-col gap-3 w-full max-w-xs">
          {[
            { label: 'Passkey created', done: true },
            { label: 'Generating wallet address', done: false },
            { label: 'Registering on-chain', done: false },
          ].map(({ label, done }) => (
            <div key={label} className="flex items-center gap-3">
              <div
                className={`w-5 h-5 shrink-0 rounded-full border-2 border-[#111] flex items-center justify-center ${
                  done ? 'bg-[#29CEB4]' : 'bg-white'
                }`}
              >
                {done && (
                  <svg className="w-2.5 h-2.5 stroke-current fill-none stroke-[3]" viewBox="0 0 24 24">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </div>
              <span className={`text-sm font-semibold ${done ? 'text-[#111]' : 'text-gray-400'}`}>
                {label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
