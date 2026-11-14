import { useState, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import type { AccountState } from '../context/AppContext';
import { createPasskey, extractCompressedP256Key, toHex } from '../lib/passkey';

const API_URL = (import.meta as ImportMeta & { env: Record<string, string> }).env['VITE_API_URL'] ?? '';

interface PasskeyEntry {
  name: string;
  credentialId: string;
  createdAt?: string;
}

interface FloorDefaults {
  floor_bps: number;
  duration_secs: number;
}

function truncateId(id: string, front = 12, back = 6): string {
  if (id.length <= front + back + 3) return id;
  return `${id.slice(0, front)}…${id.slice(-back)}`;
}

function formatDuration(secs: number): string {
  const days = Math.round(secs / 86400);
  if (days >= 365) {
    const years = Math.round(days / 365);
    return `${years} year${years !== 1 ? 's' : ''}`;
  }
  return `${days} day${days !== 1 ? 's' : ''}`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

function readPasskeys(account: AccountState): PasskeyEntry[] {
  try {
    const raw = localStorage.getItem('floors:passkeys');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch { /* fall through */ }
  const name = localStorage.getItem('floors:passkey_name') ?? 'Default Passkey';
  return [{ name, credentialId: account.credentialId }];
}

function readFloorDefaults(): FloorDefaults {
  try {
    const raw = localStorage.getItem('floors:floor_defaults');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.floor_bps === 'number' && typeof parsed.duration_secs === 'number') {
        return parsed;
      }
    }
  } catch { /* fall through */ }
  return { floor_bps: 1000, duration_secs: 86400 };
}

export default function Settings() {
  const { account, signOut } = useApp();

  const [copied, setCopied] = useState(false);
  const [passkeyList, setPasskeyList] = useState<PasskeyEntry[]>([]);
  const [addingPasskey, setAddingPasskey] = useState(false);
  const [addPasskeyError, setAddPasskeyError] = useState<string | null>(null);
  const [addPasskeySuccess, setAddPasskeySuccess] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  // Load passkeys on mount and after adding
  useEffect(() => {
    if (!account) return;
    setPasskeyList(readPasskeys(account));
  }, [account]);

  // Auto-dismiss success after 3s
  useEffect(() => {
    if (!addPasskeySuccess) return;
    const t = setTimeout(() => setAddPasskeySuccess(false), 3000);
    return () => clearTimeout(t);
  }, [addPasskeySuccess]);

  const handleAddPasskey = useCallback(async () => {
    if (!account) return;
    setAddPasskeyError(null);
    setAddPasskeySuccess(false);
    setAddingPasskey(true);
    try {
      // Prompt user for a name via the browser
      const name = window.prompt('Name this passkey (e.g. "Work laptop")');
      if (name === null) {
        // User cancelled the prompt
        setAddingPasskey(false);
        return;
      }
      const passkeyName = name.trim() || 'Passkey';

      // Create the WebAuthn credential
      const { credentialId, rawPublicKey } = await createPasskey(passkeyName);
      const compressedKey = extractCompressedP256Key(rawPublicKey);
      const compressedKeyHex = toHex(compressedKey);

      // Register the new credential with the API
      const res = await fetch(
        `${API_URL}/v1/accounts/${encodeURIComponent(account.accountId)}/credentials`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            credential_id: credentialId,
            public_key_hex: compressedKeyHex,
            device_name: passkeyName,
            existing_credential_id: account.credentialId,
          }),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        let msg = `Server error (${res.status})`;
        try {
          const parsed = JSON.parse(body) as { message?: string; error?: string };
          msg = parsed.message ?? parsed.error ?? msg;
        } catch { /* use default */ }
        console.warn('[floors] Credential registration failed:', msg);
        // Continue anyway — passkey is created locally
      }

      // Update localStorage passkeys array
      const existingRaw = localStorage.getItem('floors:passkeys');
      const existing: PasskeyEntry[] = existingRaw ? JSON.parse(existingRaw) : [];
      const newEntry: PasskeyEntry = {
        name: passkeyName,
        credentialId,
        createdAt: new Date().toISOString(),
      };
      existing.push(newEntry);
      localStorage.setItem('floors:passkeys', JSON.stringify(existing));

      // Refresh the displayed list
      setPasskeyList(readPasskeys(account));
      setAddPasskeySuccess(true);
    } catch (err) {
      setAddPasskeyError(err instanceof Error ? err.message : 'Passkey creation failed');
    } finally {
      setAddingPasskey(false);
    }
  }, [account]);

  if (!account) return null;

  const defaults = readFloorDefaults();
  const passkeyName = localStorage.getItem('floors:passkey_name');

  const handleCopy = () => {
    navigator.clipboard.writeText(account.accountId).then(() => setCopied(true)).catch(() => {});
  };

  return (
    <div className="tab-content">
      <div className="flex flex-col px-6 pt-4 pb-6 gap-5">

        {/* Header */}
        <div className="flex items-center justify-center py-1 pt-4">
          <span className="text-xl font-extrabold text-[#111]">Settings</span>
        </div>

        {/* Account Section */}
        <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo p-5 flex flex-col items-center gap-3">
          <div className="w-14 h-14 bg-[#EF7B28] border-2 border-[#111] rounded-full shadow-neo-sm flex items-center justify-center">
            <svg className="w-7 h-7 fill-current text-white" viewBox="0 0 24 24">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z" />
            </svg>
          </div>

          <div className="flex items-center gap-2">
            <p className="font-mono text-sm font-bold text-[#111] truncate max-w-[200px]">
              {truncateId(account.accountId)}
            </p>
            <button
              onClick={handleCopy}
              className="w-8 h-8 bg-[#FAF9F6] border-2 border-[#111] rounded-[8px] flex items-center justify-center shadow-neo-active"
              aria-label="Copy account ID"
            >
              {copied ? (
                <svg className="w-4 h-4 stroke-current text-[#29CEB4] fill-none stroke-[2.5]" viewBox="0 0 24 24">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg className="w-4 h-4 stroke-current text-[#111] fill-none stroke-[2]" viewBox="0 0 24 24">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          </div>

          {copied && (
            <span className="text-[10px] font-extrabold text-[#29CEB4] -mt-1">Copied!</span>
          )}

          <p className="text-xs font-semibold text-gray-500 -mt-1">
            Created via {passkeyName ?? 'passkey'}
          </p>
        </div>

        {/* Passkey Management */}
        <div className="flex flex-col gap-2">
          <span className="text-sm font-extrabold text-[#111]">Passkeys</span>
          <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo-sm p-4 flex flex-col gap-3">
            {passkeyList.map((pk, i) => (
              <div key={pk.credentialId + i} className="flex flex-col gap-0.5">
                <span className="text-sm font-extrabold text-[#111]">{pk.name}</span>
                <span className="font-mono text-[10px] font-semibold text-gray-400 truncate">
                  {truncateId(pk.credentialId, 16, 8)}
                </span>
                {pk.createdAt && (
                  <span className="text-[10px] font-semibold text-gray-400">
                    Added {formatDate(pk.createdAt)}
                  </span>
                )}
              </div>
            ))}

            {/* Success feedback */}
            {addPasskeySuccess && (
              <div className="flex items-center gap-2 px-3 py-2 bg-[#29CEB4]/10 border border-[#29CEB4] rounded-[10px]">
                <svg className="w-4 h-4 stroke-current text-[#29CEB4] fill-none stroke-[2.5]" viewBox="0 0 24 24">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span className="text-xs font-bold text-[#29CEB4]">Passkey added</span>
              </div>
            )}

            {/* Error feedback */}
            {addPasskeyError !== null && (
              <div className="px-3 py-2 bg-white border border-[#EF7B28] rounded-[10px]">
                <span className="text-xs font-bold text-[#EF7B28]">{addPasskeyError}</span>
              </div>
            )}

            <button
              onClick={handleAddPasskey}
              disabled={addingPasskey}
              className="w-full h-10 bg-white border-2 border-[#111] rounded-[13px] text-sm font-extrabold text-[#111] shadow-neo-active disabled:opacity-60 disabled:cursor-wait flex items-center justify-center gap-2"
            >
              {addingPasskey ? (
                <>
                  <span className="w-4 h-4 border-2 border-[#111] border-t-transparent rounded-full animate-spin" />
                  Creating…
                </>
              ) : (
                <>
                  <svg className="w-4 h-4 stroke-current fill-none stroke-[2.5]" viewBox="0 0 24 24">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  Add Passkey
                </>
              )}
            </button>
          </div>
        </div>

        {/* Preferences */}
        <div className="flex flex-col gap-2">
          <span className="text-sm font-extrabold text-[#111]">Preferences</span>
          <div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo-sm p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-[#111]">Floor protection</span>
              <span className="text-sm font-extrabold text-[#111]">
                {(defaults.floor_bps / 100).toFixed(1)}%
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-[#111]">Duration</span>
              <span className="text-sm font-extrabold text-[#111]">
                {formatDuration(defaults.duration_secs)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-[#111]">Notifications</span>
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-bold text-gray-400">Coming soon</span>
                <div className="w-10 h-6 bg-gray-200 rounded-full border-2 border-[#111] opacity-40 relative cursor-not-allowed">
                  <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full border border-[#111]" />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Sign Out */}
        <button
          onClick={signOut}
          className="w-full h-[52px] bg-white border-2 border-red-500 rounded-[18px] text-red-500 font-extrabold text-base shadow-neo-sm shadow-neo-active mt-2"
        >
          Sign Out
        </button>

        {/* App Info */}
        <div className="flex flex-col items-center gap-2 mt-2 mb-4">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-gray-400">Xecute v0.1.0</span>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-[#9662FF] text-white border border-[#111]">
              Testnet
            </span>
          </div>
          <div className="flex items-center gap-3">
            {/* TODO: replace with real URLs when legal pages exist */}
            <a href="https://floors.xyz/terms" target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-gray-400 underline cursor-pointer">Terms</a>
            <a href="https://floors.xyz/privacy" target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-gray-400 underline cursor-pointer">Privacy</a>
          </div>
        </div>

      </div>
    </div>
  );
}
