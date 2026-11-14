import { useState, useEffect } from 'react';
import type { Screen, AccountState } from '../App';
import { signWithPasskey } from '../lib/passkey';

interface Props {
  navigate: (to: Screen) => void;
  account: AccountState | null;
  setAccount: (a: AccountState | null) => void;
  className: string;
}

interface SavedPasskey {
  name: string;
  credentialId: string;
  createdAt: string;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

export default function SignIn({ navigate, setAccount, className }: Props) {
  const [passkeys, setPasskeys] = useState<SavedPasskey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [authenticatingId, setAuthenticatingId] = useState<string | null>(null);

  useEffect(() => {
    const raw = localStorage.getItem('floors:passkeys');
    if (raw) {
      try {
        const parsed: SavedPasskey[] = JSON.parse(raw);
        if (parsed.length > 0) {
          setPasskeys(parsed);
          return;
        }
      } catch {
        // fall through to legacy
      }
    }
    // Legacy: account created before passkey naming — build from single credential
    const credentialId = localStorage.getItem('floors:credential_id');
    const passkeyName = localStorage.getItem('floors:passkey_name');
    if (credentialId) {
      setPasskeys([{
        name: passkeyName ?? 'My Passkey',
        credentialId,
        createdAt: new Date().toISOString(),
      }]);
    }
  }, []);

  const handleSignIn = async (passkey: SavedPasskey) => {
    setError(null);
    setAuthenticatingId(passkey.credentialId);
    try {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      await signWithPasskey(challenge, passkey.credentialId);

      // Passkey verified — restore account state from localStorage
      const accountId = localStorage.getItem('floors:account_id') ?? '';
      const publicKey = localStorage.getItem('floors:public_key') ?? '';
      const compressedKeyHex = localStorage.getItem('floors:compressed_key') ?? '';

      setAccount({
        accountId,
        credentialId: passkey.credentialId,
        publicKey,
        compressedKeyHex,
      });
      navigate('portfolio');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Authentication failed. Try again.',
      );
    } finally {
      setAuthenticatingId(null);
    }
  };

  const handleDifferentAccount = () => {
    localStorage.removeItem('floors:account_id');
    localStorage.removeItem('floors:credential_id');
    localStorage.removeItem('floors:public_key');
    localStorage.removeItem('floors:compressed_key');
    localStorage.removeItem('floors:passkey_name');
    localStorage.removeItem('floors:passkeys');
    navigate('welcome');
  };

  return (
    <div className={className}>
      <div className="flex flex-col min-h-full px-6 py-12">
        {/* Logo */}
        <div className="flex justify-center mb-10">
          <img
            src="/brand/xecute-logo.svg"
            alt="Xecute"
            className="h-12 w-auto"
            draggable={false}
          />
        </div>

        {/* Title */}
        <h1 className="text-3xl font-extrabold text-[#111] leading-tight mb-2">
          Welcome back
        </h1>
        <p className="text-base font-semibold text-gray-600 leading-relaxed mb-8">
          Authenticate with your passkey to continue.
        </p>

        {/* Error card */}
        {error !== null && (
          <div className="mb-6 p-4 bg-white border-2 border-[#EF7B28] rounded-[18px] shadow-neo-sm">
            <p className="text-sm font-bold text-[#EF7B28]">{error}</p>
          </div>
        )}

        {/* Passkey list */}
        <div className="flex flex-col gap-3 mb-8">
          {passkeys.map((pk) => (
            <div
              key={pk.credentialId}
              className="flex items-center gap-4 p-4 bg-white border-2 border-[#111] rounded-[13px] shadow-neo"
            >
              {/* Fingerprint icon */}
              <div className="w-11 h-11 shrink-0 bg-[#29CEB4] border-2 border-[#111] rounded-[10px] flex items-center justify-center">
                <svg
                  viewBox="0 0 80 80"
                  className="w-6 h-6"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle cx="40" cy="40" r="3" fill="white" />
                  <path d="M34 40 a6 6 0 0 1 12 0" stroke="white" strokeWidth="3" strokeLinecap="round" />
                  <path d="M28 40 a12 12 0 0 1 24 0" stroke="white" strokeWidth="3" strokeLinecap="round" />
                  <path d="M22 40 a18 18 0 0 1 36 0" stroke="white" strokeWidth="3" strokeLinecap="round" />
                </svg>
              </div>

              {/* Name + date */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-extrabold text-[#111] truncate">
                  {pk.name || 'Passkey'}
                </p>
                <p className="text-xs font-semibold text-gray-500">
                  Created {formatDate(pk.createdAt)}
                </p>
              </div>

              {/* Sign in button */}
              <button
                onClick={() => handleSignIn(pk)}
                disabled={authenticatingId !== null}
                className="shrink-0 h-10 px-4 bg-[#EF7B28] text-white border-2 border-[#111] rounded-[10px] text-sm font-extrabold shadow-neo-sm shadow-neo-active disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {authenticatingId === pk.credentialId ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Verifying
                  </>
                ) : (
                  <>
                    <svg
                      viewBox="0 0 80 80"
                      className="w-4 h-4"
                      fill="none"
                      aria-hidden="true"
                    >
                      <circle cx="40" cy="40" r="3" fill="white" />
                      <path d="M34 40 a6 6 0 0 1 12 0" stroke="white" strokeWidth="3" strokeLinecap="round" />
                      <path d="M28 40 a12 12 0 0 1 24 0" stroke="white" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                    Sign in
                  </>
                )}
              </button>
            </div>
          ))}
        </div>

        {/* No passkeys fallback — shouldn't happen in normal flow but defensive */}
        {passkeys.length === 0 && (
          <div className="mb-8 p-4 bg-white border-2 border-[#111] rounded-[13px] shadow-neo-sm">
            <p className="text-sm font-semibold text-gray-600 text-center">
              No saved passkeys found.
            </p>
          </div>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Different account link */}
        <div className="w-full max-w-sm mx-auto">
          <button
            onClick={handleDifferentAccount}
            className="w-full text-center text-sm font-bold text-gray-500 underline underline-offset-2 hover:text-gray-700 transition-colors"
          >
            Use a different account
          </button>
        </div>
      </div>
    </div>
  );
}
