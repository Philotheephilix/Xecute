import { useState } from 'react';
import type { Screen, AccountState } from '../App';
import { createPasskey, extractCompressedP256Key, toHex } from '../lib/passkey';
import { createAccount } from '../api/client';

const REQUIRE_INVITE =
  (import.meta as ImportMeta & { env: Record<string, string> }).env['VITE_REQUIRE_INVITE'] === 'true';

interface Props {
  navigate: (to: Screen) => void;
  account: AccountState | null;
  setAccount: (a: AccountState | null) => void;
  className: string;
}

export default function CreatePasskey({ navigate, setAccount, account, className }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleCreate = async () => {
    setError(null);
    setLoading(true);
    try {
      const { credentialId, publicKey, rawPublicKey } = await createPasskey();
      const compressedKey = extractCompressedP256Key(rawPublicKey);
      const compressedKeyHex = toHex(compressedKey);
      const inviteCode = account?.inviteCode;
      const { account_id } = await createAccount(compressedKeyHex, credentialId, inviteCode);
      const newAccount: AccountState = {
        accountId: account_id,
        credentialId,
        publicKey,
        compressedKeyHex,
        ...(inviteCode !== undefined ? { inviteCode } : {}),
      };
      setAccount(newAccount);
      localStorage.setItem('floors:account_id', newAccount.accountId);
      localStorage.setItem('floors:credential_id', newAccount.credentialId);
      localStorage.setItem('floors:public_key', newAccount.publicKey);
      localStorage.setItem('floors:compressed_key', newAccount.compressedKeyHex);
      navigate('creating-account');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Passkey creation failed');
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
            onClick={() => navigate(REQUIRE_INVITE ? 'invite-code' : 'welcome')}
            className="w-11 h-11 bg-white border-2 border-[#111] rounded-[13px] shadow-neo-sm shadow-neo-active flex items-center justify-center"
            aria-label="Go back"
          >
            <svg className="w-5 h-5 stroke-current fill-none stroke-[2.5]" viewBox="0 0 24 24">
              <line x1="19" y1="12" x2="5" y2="12" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
          </button>
          <span className="text-base font-extrabold text-[#111]">Create Account</span>
        </div>

        {/* Title */}
        <h1 className="text-3xl font-extrabold text-[#111] leading-tight mb-3">
          Secure Your Account
        </h1>
        <p className="text-base font-semibold text-gray-600 leading-relaxed mb-10">
          Your passkey replaces passwords. It stays on your device and can never be stolen.
        </p>

        {/* Fingerprint illustration */}
        <div className="flex justify-center mb-10">
          <div className="w-32 h-32 bg-white border-2 border-[#111] rounded-[18px] shadow-neo flex items-center justify-center">
            <svg
              viewBox="0 0 80 80"
              className="w-20 h-20"
              fill="none"
              aria-label="Fingerprint"
            >
              <circle cx="40" cy="40" r="3" fill="#29CEB4" />
              <path d="M34 40 a6 6 0 0 1 12 0" stroke="#29CEB4" strokeWidth="2.5" strokeLinecap="round" />
              <path d="M28 40 a12 12 0 0 1 24 0" stroke="#29CEB4" strokeWidth="2.5" strokeLinecap="round" />
              <path d="M22 40 a18 18 0 0 1 36 0" stroke="#29CEB4" strokeWidth="2.5" strokeLinecap="round" />
              <path d="M16 40 a24 24 0 0 1 48 0" stroke="#29CEB4" strokeWidth="2.5" strokeLinecap="round" />
              <path d="M10 40 a30 30 0 0 1 60 0" stroke="#29CEB4" strokeWidth="2.5" strokeLinecap="round" />
              <path d="M28 40 c0 10 4 16 12 18" stroke="#29CEB4" strokeWidth="2.5" strokeLinecap="round" />
              <path d="M22 40 c0 16 8 26 18 26" stroke="#29CEB4" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          </div>
        </div>

        {/* Feature list */}
        <div className="flex flex-col gap-3 mb-10">
          {[
            'Biometric authentication — face or fingerprint',
            'Stored on your device only — never uploaded',
            'Phishing-resistant by design',
          ].map((feature) => (
            <div key={feature} className="flex items-start gap-3">
              <div className="w-5 h-5 shrink-0 mt-0.5 rounded-full bg-[#29CEB4] border-2 border-[#111] flex items-center justify-center">
                <svg className="w-2.5 h-2.5 stroke-current fill-none stroke-[3]" viewBox="0 0 24 24">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <span className="text-sm font-semibold text-gray-700">{feature}</span>
            </div>
          ))}
        </div>

        {/* Error card */}
        {error !== null && (
          <div className="mb-6 p-4 bg-white border-2 border-[#EF7B28] rounded-[18px] shadow-neo-sm">
            <p className="text-sm font-bold text-[#EF7B28]">{error}</p>
          </div>
        )}

        <div className="mt-auto">
          <button
            onClick={handleCreate}
            disabled={loading}
            className="w-full h-14 bg-[#EF7B28] text-white border-2 border-[#111] rounded-[13px] text-base font-extrabold shadow-neo shadow-neo-active disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Creating…
              </>
            ) : (
              'Create Passkey'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
