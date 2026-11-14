import { useState } from 'react';
import type { Screen, AccountState } from '../App';
import { enableTrading } from '../api/client';

interface Props {
  navigate: (to: Screen) => void;
  account: AccountState | null;
  setAccount: (a: AccountState | null) => void;
  className: string;
}

type Phase = 'idle' | 'submitting' | 'skipping' | 'done' | 'error';

export default function EnableTrading({ navigate, account, className }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);

  const accountId = account?.accountId;
  const publicKey = account?.compressedKeyHex;

  const handleEnable = async () => {
    if (!accountId || !publicKey) {
      setError('Account not found — please restart onboarding');
      setPhase('error');
      return;
    }

    setError(null);
    setPhase('submitting');

    try {
      await enableTrading(accountId, publicKey);
      setPhase('done');
      await new Promise<void>((r) => setTimeout(r, 600));
      navigate('fund');
    } catch (err) {
      console.error('[floors] enable-trading error:', err);
      setError(err instanceof Error ? err.message : 'Registration failed');
      setPhase('error');
    }
  };

  const handleSkip = () => {
    navigate('fund');
  };

  const isLoading = phase === 'submitting' || phase === 'skipping';

  const phaseLabel: Record<Phase, string> = {
    idle: 'Enable Trading',
    submitting: 'Registering on NEAR…',
    skipping: 'Setup not available, continuing…',
    done: 'Trading enabled!',
    error: 'Try again',
  };

  return (
    <div className={className}>
      <div className="flex flex-col min-h-full px-6 py-8">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <button
            onClick={() => navigate('setup-defaults')}
            className="w-11 h-11 bg-white border-2 border-[#111] rounded-[13px] shadow-neo-sm shadow-neo-active flex items-center justify-center"
            aria-label="Go back"
          >
            <svg className="w-5 h-5 stroke-current fill-none stroke-[2.5]" viewBox="0 0 24 24">
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
          </button>
          <span className="text-base font-extrabold text-[#111]">Enable Trading</span>
        </div>

        {/* Title */}
        <h1 className="text-3xl font-extrabold text-[#111] leading-tight mb-3">
          Register with NEAR Intents
        </h1>
        <p className="text-base font-semibold text-gray-600 leading-relaxed mb-10">
          One tap registers your key with NEAR Intents.
        </p>

        {/* Illustration */}
        <div className="flex justify-center mb-10">
          <div className="w-32 h-32 bg-white border-2 border-[#111] rounded-[18px] shadow-neo flex items-center justify-center">
            <svg
              viewBox="0 0 80 80"
              className="w-20 h-20"
              fill="none"
              aria-label="Lightning bolt"
            >
              <circle cx="40" cy="40" r="28" stroke="#9662FF" strokeWidth="2.5" strokeDasharray="5 3" />
              <path
                d="M44 16 L30 42 L40 42 L36 64 L52 36 L42 36 Z"
                fill="#9662FF"
                stroke="#111"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>

        {/* What this does */}
        <div className="flex flex-col gap-3 mb-10">
          {[
            'Registers your passkey with NEAR Intents',
            'Required to buy and sell crypto',
          ].map((feat) => (
            <div key={feat} className="flex items-start gap-3">
              <div className="w-5 h-5 shrink-0 mt-0.5 rounded-full bg-[#9662FF] border-2 border-[#111] flex items-center justify-center">
                <svg className="w-2.5 h-2.5 stroke-white fill-none stroke-[3]" viewBox="0 0 24 24">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <span className="text-sm font-semibold text-gray-700">{feat}</span>
            </div>
          ))}
        </div>

        {/* H8: Skipping notice — shown briefly when endpoint is unavailable */}
        {phase === 'skipping' && (
          <div className="mb-6 p-4 bg-white border-2 border-[#111] rounded-[18px] shadow-neo-sm flex items-center gap-3">
            <span className="w-5 h-5 border-2 border-[#111] border-t-transparent rounded-full animate-spin shrink-0" />
            <p className="text-sm font-bold text-[#111]">Setup not available, continuing…</p>
          </div>
        )}

        {/* Error card */}
        {error !== null && (
          <div className="mb-6 p-4 bg-white border-2 border-[#EF7B28] rounded-[18px] shadow-neo-sm">
            <p className="text-sm font-bold text-[#EF7B28]">{error}</p>
          </div>
        )}

        <div className="mt-auto flex flex-col gap-3">
          <button
            onClick={handleEnable}
            disabled={isLoading || phase === 'done'}
            className="w-full h-14 bg-[#9662FF] text-white border-2 border-[#111] rounded-[13px] text-base font-extrabold shadow-neo shadow-neo-active disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <>
                <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                {phaseLabel[phase]}
              </>
            ) : (
              phaseLabel[phase]
            )}
          </button>

          {/* Skip link — for when endpoint isn't available or user wants to defer */}
          <button
            onClick={handleSkip}
            disabled={isLoading}
            className="w-full h-12 bg-transparent text-gray-500 text-sm font-semibold disabled:opacity-40"
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
