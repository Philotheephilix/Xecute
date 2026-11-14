import { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import type { Position } from '../api/client';
import { getPositions, getActionChallenge, submitAction } from '../api/client';
import { signWithPasskey, toHex } from '../lib/passkey';
import PnLChart from '../components/PnLChart';

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

function BadgeStatus({ status }: { status: Position['status'] }) {
  if (status === 'active') {
    return (
      <span className="px-2 py-0.5 rounded-full text-[11px] font-extrabold bg-[#29CEB4] text-[#111] border border-[#111]">
        ACTIVE
      </span>
    );
  }
  if (status === 'expired') {
    return (
      <span className="px-2 py-0.5 rounded-full text-[11px] font-extrabold bg-gray-200 text-gray-600 border border-[#111]">
        EXPIRED
      </span>
    );
  }
  return (
    <span className="px-2 py-0.5 rounded-full text-[11px] font-extrabold bg-[#EF7B28] text-white border border-[#111]">
      CLOSED
    </span>
  );
}

export default function Portfolio() {
  const { account, pushSubScreen } = useApp();

  const accountId = account?.accountId ?? '';
  const [positions, setPositions] = useState<Position[]>([]);
  const [balance, setBalance] = useState<string | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<string | null>(null);
  const [loadingBalance, setLoadingBalance] = useState(true);
  const [loadingPositions, setLoadingPositions] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    setLoadingPositions(true);
    setLoadingBalance(true);
    getPositions(accountId)
      .then(({ positions: pos, near_balance, usdc_balance }) => {
        if (!cancelled) {
          setPositions(pos);
          setBalance(near_balance);
          setUsdcBalance(usdc_balance);
          setLoadingBalance(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPositions([]);
          setBalance(null);
          setUsdcBalance(null);
          setLoadingBalance(false);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingPositions(false);
      });
    return () => { cancelled = true; };
  }, [accountId]);

  const handleAction = async (action: 'sell_to_floor' | 'close', floorId: string) => {
    if (actionLoading) return;
    if (!account) return;
    setActionLoading(floorId + ':' + action);
    try {
      const { wallet_request, challenge } = await getActionChallenge(accountId, action, floorId);

      function hexToBytes(hex: string): Uint8Array {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        }
        return bytes;
      }
      const challengeBytes = hexToBytes(challenge);
      const assertion = await signWithPasskey(challengeBytes, account.credentialId);
      const signatureHex = toHex(assertion.signature);

      await submitAction({
        action,
        floor_id: floorId,
        account_id: accountId,
        assertion: {
          signature: signatureHex,
          credential_id: account.credentialId,
          wallet_request,
        },
      });

      // Refresh positions after action
      setLoadingBalance(true);
      const { positions: updated, near_balance, usdc_balance } = await getPositions(accountId);
      setPositions(updated);
      setBalance(near_balance);
      setUsdcBalance(usdc_balance);
      setLoadingBalance(false);
    } catch (err) {
      console.error('[floors] action failed:', err);
      setActionError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActionLoading(null);
    }
  };

  if (!account) return null;

  return (
    <div className="tab-content">
      {/* Header */}
      <div className="px-6 pt-8 pb-4">
        <h1 className="text-2xl font-extrabold text-[#111] tracking-tight text-center">Portfolio</h1>
      </div>

      <div className="flex flex-col px-6 py-2 gap-5 pb-8">
        {/* Balance card */}
        <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo p-5">
          <p className="text-xs font-extrabold text-gray-500 mb-1">USDC BALANCE</p>
          <p className="text-4xl font-extrabold text-[#111]">
            {loadingBalance ? (
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 border-2 border-[#111] border-t-transparent rounded-full animate-spin" />
                <span>Loading…</span>
              </span>
            ) : usdcBalance != null ? `$${usdcBalance} USDC` : '—'}
          </p>
          {!loadingBalance && balance != null && (
            <p className="text-sm font-semibold text-gray-400 mt-1">{balance}</p>
          )}
        </div>

        {/* PnL chart */}
        <PnLChart accountId={accountId} />

        {/* Quick actions */}
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => pushSubScreen('fund-account')}
            aria-label="Fund"
            className="h-[88px] bg-white rounded-[18px] border-2 border-[#111] shadow-neo flex flex-col items-center justify-center gap-2 shadow-neo-active"
          >
            <svg className="w-6 h-6 stroke-current fill-none stroke-[2.2]" viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span className="text-sm font-extrabold text-[#111]">Fund</span>
          </button>
          <button
            onClick={() => window.open('https://chromewebstore.google.com/', '_blank')}
            aria-label="Trade — install Floors extension"
            className="h-[88px] bg-white rounded-[18px] border-2 border-[#111] shadow-neo flex flex-col items-center justify-center gap-2 shadow-neo-active"
          >
            <svg className="w-6 h-6 stroke-current fill-none stroke-[2.2]" viewBox="0 0 24 24">
              <path d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            <span className="text-sm font-extrabold text-[#111]">Trade</span>
            <span className="text-[9px] font-bold text-gray-400 -mt-1">Install extension</span>
          </button>
        </div>

        {/* Action error card */}
        {actionError !== null && (
          <div className="border-2 border-[#EF7B28] rounded-[18px] p-4 text-[#EF7B28] font-bold text-sm flex items-center justify-between gap-3">
            <span>{actionError}</span>
            <button
              onClick={() => setActionError(null)}
              className="text-[#EF7B28] font-extrabold text-xs underline shrink-0"
              aria-label="Dismiss error"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Floor positions */}
        {loadingPositions ? (
          <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo-sm p-6 text-center">
            <p className="text-sm font-semibold text-gray-500 flex items-center justify-center">
              <span className="w-4 h-4 border-2 border-[#111] border-t-transparent rounded-full animate-spin inline-block mr-2" />
              Loading floors…
            </p>
          </div>
        ) : positions.length === 0 ? (
          <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo-sm p-6 flex flex-col items-center gap-3 text-center">
            <div className="w-12 h-12 bg-[#FAF9F6] border-2 border-[#111] rounded-[13px] flex items-center justify-center">
              <svg className="w-6 h-6 stroke-current fill-none stroke-[2.2]" viewBox="0 0 24 24">
                <rect x="2" y="5" width="20" height="14" rx="3" />
                <path d="M16 12h.01" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-extrabold text-[#111]">No floors yet</p>
              <p className="text-xs font-semibold text-gray-500 mt-1">
                Buy with protection to see them here.
              </p>
            </div>
            <button
              onClick={() => pushSubScreen('fund-account')}
              className="px-5 py-2.5 bg-[#EF7B28] text-white border-2 border-[#111] rounded-[13px] text-sm font-extrabold shadow-neo-sm shadow-neo-active"
            >
              Fund Account
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {positions.map((pos) => {
              const key = pos.floor_id;
              const isBusy = actionLoading?.startsWith(key + ':');
              return (
                <button
                  key={key}
                  onClick={() => pushSubScreen('position-detail', { floorId: key })}
                  className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo p-4 text-left w-full"
                >
                  <div className="flex items-start justify-between mb-1">
                    <p className="text-base font-extrabold text-[#111]">{pos.amount} {pos.asset}</p>
                    <BadgeStatus status={pos.status} />
                  </div>
                  {pos.floor_price_usd !== undefined && (
                    <p className="text-sm font-semibold text-gray-600">
                      Floor at ${pos.floor_price_usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                  )}
                  {pos.protected_until && (
                    <p className="text-xs font-semibold text-gray-400 mt-0.5">
                      Protected until {formatDate(pos.protected_until)}
                    </p>
                  )}
                  {pos.status === 'active' && (
                    <div className="flex gap-2 mt-3" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleAction('sell_to_floor', pos.floor_id); }}
                        disabled={!!isBusy}
                        className="flex-1 h-10 bg-[#29CEB4] text-[#111] border-2 border-[#111] rounded-[10px] text-xs font-extrabold shadow-neo-sm shadow-neo-active disabled:opacity-50"
                      >
                        {actionLoading === key + ':sell_to_floor' ? '…' : 'Sell to floor'}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleAction('close', pos.floor_id); }}
                        disabled={!!isBusy}
                        className="flex-1 h-10 bg-white text-[#111] border-2 border-[#111] rounded-[10px] text-xs font-extrabold shadow-neo-sm shadow-neo-active disabled:opacity-50"
                      >
                        {actionLoading === key + ':close' ? '…' : 'Close'}
                      </button>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
