import { useState } from 'react';
import type { Screen, AccountState } from '../App';
import { signWithPasskey } from '../lib/passkey';
import { getEnableTradingRequest, enableTrading } from '../api/client';
import { toHex } from '../lib/passkey';

interface Props {
  navigate: (to: Screen) => void;
  account: AccountState | null;
  setAccount: (a: AccountState | null) => void;
  className: string;
}

type Phase = 'idle' | 'requesting' | 'signing' | 'submitting' | 'done' | 'error';

export default function EnableTrading({ navigate, account, className }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);

  const accountId = account?.accountId;
  const credentialId = account?.credentialId;

  const handleEnable = async () => {
    if (!accountId || !credentialId) {
      setError('Account not found — please restart onboarding');
      setPhase('error');
      return;
    }

    setError(null);
    setPhase('requesting');

    try {
      // Step 1: ask API for a wallet_request to sign
      const requestResult = await getEnableTradingRequest(accountId);

      if (requestResult === null) {
        // Endpoint not implemented yet — skip directly to Fund
        console.warn('[floors] enable-trading-request not available, skipping step');
        navigate('fund');
        return;
      }

      const { wallet_request, challenge } = requestResult;

      // Step 2: sign challenge with passkey
      setPhase('signing');
      // Use the challenge bytes returned by the API — avoids JSON key-order dependency
      function hexToBytes(hex: string): Uint8Array {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        }
        return bytes;
      }
      const challengeBytes = hexToBytes(challenge);

      const assertion = await signWithPasskey(challengeBytes, credentialId);

      // Step 3: submit signed assertion to relayer
      setPhase('submitting');
      const signatureHex = toHex(assertion.signature);

      await enableTrading(accountId, {
        signature: signatureHex,
        credential_id: credentialId,
        wallet_request,
      });

      setPhase('done');

      // Brief pause so user can see the success state, then navigate
      await new Promise<void>((r) => setTimeout(r, 600));
      navigate('fund');
    } catch (err) {
      console.error('[floors] enable-trading error:', err);
      setError(err instanceof Error ? err.message : 'Enable trading failed');
      setPhase('error');
    }
  };

  const handleSkip = () => {
    navigate('fund');
  };

  const isLoading = phase === 'requesting' || phase === 'signing' || phase === 'submitting';

  const phaseLabel: Record<Phase, string> = {
    idle: 'Enable Trading (one tap)',
    requesting: 'Preparing…',
    signing: 'Waiting for fingerprint…',
    submitting: 'Registering on NEAR…',
    done: 'Trading enabled!',
    error: 'Try again',
  };

  return (
    <div className={className}>
      <div className="flex flex-col min-h-full px-6 py-8">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <button
            onClick={() => navigate('account-ready')}
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
          One tap to start trading
        </h1>
        <p className="text-base font-semibold text-gray-600 leading-relaxed mb-10">
          One fingerprint registers your key on NEAR Intents — the protocol that powers instant swaps.
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
            'One-time fingerprint — never repeated',
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
