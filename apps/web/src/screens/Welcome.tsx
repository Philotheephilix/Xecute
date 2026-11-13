import { useState } from 'react';
import type { Screen, AccountState } from '../App';

interface Props {
  navigate: (to: Screen) => void;
  account: AccountState | null;
  setAccount: (a: AccountState | null) => void;
  className: string;
}

const REQUIRE_INVITE =
  (import.meta as ImportMeta & { env: Record<string, string> }).env['VITE_REQUIRE_INVITE'] === 'true';

export default function Welcome({ navigate, setAccount, className }: Props) {
  const [signInError, setSignInError] = useState<string | null>(null);

  const handleSignIn = () => {
    const accountId = localStorage.getItem('floors:account_id');
    const credentialId = localStorage.getItem('floors:credential_id');
    const publicKey = localStorage.getItem('floors:public_key');

    if (!accountId || !credentialId || !publicKey) {
      setSignInError('No existing account found.');
      return;
    }

    const compressedKeyHex = localStorage.getItem('floors:compressed_key') ?? '';
    setSignInError(null);
    setAccount({ accountId, credentialId, publicKey, compressedKeyHex });
    navigate('portfolio');
  };
  return (
    <div className={className}>
      <div className="flex flex-col items-center justify-between min-h-full px-6 py-12">
        {/* Top spacer */}
        <div className="flex-1" />

        {/* Hero section */}
        <div className="flex flex-col items-center gap-6 w-full max-w-sm">
          {/* Floating badge */}
          <div className="animate-float">
            <span
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#EF7B28] text-white border-2 border-[#111] rounded-full text-sm font-extrabold shadow-neo"
              style={{ transform: 'rotate(5deg)' }}
            >
              ✦ Xecute
            </span>
          </div>

          {/* Logo wordmark */}
          <img
            src="/brand/xecute-logo.svg"
            alt="Xecute"
            className="h-12 w-auto"
            draggable={false}
          />

          {/* Tagline */}
          <p className="text-xl font-bold text-gray-600 text-center leading-snug">
            Buy crypto on X.{' '}
            <span className="text-[#EF7B28] font-extrabold">Protected.</span>
          </p>

          {/* Feature pills */}
          <div className="flex flex-wrap justify-center gap-2 mt-2">
            {['Passkey secured', 'NEAR wallet', '1-tap buy'].map((feat) => (
              <span
                key={feat}
                className="px-3 py-1.5 bg-white border-2 border-[#111] rounded-full text-xs font-extrabold shadow-neo-sm"
              >
                {feat}
              </span>
            ))}
          </div>
        </div>

        <div className="flex-1" />

        {/* Bottom CTA section */}
        <div className="w-full max-w-sm flex flex-col gap-4">
          <button
            onClick={() => navigate(REQUIRE_INVITE ? 'invite-code' : 'create-passkey')}
            className="w-full h-14 bg-[#EF7B28] text-white border-2 border-[#111] rounded-[13px] text-base font-extrabold shadow-neo shadow-neo-active transition-transform"
          >
            Get Started
          </button>

          <p className="text-center text-sm font-semibold text-gray-500">
            Already have an account?{' '}
            <button
              className="text-gray-700 font-bold underline underline-offset-2"
              onClick={handleSignIn}
            >
              Sign in
            </button>
          </p>
          {signInError !== null && (
            <p className="text-center text-sm font-semibold text-[#EF7B28]">{signInError}</p>
          )}
        </div>
      </div>
    </div>
  );
}
