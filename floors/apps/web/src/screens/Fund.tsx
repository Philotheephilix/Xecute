import { useState, useCallback, useEffect } from 'react';
import type { Screen, AccountState } from '../App';
import { getDepositAddresses } from '../api/client';
import type { DepositAddress } from '../api/client';

interface Props {
  navigate: (to: Screen) => void;
  account: AccountState | null;
  setAccount: (a: AccountState | null) => void;
  className: string;
}

interface ToastState {
  visible: boolean;
  exiting: boolean;
  message: string;
}

const CHAIN_COLORS: Record<string, string> = {
  NEAR: '#111111',
  Ethereum: '#9662FF',
  Base: '#9662FF',
  Arbitrum: '#29CEB4',
  Solana: '#EF7B28',
};

export default function Fund({ navigate, account, className }: Props) {
  useEffect(() => {
    if (!account) navigate('welcome');
  }, [account, navigate]);

  if (!account) return null;

  const accountId = account.accountId;
  const [toast, setToast] = useState<ToastState>({ visible: false, exiting: false, message: '' });
  const [depositAddresses, setDepositAddresses] = useState<DepositAddress[]>([]);
  const [selectedChain, setSelectedChain] = useState<string>('NEAR');
  const [loadingAddresses, setLoadingAddresses] = useState(true);
  const [addressError, setAddressError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const addresses = await getDepositAddresses(accountId);
        if (!cancelled) {
          setDepositAddresses(addresses);
          if (addresses.length > 0 && addresses[0] !== undefined) {
            setSelectedChain(addresses[0].chain);
          }
        }
      } catch (err) {
        console.warn('[floors] Failed to load deposit addresses:', err);
        if (!cancelled) setAddressError(true);
      } finally {
        if (!cancelled) setLoadingAddresses(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const showToast = useCallback((message: string) => {
    setToast({ visible: true, exiting: false, message });
    setTimeout(() => {
      setToast((t) => ({ ...t, exiting: true }));
      setTimeout(() => {
        setToast({ visible: false, exiting: false, message: '' });
      }, 300);
    }, 3000);
  }, []);

  const selectedDeposit = depositAddresses.find((a) => a.chain === selectedChain);
  const displayAddress = selectedDeposit?.address ?? accountId;

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(displayAddress);
      showToast('Address copied!');
    } catch {
      showToast('Could not copy — please copy manually');
    }
  };

  return (
    <div className={className}>
      {/* Toast notification */}
      {toast.visible && (
        <div
          className={`fixed top-12 left-4 right-4 z-50 bg-white border-2 border-[#111] rounded-2xl shadow-neo p-3 flex items-center gap-3 ${
            toast.exiting ? 'toast-exit' : 'toast-enter'
          }`}
        >
          <div className="w-9 h-9 rounded-xl bg-[#EF7B28] border-2 border-[#111] shadow-neo-sm flex items-center justify-center text-white">
            <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24">
              <path d="M12 0L14.59 9.41L24 12L14.59 14.59L12 24L9.41 14.59L0 12L9.41 9.41L12 0Z" />
            </svg>
          </div>
          <div className="flex-1">
            <p className="text-xs font-extrabold text-[#111]">{toast.message}</p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center gap-4 px-6 pt-8 pb-4">
        <button
          onClick={() => navigate('enable-trading')}
          className="w-11 h-11 bg-white border-2 border-[#111] rounded-[13px] shadow-neo-sm shadow-neo-active flex items-center justify-center"
          aria-label="Go back"
        >
          <svg className="w-5 h-5 stroke-current fill-none stroke-[2.5]" viewBox="0 0 24 24">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
        </button>
        <span className="text-base font-extrabold text-[#111]">Fund Account</span>
      </div>

      <div className="flex flex-col px-6 gap-5 pb-8">
        {/* Address fetch error */}
        {addressError && (
          <p className="text-xs font-semibold text-[#EF7B28]">
            Could not load deposit addresses. Using NEAR address as fallback.
          </p>
        )}

        {/* Chain selector */}
        {!loadingAddresses && depositAddresses.length > 0 && (
          <div>
            <p className="text-xs font-extrabold text-gray-500 mb-2">DEPOSIT FROM</p>
            <div className="flex gap-2 flex-wrap">
              {depositAddresses.map((dep) => {
                const color = CHAIN_COLORS[dep.chain] ?? '#EF7B28';
                const isSelected = dep.chain === selectedChain;
                return (
                  <button
                    key={dep.chain}
                    onClick={() => setSelectedChain(dep.chain)}
                    className={`px-3 py-1.5 rounded-[10px] border-2 border-[#111] text-xs font-extrabold shadow-neo-sm transition-colors ${
                      isSelected ? 'text-white' : 'bg-white text-[#111]'
                    }`}
                    style={isSelected ? { backgroundColor: color } : {}}
                  >
                    {dep.chain}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Deposit card */}
        <div
          className="w-full max-w-[296px] mx-auto h-[166px] rounded-[22px] border-2 border-[#111] shadow-neo p-[18px_20px] flex flex-col justify-between relative overflow-hidden"
          style={{
            background: `linear-gradient(135deg, ${CHAIN_COLORS[selectedChain] ?? '#EF7B28'} 0%, ${CHAIN_COLORS[selectedChain] ?? '#EF7B28'}cc 100%)`,
          }}
        >
          {/* Decorative circles */}
          <svg
            className="absolute -right-8 -bottom-10 w-44 h-44 opacity-10 pointer-events-none"
            viewBox="0 0 100 100"
            fill="none"
            stroke="black"
            strokeWidth="3"
          >
            <circle cx="50" cy="50" r="40" strokeDasharray="4 4" />
            <circle cx="50" cy="50" r="28" />
          </svg>

          <div className="relative z-10">
            <p className="text-xs font-bold text-black/60">
              Deposit USDC · {selectedChain}
            </p>
            <p className="text-lg font-black text-[#111] tracking-tight mt-0.5">
              Send USDC to this address
            </p>
          </div>

          <div className="relative z-10">
            <p className="text-[10px] font-bold text-black/50">WALLET ADDRESS</p>
            <p className="font-mono text-sm font-bold text-[#111] tracking-wide truncate">
              {displayAddress}
            </p>
          </div>
        </div>

        {/* Copy button */}
        <button
          onClick={copyAddress}
          className="w-full h-12 bg-white text-[#111] border-2 border-[#111] rounded-[13px] text-sm font-extrabold shadow-neo-sm shadow-neo-active flex items-center justify-center gap-2"
        >
          <svg className="w-4 h-4 stroke-current fill-none stroke-[2.2]" viewBox="0 0 24 24">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
          Copy Address
        </button>

        {/* Instructions */}
        <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo-sm p-5">
          <h3 className="text-sm font-extrabold text-[#111] mb-4">How to fund</h3>
          <div className="flex flex-col gap-3">
            {[
              'Send USDC from any supported chain — Ethereum, Base, Arbitrum, Solana',
              'Use the chain selector above to get the right deposit address',
              'Funds arrive via NEAR Intents bridge — typically within seconds',
              'Minimum deposit: 1 USDC',
            ].map((step, i) => (
              <div key={step} className="flex items-start gap-3">
                <div className="w-5 h-5 shrink-0 mt-0.5 rounded-full bg-[#29CEB4] border-2 border-[#111] flex items-center justify-center">
                  <svg className="w-2.5 h-2.5 stroke-current fill-none stroke-[3]" viewBox="0 0 24 24">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <span className="text-sm font-semibold text-gray-700">
                  <span className="font-extrabold text-[#111]">{i + 1}.</span> {step}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Continue to portfolio */}
        <button
          onClick={() => navigate('portfolio')}
          className="w-full h-14 bg-[#EF7B28] text-white border-2 border-[#111] rounded-[13px] text-base font-extrabold shadow-neo shadow-neo-active"
        >
          I've Funded My Account
        </button>
      </div>
    </div>
  );
}
