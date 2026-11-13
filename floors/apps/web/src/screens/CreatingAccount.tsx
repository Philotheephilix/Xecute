import { useEffect, useRef, useState } from 'react';
import type { Screen, AccountState } from '../App';
import { getAccount } from '../api/client';

interface Props {
  navigate: (to: Screen) => void;
  account: AccountState | null;
  setAccount: (a: AccountState | null) => void;
  className: string;
}

type StepStatus = 'done' | 'active' | 'pending';

interface Step {
  label: string;
  status: StepStatus;
}

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 30_000;

export default function CreatingAccount({ navigate, account, className }: Props) {
  const [steps, setSteps] = useState<Step[]>([
    { label: 'Passkey created', status: 'done' },
    { label: 'Creating NEAR account…', status: 'active' },
    { label: 'Registering on-chain', status: 'pending' },
  ]);
  const [error, setError] = useState<string | null>(null);
  const pollingRef = useRef(false);
  const startTimeRef = useRef(Date.now());

  const markStep = (index: number, status: StepStatus) => {
    setSteps((prev) =>
      prev.map((s, i) => (i === index ? { ...s, status } : s)),
    );
  };

  const runPolling = async () => {
    const accountId = account?.accountId;
    if (!accountId) {
      setError('Account ID missing — please restart onboarding');
      return;
    }

    pollingRef.current = true;
    startTimeRef.current = Date.now();

    while (pollingRef.current) {
      const elapsed = Date.now() - startTimeRef.current;
      if (elapsed >= POLL_TIMEOUT_MS) {
        setError('Account creation timed out. Please try again.');
        markStep(1, 'pending');
        return;
      }

      try {
        const acct = await getAccount(accountId);
        if (acct !== null) {
          // Account confirmed on API — step 2 done, show step 3 briefly then navigate
          markStep(1, 'done');
          markStep(2, 'active');

          await new Promise<void>((r) => setTimeout(r, 700));

          markStep(2, 'done');

          await new Promise<void>((r) => setTimeout(r, 300));

          navigate('account-ready');
          return;
        }
      } catch (err) {
        // Non-404 errors: log and keep polling (transient network issues)
        console.warn('[floors] CreatingAccount poll error:', err);
      }

      await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  };

  useEffect(() => {
    void runPolling();
    return () => {
      pollingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRetry = () => {
    setError(null);
    setSteps([
      { label: 'Passkey created', status: 'done' },
      { label: 'Creating NEAR account…', status: 'active' },
      { label: 'Registering on-chain', status: 'pending' },
    ]);
    void runPolling();
  };

  return (
    <div className={className}>
      <div className="flex flex-col items-center justify-center min-h-full px-6 py-12 gap-8">
        {/* Spinner — hidden on error */}
        {error === null && (
          <div className="relative">
            <div className="w-20 h-20 border-4 border-[#EF7B28] border-t-transparent rounded-full animate-spin" />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-8 h-8 border-2 border-[#111] rounded-full bg-white shadow-neo-sm" />
            </div>
          </div>
        )}

        {/* Error state */}
        {error !== null && (
          <div className="w-20 h-20 border-4 border-[#EF7B28] rounded-full flex items-center justify-center bg-white shadow-neo">
            <svg className="w-8 h-8 stroke-[#EF7B28] fill-none stroke-[2.5]" viewBox="0 0 24 24">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </div>
        )}

        {/* Status text */}
        <div className="flex flex-col items-center gap-2 text-center">
          <h2 className="text-2xl font-extrabold text-[#111]">
            {error !== null ? 'Something went wrong' : 'Setting up your account…'}
          </h2>
          <p className="text-base font-semibold text-gray-500">
            {error !== null ? error : 'Creating your NEAR wallet. This takes a moment.'}
          </p>
        </div>

        {/* Progress steps */}
        <div className="flex flex-col gap-3 w-full max-w-xs">
          {steps.map(({ label, status }) => (
            <div key={label} className="flex items-center gap-3">
              <div
                className={`w-5 h-5 shrink-0 rounded-full border-2 border-[#111] flex items-center justify-center transition-colors ${
                  status === 'done'
                    ? 'bg-[#29CEB4]'
                    : status === 'active'
                      ? 'bg-[#EF7B28]'
                      : 'bg-white'
                }`}
              >
                {status === 'done' && (
                  <svg className="w-2.5 h-2.5 stroke-current fill-none stroke-[3]" viewBox="0 0 24 24">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
                {status === 'active' && (
                  <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
                )}
              </div>
              <span
                className={`text-sm font-semibold transition-colors ${
                  status === 'done'
                    ? 'text-[#111]'
                    : status === 'active'
                      ? 'text-[#EF7B28]'
                      : 'text-gray-400'
                }`}
              >
                {label}
              </span>
            </div>
          ))}
        </div>

        {/* Retry button on error */}
        {error !== null && (
          <button
            onClick={handleRetry}
            className="w-full max-w-xs h-14 bg-[#EF7B28] text-white border-2 border-[#111] rounded-[13px] text-base font-extrabold shadow-neo shadow-neo-active"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
