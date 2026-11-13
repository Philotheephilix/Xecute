import { useState, useEffect } from 'react';
import type { Screen, AccountState } from '../App';
import type { Position } from '../api/client';
import { getPositions, getActionChallenge, submitAction } from '../api/client';
import { signWithPasskey, toHex } from '../lib/passkey';

interface Props {
  navigate: (to: Screen) => void;
  account: AccountState | null;
  setAccount: (a: AccountState | null) => void;
  className: string;
}

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
      <span className="px-2 py-0.5 rounded-full text-[11px] font-extrabold bg-[#29CEB4] text-white border border-[#111]">
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

export default function Portfolio({ navigate, account, className }: Props) {
  const accountId = account?.accountId ?? '0sabc123def456';
  const [positions, setPositions] = useState<Position[]>([]);
  // H1: near_balance from API response (not hardcoded)
  const [balance, setBalance] = useState<string | null>(null);
  const [loadingPositions, setLoadingPositions] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingPositions(true);
    getPositions(accountId)
      .then(({ positions: pos, near_balance }) => {
        if (!cancelled) {
          setPositions(pos);
          // H1: use near_balance from API response
          setBalance(near_balance);
        }
      })
      .catch(() => {
        if (!cancelled) setPositions([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingPositions(false);
      });
    return () => { cancelled = true; };
  }, [accountId]);

  // C1: Two-step signed action — get challenge, sign with passkey, submit
  const handleAction = async (action: 'sell_to_floor' | 'close', floorId: string) => {
    if (actionLoading) return;
    if (!account) return;
    setActionLoading(floorId + ':' + action);
    try {
      // Step 1: get challenge from API
      const { wallet_request, challenge } = await getActionChallenge(accountId, action, floorId);

      // Step 2: sign challenge with passkey
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

      // Step 3: submit with assertion
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
      const { positions: updated, near_balance } = await getPositions(accountId);
      setPositions(updated);
      setBalance(near_balance);
    } catch (err) {
      console.error('[floors] action failed:', err);
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className={className}>
      {/* Top hero section */}
      <div className="relative w-full bg-[#FDE69E] pt-4 pb-6 overflow-hidden border-b-2 border-[#111]">
        {/* Cloud SVG backdrop */}
        <div className="absolute inset-x-0 bottom-0 pointer-events-none">
          <svg className="w-full h-24" viewBox="0 0 392 90" fill="none" preserveAspectRatio="none">
            <path d="M -20 90 Q -10 40 30 50 Q 70 30 100 65 Q 120 90 120 90 Z" fill="#26B9D5" stroke="#111" strokeWidth="2.5" />
            <path d="M 80 90 Q 110 30 160 35 Q 200 20 220 70 Z" fill="#FFCB1F" stroke="#111" strokeWidth="2.5" />
            <path d="M 190 90 Q 230 25 270 40 Q 310 15 340 70 Z" fill="#FF6464" stroke="#111" strokeWidth="2.5" />
            <path d="M 300 90 Q 330 35 370 45 Q 410 40 410 90 Z" fill="#9B6BFF" stroke="#111" strokeWidth="2.5" />
            <path d="M -10 90 C 20 60 70 60 100 90 C 140 55 200 55 240 90 C 280 60 350 60 400 90 Z" fill="#FAF9F6" />
          </svg>
        </div>

        {/* Header row */}
        <div className="px-[18px] flex items-center justify-between relative z-10">
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
          <span className="text-base font-extrabold text-[#111]">Portfolio</span>
          <div className="w-11" />
        </div>

        {/* Account address */}
        <div className="flex flex-col items-center mt-4 relative z-10 px-6">
          <div className="w-16 h-16 bg-[#EF7B28] border-2 border-[#111] rounded-full shadow-neo flex items-center justify-center">
            <svg className="w-8 h-8 fill-current text-white" viewBox="0 0 24 24">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z" />
            </svg>
          </div>
          <p className="font-mono text-sm font-bold text-[#111] mt-2 truncate max-w-xs">
            {accountId}
          </p>
        </div>
      </div>

      <div className="flex flex-col px-6 py-6 gap-5">
        {/* Balance card — H1: shows real near_balance from API */}
        <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo p-5">
          <p className="text-xs font-extrabold text-gray-500 mb-1">TOTAL BALANCE</p>
          <p className="text-4xl font-extrabold text-[#111]">
            {balance ?? (loadingPositions ? 'Loading…' : '0.00 NEAR')}
          </p>
          <p className="text-sm font-semibold text-gray-400 mt-0.5">≈ $0.00 USD</p>
        </div>

        {/* Quick actions row */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'Fund', icon: 'M12 5v14M5 12h14', action: () => navigate('fund') },
            { label: 'Send', icon: 'M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z', action: () => {} },
            { label: 'Buy', icon: 'M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z', action: () => {} },
          ].map(({ label, icon, action }) => (
            <button
              key={label}
              onClick={action}
              className="h-[88px] bg-white rounded-[18px] border-2 border-[#111] shadow-neo flex flex-col items-center justify-center gap-2 shadow-neo-active"
            >
              <svg className="w-6 h-6 stroke-current fill-none stroke-[2.2]" viewBox="0 0 24 24">
                <path d={icon} />
              </svg>
              <span className="text-sm font-extrabold text-[#111]">{label}</span>
            </button>
          ))}
        </div>

        {/* Floor positions */}
        {loadingPositions ? (
          <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo-sm p-6 text-center">
            <p className="text-sm font-semibold text-gray-500">Loading floors…</p>
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
              onClick={() => navigate('fund')}
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
                <div key={key} className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo p-4">
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
                    <div className="flex gap-2 mt-3">
                      <button
                        onClick={() => handleAction('sell_to_floor', pos.floor_id)}
                        disabled={!!isBusy}
                        className="flex-1 h-10 bg-[#29CEB4] text-white border-2 border-[#111] rounded-[10px] text-xs font-extrabold shadow-neo-sm shadow-neo-active disabled:opacity-50"
                      >
                        {actionLoading === key + ':sell_to_floor' ? '…' : 'Sell to floor'}
                      </button>
                      <button
                        onClick={() => handleAction('close', pos.floor_id)}
                        disabled={!!isBusy}
                        className="flex-1 h-10 bg-white text-[#111] border-2 border-[#111] rounded-[10px] text-xs font-extrabold shadow-neo-sm shadow-neo-active disabled:opacity-50"
                      >
                        {actionLoading === key + ':close' ? '…' : 'Close'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
