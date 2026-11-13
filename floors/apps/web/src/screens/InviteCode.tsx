import { useState } from 'react';
import type { Screen, AccountState } from '../App';
import { validateInviteCode } from '../api/client';

interface Props {
  navigate: (to: Screen) => void;
  account: AccountState | null;
  setAccount: (a: AccountState | null) => void;
  className: string;
}

export default function InviteCode({ navigate, setAccount, account, className }: Props) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleContinue = async () => {
    const trimmed = code.trim().toUpperCase();
    if (trimmed.length === 0) {
      setError('Please enter your invite code.');
      return;
    }

    setError(null);
    setLoading(true);
    try {
      await validateInviteCode(trimmed);
      // Stash the validated code on AccountState so CreatePasskey can forward it
      // to createAccount. We only update the inviteCode field here — the rest of
      // AccountState is populated during passkey creation.
      setAccount(account !== null ? { ...account, inviteCode: trimmed } : { accountId: '', credentialId: '', publicKey: '', compressedKeyHex: '', inviteCode: trimmed });
      navigate('create-passkey');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid or already used invite code');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={className}>
      <div className="flex flex-col min-h-full px-6 py-8">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <button
            onClick={() => navigate('welcome')}
            className="w-11 h-11 bg-white border-2 border-[#111] rounded-[13px] shadow-neo-sm shadow-neo-active flex items-center justify-center"
            aria-label="Go back"
          >
            <svg className="w-5 h-5 stroke-current fill-none stroke-[2.5]" viewBox="0 0 24 24">
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
          </button>
          <span className="text-base font-extrabold text-[#111]">Beta Access</span>
        </div>

        {/* Title */}
        <h1 className="text-3xl font-extrabold text-[#111] leading-tight mb-3">
          Enter Your Invite Code
        </h1>
        <p className="text-base font-semibold text-gray-600 leading-relaxed mb-10">
          Floors is in private beta. Enter your 8-character invite code to get started.
        </p>

        {/* Invite code badge */}
        <div className="flex justify-center mb-10">
          <div className="w-32 h-32 bg-white border-2 border-[#111] rounded-[18px] shadow-neo flex items-center justify-center">
            <svg viewBox="0 0 80 80" className="w-20 h-20" fill="none" aria-label="Ticket">
              <rect x="8" y="24" width="64" height="32" rx="5" stroke="#EF7B28" strokeWidth="2.5" />
              <circle cx="8" cy="40" r="5" fill="#FAF9F6" stroke="#EF7B28" strokeWidth="2.5" />
              <circle cx="72" cy="40" r="5" fill="#FAF9F6" stroke="#EF7B28" strokeWidth="2.5" />
              <line x1="28" y1="24" x2="28" y2="56" stroke="#EF7B28" strokeWidth="2" strokeDasharray="4 3" />
              <rect x="36" y="33" width="24" height="5" rx="2.5" fill="#EF7B28" opacity="0.3" />
              <rect x="36" y="42" width="16" height="5" rx="2.5" fill="#EF7B28" opacity="0.3" />
            </svg>
          </div>
        </div>

        {/* Input */}
        <div className="mb-4">
          <label className="block text-sm font-extrabold text-[#111] mb-2" htmlFor="invite-code-input">
            Invite Code
          </label>
          <input
            id="invite-code-input"
            type="text"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={8}
            placeholder="XXXXXXXX"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            className="w-full h-14 px-4 bg-white border-2 border-[#111] rounded-[13px] text-xl font-extrabold text-[#111] tracking-[0.3em] text-center shadow-neo-sm placeholder:text-gray-300 placeholder:tracking-[0.3em] focus:outline-none focus:border-[#EF7B28] transition-colors"
          />
        </div>

        {/* Error card */}
        {error !== null && (
          <div className="mb-6 p-4 bg-white border-2 border-[#EF7B28] rounded-[18px] shadow-neo-sm">
            <p className="text-sm font-bold text-[#EF7B28]">{error}</p>
          </div>
        )}

        <div className="mt-auto">
          <button
            onClick={handleContinue}
            disabled={loading || code.trim().length === 0}
            className="w-full h-14 bg-[#EF7B28] text-white border-2 border-[#111] rounded-[13px] text-base font-extrabold shadow-neo shadow-neo-active disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Checking…
              </>
            ) : (
              'Continue'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
