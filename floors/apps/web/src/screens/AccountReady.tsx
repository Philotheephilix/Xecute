import { useEffect, useState } from 'react';
import type { Screen, AccountState } from '../App';

interface Props {
  navigate: (to: Screen) => void;
  account: AccountState | null;
  setAccount: (a: AccountState | null) => void;
  className: string;
}

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function AccountReady({ navigate, account, className }: Props) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!account) navigate('welcome');
  }, [account, navigate]);

  if (!account) return null;

  const accountId = account.accountId;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(accountId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback for older browsers
      const el = document.createElement('textarea');
      el.value = accountId;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className={className}>
      {/* Hero orange gradient header */}
      <div className="relative w-full bg-[#EF7B28] border-b-2 border-[#111] rounded-b-[28px] pt-14 px-6 pb-8 shadow-neo-lg overflow-hidden">
        {/* Cloud SVG watermark */}
        <svg
          className="absolute right-[-10px] bottom-[-20px] w-48 h-48 opacity-15 pointer-events-none"
          viewBox="0 0 200 200"
          fill="none"
          stroke="black"
          strokeWidth="2"
        >
          <circle cx="100" cy="100" r="70" strokeDasharray="6 6" />
          <rect x="50" y="60" width="90" height="70" rx="15" />
          <path d="M 50,80 Q 95,110 140,80" />
          <circle cx="120" cy="95" r="12" fill="black" />
        </svg>

        {/* Success checkmark */}
        <div className="flex justify-center mb-4">
          <div className="w-20 h-20 bg-white border-2 border-[#111] rounded-full shadow-neo flex items-center justify-center">
            <svg
              className="w-10 h-10 stroke-current fill-none stroke-[2.5]"
              style={{ color: '#29CEB4' }}
              viewBox="0 0 24 24"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
        </div>

        <h1 className="text-3xl font-extrabold text-[#111] text-center">Wallet Created</h1>
        <p className="text-base font-semibold text-[#111111] text-center mt-2">
          Protected by your device passkey.
        </p>
      </div>

      <div className="flex flex-col px-6 py-6 gap-5">
        {/* Account ID card */}
        <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo-sm p-4">
          <p className="text-xs font-extrabold text-gray-500 mb-1">WALLET ADDRESS</p>
          <div className="flex items-center gap-2">
            <p className="font-mono text-base font-bold text-[#111] break-all flex-1">
              {truncateAddress(accountId)}
            </p>
            <button
              onClick={handleCopy}
              className="shrink-0 w-8 h-8 bg-white border-2 border-[#111] rounded-[8px] flex items-center justify-center hover:bg-gray-50 active:translate-y-[1px] transition-all"
              aria-label="Copy address"
            >
              {copied ? (
                <svg className="w-4 h-4 text-[#29CEB4]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg className="w-4 h-4 text-[#111]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          </div>
          {copied && (
            <p className="text-xs font-bold text-[#29CEB4] mt-1">Copied!</p>
          )}
        </div>

        {/* Features list */}
        <div className="flex flex-col gap-3">
          {[
            'Secured by your device passkey',
            'Buy crypto directly from X posts',
          ].map((feat) => (
            <div key={feat} className="flex items-center gap-3">
              <div className="w-5 h-5 shrink-0 rounded-full bg-[#29CEB4] border-2 border-[#111] flex items-center justify-center">
                <svg className="w-2.5 h-2.5 stroke-current fill-none stroke-[3]" viewBox="0 0 24 24">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <span className="text-sm font-semibold text-gray-700">{feat}</span>
            </div>
          ))}
        </div>

        {/* Setup Defaults → Enable Trading → Fund button */}
        <button
          onClick={() => navigate('setup-defaults')}
          className="w-full h-14 bg-[#9662FF] text-white border-2 border-[#111] rounded-[13px] text-base font-extrabold shadow-neo shadow-neo-active"
        >
          Set Up Trading
        </button>

        {/* Skip to fund */}
        <button
          onClick={() => navigate('fund')}
          className="w-full h-14 bg-[#29CEB4] text-[#111] border-2 border-[#111] rounded-[13px] text-base font-extrabold shadow-neo shadow-neo-active"
        >
          Fund Your Account
        </button>

        {/* Open extension button */}
        <button
          onClick={() => navigate('portfolio')}
          className="w-full h-14 bg-white text-[#111] border-2 border-[#111] rounded-[13px] text-base font-extrabold shadow-neo-sm shadow-neo-active"
        >
          Open Portfolio
        </button>
      </div>
    </div>
  );
}
