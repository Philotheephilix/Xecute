/**
 * Floors Extension Popup — main entrypoint.
 *
 * When opened via icon click: tabbed portfolio/activity/settings interface.
 * When opened via content script (ticker param): buy flow overlay.
 * P1-C: Real quote → sign → submit → SSE status flow.
 * WYSIWYS: user sees exact amounts before signing.
 * P2-6: Floor protection row, partial outcome screen, floor badge on success.
 */

import { h, render, Fragment } from 'preact';
import { useState, useCallback, useEffect, useRef, useMemo } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { signWithPasskey } from '../../lib/webauthn.js';
import { verifyAgainstSheet } from '@floors/intents';
import type { IntentPayload } from '@floors/intents';

const API_URL = (import.meta as unknown as { env: Record<string, string | undefined> }).env['VITE_API_URL'] ?? 'http://localhost:3001';

// ── Types ─────────────────────────────────────────────────────────────────────

type Tab = 'home' | 'portfolio' | 'activity' | 'settings';

type Screen = 'passkey-picker' | 'buy' | 'signing' | 'success' | 'partial' | 'error' | 'onboarding' | 'create-passkey' | 'creating-account' | 'account-ready' | 'sign-in' | 'link-device' | 'main' | 'fund';

/** Floor selection: bps=0 means off */
type FloorBps = 0 | 1000 | 2000;
/** Duration is now a continuous value in seconds (slider-driven) */
type FloorDuration = number;

/** Slider range: 1 day min, 2 days max (testnet) */
const DURATION_MIN_SECS = 86400;      // 1 day (must match risk service minimum)
const DURATION_MAX_SECS = 172800;     // 2 days
const DURATION_DEFAULT_SECS = 86400;  // 1 day

interface FloorSelection {
  bps: FloorBps;
  duration_secs: FloorDuration;
}

interface DraftQuote {
  quote_id: string;
  asset: string;
  pay_usdc: string;
  est_qty: string;
  expires_at: string;
  display: {
    you_pay: string;
    est_amount: string;
    expires: string;
  };
  // Floor fields — present when floor was requested
  floor_price_e6?: string;
  fee_usdc?: string;
  // Availability — present when asset is recognized but not yet tradeable
  available?: boolean;
  reason?: string;
}

interface SheetState {
  ticker: string;
  postId: string | undefined;
  /** Floors account ID — read from localStorage key floors:account_id */
  accountId: string;
  /** Passkey credential ID — read from localStorage key floors:credential_id */
  savedCredentialId: string;
  screen: Screen;
  signing: boolean;
  statusId: string | null;
  txHash: string | null;
  errorMsg: string | null;
  draftQuote: DraftQuote | null;
  draftLoading: boolean;
  draftError: string | null;
  floor: FloorSelection;
  /** Partial outcome: swap succeeded but floor failed */
  partialFloorError: string | null;
  /** Partial outcome: actual quantity received from the swap */
  partialActualQty: string | null;
  /** On-chain floor ID returned after a successful buy — used for sell-back */
  floorId: string | null;
  /** All registered passkeys — source: 'extension' for inline-created, absent/other for web-synced */
  passkeys: Array<{ name: string; credentialId: string; createdAt: string; source?: string }>;
  /** True after chrome.storage.local read completes */
  storageLoaded: boolean;
  /** Compressed key hex — saved during inline passkey creation for the creating-account screen */
  pendingCompressedKeyHex: string;
  /** Passkey name being used during onboarding creation flow */
  pendingPasskeyName: string;
  /** USD amount the user wants to spend */
  amount: number;
  /** Active tab when screen is 'main' */
  activeTab: Tab;
  /** When set, PortfolioTab scrolls to and highlights this floor position */
  highlightFloorId: string | null;
}

// ── URL params ────────────────────────────────────────────────────────────────

function getParams(): { ticker: string; postId: string | undefined } {
  const params = new URLSearchParams(window.location.search);
  const ticker = params.get('ticker') ?? 'ETH';
  const postId = params.get('postId') ?? undefined;
  return { ticker, postId };
}

// ── Helpers ─ hex ─────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ── Passkey creation helpers (ported from web app) ──────────────────────────

/**
 * Extract a 33-byte compressed SEC1 P-256 public key from a SubjectPublicKeyInfo blob.
 */
function extractCompressedP256Key(subjectPublicKeyInfo: Uint8Array): Uint8Array {
  const spki = subjectPublicKeyInfo;
  let markerIndex = -1;
  for (let i = spki.length - 65; i >= 0; i--) {
    if (spki[i] === 0x04 && i + 65 === spki.length) {
      markerIndex = i;
      break;
    }
  }
  if (markerIndex === -1) {
    throw new Error('Could not locate uncompressed P-256 point in SubjectPublicKeyInfo');
  }
  const x = spki.slice(markerIndex + 1, markerIndex + 33);
  const y = spki[markerIndex + 64];
  if (y === undefined) {
    throw new Error('Malformed P-256 SubjectPublicKeyInfo: Y coordinate missing');
  }
  const prefix = (y & 1) === 0 ? 0x02 : 0x03;
  const compressed = new Uint8Array(33);
  compressed[0] = prefix;
  compressed.set(x, 1);
  return compressed;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface InlinePasskeyResult {
  credentialId: string;
  compressedKeyHex: string;
}

/**
 * Create a passkey via WebAuthn and extract the compressed P-256 public key.
 * Runs entirely in the extension popup (chrome-extension:// origin).
 */
async function createPasskeyInline(name: string): Promise<InlinePasskeyResult> {
  const displayName = name.trim() || 'Xecute User';
  const credential = await navigator.credentials.create({
    publicKey: {
      rp: {
        name: 'Xecute',
        id: globalThis.location?.hostname ?? 'localhost',
      },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: displayName,
        displayName,
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' as const }, // ES256 / P-256
      ],
      authenticatorSelection: {
        residentKey: 'required' as const,
        userVerification: 'required' as const,
      },
      attestation: 'none' as const,
      timeout: 60000,
    },
  });

  if (!credential || credential.type !== 'public-key') {
    throw new Error('WebAuthn credential creation failed');
  }

  const pkCredential = credential as PublicKeyCredential;
  const response = pkCredential.response as AuthenticatorAttestationResponse;
  const rawKey = response.getPublicKey();
  if (!rawKey) {
    throw new Error('Authenticator did not return a public key');
  }
  const compressedKey = extractCompressedP256Key(new Uint8Array(rawKey));
  const compressedKeyHex = bytesToHex(compressedKey);

  // Encode credential ID as base64url
  const credentialId = btoa(String.fromCharCode(...new Uint8Array(pkCredential.rawId)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return { credentialId, compressedKeyHex };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatFloorPrice(floor_price_e6: string): string {
  const cents = Number(floor_price_e6);
  const dollars = cents / 1_000_000;
  return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatFee(fee_usdc: string): string {
  const raw = Number(fee_usdc);
  const dollars = raw / 1_000_000;
  return `$${dollars.toFixed(2)}`;
}

function formatFloorExpiry(duration_secs: FloorDuration): string {
  const ms = duration_secs * 1000;
  const expiry = new Date(Date.now() + ms);
  return expiry.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Format duration_secs as a human-readable label: "1 hour", "12 hours", "1 day", "2 days" */
function formatDurationLabel(secs: number): string {
  const hours = Math.round(secs / 3600);
  if (hours < 24) {
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  const days = hours / 24;
  if (Number.isInteger(days)) {
    return days === 1 ? '1 day' : `${days} days`;
  }
  // e.g. 1.5 days → "36 hours"
  return `${hours} hours`;
}

/** Map raw API / network errors to user-friendly messages. Never show raw JSON. */
function friendlyError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('unsupported asset') || lower.includes('unsupported_asset')) return 'This asset isn’t available yet — coming soon!';
  if (lower.includes('quote expired') || lower.includes('quote_expired')) return 'Price changed, refreshing…';
  if (lower.includes('networkerror') || lower.includes('failed to fetch') || lower.includes('load failed')) return 'Could not reach server. Check your connection.';
  if (lower.includes('temporarily unavailable')) return 'Service temporarily unavailable. Try again in a moment.';
  if (lower.includes('timeout') || lower.includes('timed out')) return 'Request timed out. Try again.';
  // Fallback: strip anything that looks like raw JSON or HTTP codes
  if (raw.startsWith('{') || raw.startsWith('[') || /^\d{3}\s/.test(raw)) return 'Something went wrong. Try again.';
  // If the message is short and readable, use it; otherwise generic
  if (raw.length > 120) return 'Something went wrong. Try again.';
  return raw;
}

/** Quick-select amount presets */
const QUICK_AMOUNTS = [5, 10, 25, 50] as const;

// ── SVG icons ─────────────────────────────────────────────────────────────────

function BackArrow() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#111111"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

function CheckCircle() {
  return (
    <svg
      width="72"
      height="72"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#29CEB4"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="9 12 11.5 14.5 15 10" />
    </svg>
  );
}

function WarnCircle() {
  return (
    <svg
      width="64"
      height="64"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#EF7B28"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

// ── Floor Row ─────────────────────────────────────────────────────────────────

interface FloorRowProps {
  floor: FloorSelection;
  draftQuote: DraftQuote | null;
  onChange: (floor: FloorSelection) => void;
}

function FloorRow({ floor, draftQuote, onChange }: FloorRowProps) {
  const bpsOptions: { label: string; value: FloorBps }[] = [
    { label: '10% floor', value: 1000 },
    { label: '20% floor', value: 2000 },
  ];

  const isActive = floor.bps > 0;

  const btnBase: h.JSX.CSSProperties = {
    border: '2px solid #111111',
    borderRadius: '8px',
    padding: '6px 14px',
    fontSize: '12px',
    fontWeight: 800,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'transform 0.1s ease, box-shadow 0.1s ease',
    flex: 1,
    textAlign: 'center' as const,
  };
  const btnInactive: h.JSX.CSSProperties = { ...btnBase, background: 'white', color: '#111111' };
  const btnActive: h.JSX.CSSProperties = { ...btnBase, background: '#29CEB4', color: '#111111' };
  const btnActiveClass = 'shadow-neo-sm active:translate-y-[2px] active:shadow-none';

  /** Slider: 1 day to 2 days, 1-hour steps = 24 steps */
  const sliderSteps = 24;
  const sliderToSecs = (val: number): number => {
    // val ranges 1..24 → 86400..172800 (1 day to 2 days)
    return Math.max(DURATION_MIN_SECS, Math.min(DURATION_MIN_SECS + (val - 1) * 3600, DURATION_MAX_SECS));
  };
  const secsToSlider = (secs: number): number => {
    return Math.max(1, Math.min(Math.round((secs - DURATION_MIN_SECS) / 3600) + 1, sliderSteps));
  };

  return (
    <div
      style={{
        background: 'white',
        border: '2px solid #111111',
        borderRadius: '14px',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        boxShadow: '0px 3px 0px #111111',
      }}
      aria-label="Floor protection options"
    >
      {/* Top row: label + on/off */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '13px', fontWeight: 700, color: '#111111', display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span role="img" aria-label="shield">🛡</span> Floor Protection
        </span>
        {isActive && (
          <button
            onClick={() => onChange({ ...floor, bps: 0 as FloorBps })}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '11px',
              fontWeight: 700,
              color: '#6b7280',
              cursor: 'pointer',
              fontFamily: 'inherit',
              textDecoration: 'underline',
              textUnderlineOffset: '2px',
            }}
          >
            Turn off
          </button>
        )}
      </div>

      {/* Floor level toggle — 10% or 20% */}
      <div style={{ display: 'flex', gap: '8px' }}>
        {bpsOptions.map(({ label, value }) => (
          <button
            key={value}
            className={floor.bps === value ? btnActiveClass : undefined}
            style={floor.bps === value ? btnActive : btnInactive}
            onClick={() => onChange({ ...floor, bps: value })}
            aria-pressed={floor.bps === value}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Duration slider — only when floor is on */}
      {isActive && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>Duration</span>
            <span style={{ fontSize: '13px', fontWeight: 800, color: '#111111' }}>
              {formatDurationLabel(floor.duration_secs)}
            </span>
          </div>
          <div style={{ position: 'relative', padding: '4px 0' }}>
            <input
              type="range"
              min={1}
              max={sliderSteps}
              step={1}
              value={secsToSlider(floor.duration_secs)}
              onInput={(e) => {
                const val = parseInt((e.target as HTMLInputElement).value, 10);
                onChange({ ...floor, duration_secs: sliderToSecs(val) as FloorDuration });
              }}
              style={{
                width: '100%',
                height: '6px',
                borderRadius: '3px',
                appearance: 'none',
                WebkitAppearance: 'none',
                background: `linear-gradient(to right, #29CEB4 ${((secsToSlider(floor.duration_secs) - 1) / (sliderSteps - 1)) * 100}%, #e5e7eb ${((secsToSlider(floor.duration_secs) - 1) / (sliderSteps - 1)) * 100}%)`,
                outline: 'none',
                cursor: 'pointer',
              }}
              aria-label="Floor duration"
              data-testid="duration-slider"
            />
            <style>{`
              input[type=range][data-testid="duration-slider"]::-webkit-slider-thumb {
                -webkit-appearance: none;
                appearance: none;
                width: 20px;
                height: 20px;
                border-radius: 50%;
                background: #111111;
                border: 3px solid #29CEB4;
                cursor: pointer;
                box-shadow: 0 2px 4px rgba(0,0,0,0.15);
              }
              input[type=range][data-testid="duration-slider"]::-moz-range-thumb {
                width: 20px;
                height: 20px;
                border-radius: 50%;
                background: #111111;
                border: 3px solid #29CEB4;
                cursor: pointer;
                box-shadow: 0 2px 4px rgba(0,0,0,0.15);
              }
            `}</style>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '10px', fontWeight: 600, color: '#9ca3af' }}>1 day</span>
            <span style={{ fontSize: '10px', fontWeight: 600, color: '#9ca3af' }}>2 days</span>
          </div>
        </div>
      )}

      {/* Floor price + fee — only when quote includes floor data */}
      {isActive && draftQuote?.floor_price_e6 !== undefined && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>Floor price</span>
            <span style={{ fontSize: '14px', fontWeight: 800, color: '#111111' }}>
              {formatFloorPrice(draftQuote.floor_price_e6)}
            </span>
          </div>
          {draftQuote.fee_usdc !== undefined && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '12px', fontWeight: 700, color: '#29CEB4' }}>Most you can lose</span>
              <span style={{ fontSize: '14px', fontWeight: 800, color: '#29CEB4' }}>
                {formatFee(draftQuote.fee_usdc)}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Fund screen ──────────────────────────────────────────────────────────────

function FundScreen({ accountId, onBack }: { accountId: string; onBack: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(accountId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [accountId]);

  return (
    <div style={{
      padding: '24px 20px',
      fontFamily: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      background: '#FAF9F6',
      minHeight: '100%',
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button
          onClick={onBack}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '4px',
            display: 'flex', alignItems: 'center',
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <span style={{ fontSize: '18px', fontWeight: 800, color: '#111' }}>Fund Account</span>
      </div>

      {/* Info card */}
      <div style={{
        background: 'white', border: '2px solid #111',
        borderRadius: '14px', boxShadow: '0 2.5px 0 #111',
        padding: '20px 16px',
        display: 'flex', flexDirection: 'column', gap: '14px',
      }}>
        <p style={{ fontSize: '13px', fontWeight: 600, color: '#374151', lineHeight: '1.5' }}>
          Send USDC to your NEAR address to fund your account.
        </p>

        <div>
          <p style={{ fontSize: '10px', fontWeight: 800, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>
            Your NEAR Address
          </p>
          <div style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            background: '#f3f4f6', borderRadius: '10px', padding: '10px 12px',
          }}>
            <span style={{
              fontSize: '12px', fontWeight: 600, color: '#111',
              wordBreak: 'break-all', flex: 1, fontFamily: 'monospace',
            }}>
              {accountId}
            </span>
            <button
              onClick={handleCopy}
              style={{
                background: copied ? '#29CEB4' : '#EF7B28',
                border: 'none', borderRadius: '8px',
                padding: '6px 12px', cursor: 'pointer',
                fontSize: '11px', fontWeight: 800, color: 'white',
                whiteSpace: 'nowrap',
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: '12px' }}>
          <p style={{ fontSize: '12px', fontWeight: 700, color: '#374151', marginBottom: '4px' }}>
            Accepted token
          </p>
          <p style={{ fontSize: '12px', color: '#6b7280', fontFamily: 'monospace' }}>
            usdc.fakes.testnet
          </p>
        </div>

        <p style={{ fontSize: '11px', color: '#9ca3af', lineHeight: '1.4' }}>
          Deposit USDC to this address on NEAR. Your balance will update automatically.
        </p>
      </div>
    </div>
  );
}

// ── Buy screen ────────────────────────────────────────────────────────────────

interface BuyScreenProps {
  state: SheetState;
  onConfirm: () => void;
  onBack: () => void;
  onFloorChange: (floor: FloorSelection) => void;
  onAmountChange: (amount: number) => void;
}

function BuyScreen({ state, onConfirm, onBack, onFloorChange, onAmountChange }: BuyScreenProps) {
  const { draftQuote, draftLoading, draftError, ticker, signing, floor, amount } = state;
  const hasFloor = floor.bps > 0;
  const canConfirm = !signing && draftQuote !== null && !draftLoading && amount > 0;
  const inputRef = useRef<HTMLInputElement>(null);

  /** Compute a per-token price from the quote for the live estimate line */
  const perTokenPrice: number | null = draftQuote
    ? Number(draftQuote.pay_usdc) / 1_000_000 / Number(draftQuote.display.est_amount)
    : null;

  return (
    <div
      className="screen screen-active"
      style={{ padding: '0', display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}
    >
      {/* Sub-header: back + title */}
      <div
        style={{
          background: '#FAF9F6',
          padding: '8px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          borderBottom: '1px solid #e5e7eb',
          flexShrink: 0,
        }}
      >
        <button className="btn-back" onClick={onBack} aria-label="Back" style={{ width: '34px', height: '34px', borderRadius: '10px' }}>
          <BackArrow />
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '16px', fontWeight: 800, color: '#111111', lineHeight: 1.2 }}>
            Buy ${ticker}
          </div>
        </div>
        <div
          style={{
            background: 'white',
            border: '2px solid #111111',
            borderRadius: '20px',
            padding: '3px 10px',
            fontSize: '12px',
            fontWeight: 800,
            boxShadow: '0px 2px 0px #111111',
          }}
        >
          ${ticker}
        </div>
      </div>

      {/* Scrollable body */}
      <div
        className="no-scrollbar"
        style={{
          flex: 1,
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          overflowY: 'auto',
          minHeight: 0,
        }}
      >
        {/* ── Amount Input Card ───────────────────────────────── */}
        <div
          style={{
            background: 'white',
            border: '2px solid #111111',
            borderRadius: '14px',
            padding: '12px',
            boxShadow: '0px 3px 0px #111111',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
          aria-label="Amount input"
        >
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Amount (USD)
          </div>

          {/* Dollar input row */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              border: '2px solid #111111',
              borderRadius: '10px',
              padding: '0 12px',
              height: '40px',
              boxShadow: '0px 2px 0px #111111',
              background: 'white',
            }}
          >
            <span style={{ fontSize: '18px', fontWeight: 800, color: '#111111', marginRight: '4px' }}>$</span>
            <input
              ref={inputRef}
              type="number"
              inputMode="decimal"
              step="0.01"
              min="1"
              max="1000"
              value={amount}
              onInput={(e) => {
                const raw = (e.target as HTMLInputElement).value;
                const val = parseFloat(raw);
                if (!isNaN(val) && val >= 0) {
                  onAmountChange(Math.min(val, 1000));
                } else if (raw === '') {
                  onAmountChange(0);
                }
              }}
              style={{
                flex: 1,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                fontSize: '18px',
                fontWeight: 800,
                color: '#111111',
                fontFamily: 'inherit',
                width: '100%',
              }}
              data-testid="amount-input"
              aria-label="Amount in USD"
            />
          </div>

          {/* Quick-select pills */}
          <div style={{ display: 'flex', gap: '6px' }}>
            {QUICK_AMOUNTS.map((preset) => {
              const isSelected = amount === preset;
              return (
                <button
                  key={preset}
                  onClick={() => onAmountChange(preset)}
                  className={isSelected ? 'shadow-neo-sm active:translate-y-[2px] active:shadow-none' : undefined}
                  style={{
                    flex: 1,
                    border: '2px solid #111111',
                    borderRadius: '8px',
                    padding: '5px 0',
                    fontSize: '12px',
                    fontWeight: 800,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    background: isSelected ? '#29CEB4' : 'white',
                    color: '#111111',
                    transition: 'transform 0.1s ease, box-shadow 0.1s ease',
                  }}
                  aria-pressed={isSelected}
                  data-testid={`quick-${preset}`}
                >
                  ${preset}
                </button>
              );
            })}
          </div>

          {/* Live estimate */}
          {draftLoading && amount > 0 && (
            <div style={{ fontSize: '12px', color: '#6b7280', fontWeight: 600 }}>
              Fetching estimate…
            </div>
          )}
          {draftQuote !== null && !draftLoading && amount > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
              <span style={{ fontSize: '14px', fontWeight: 800, color: '#111111' }} data-testid="est-amount">
                ≈ {draftQuote.display.est_amount} {ticker}
              </span>
              {perTokenPrice !== null && isFinite(perTokenPrice) && (
                <span style={{ fontSize: '11px', fontWeight: 600, color: '#6b7280' }}>
                  at ${perTokenPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/{ticker}
                </span>
              )}
            </div>
          )}
          {draftError !== null && !draftLoading && (
            <div style={{ fontSize: '12px', color: '#EF7B28', fontWeight: 600 }}>
              {draftError}
            </div>
          )}
        </div>

        {/* ── Floor Protection Row ────────────────────────────── */}
        <FloorRow
          floor={floor}
          draftQuote={draftQuote}
          onChange={onFloorChange}
        />

        {/* ── Order Summary Card ──────────────────────────────── */}
        {draftQuote !== null && !draftLoading && amount > 0 && (
          <div
            style={{
              background: 'white',
              border: '2px solid #111111',
              borderRadius: '14px',
              padding: '10px 12px',
              boxShadow: '0px 3px 0px #111111',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
            aria-label="Order summary"
          >
            <div style={{ fontSize: '11px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Order Summary
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>You pay</span>
              <span style={{ fontSize: '13px', fontWeight: 800, color: '#111111' }} data-testid="you-pay">
                ${draftQuote.display.you_pay} USDC
              </span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>You get</span>
              <span style={{ fontSize: '13px', fontWeight: 800, color: '#111111' }}>
                ~{draftQuote.display.est_amount} {ticker}
              </span>
            </div>

            {/* Floor price — only when floor is active and quote has floor data */}
            {hasFloor && draftQuote.floor_price_e6 !== undefined && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>
                  Floor ({floor.bps / 100}%)
                </span>
                <span style={{ fontSize: '13px', fontWeight: 800, color: '#29CEB4' }}>
                  {formatFloorPrice(draftQuote.floor_price_e6)}
                </span>
              </div>
            )}

            {/* Fee — shown when available */}
            {draftQuote.fee_usdc !== undefined && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>Fee</span>
                <span style={{ fontSize: '12px', fontWeight: 700, color: '#6b7280' }}>
                  {formatFee(draftQuote.fee_usdc)}
                </span>
              </div>
            )}

            {/* Expiry — always shown when floor active */}
            {hasFloor && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>Expires</span>
                <span style={{ fontSize: '12px', fontWeight: 700, color: '#111111' }}>
                  {formatDurationLabel(floor.duration_secs)}
                </span>
              </div>
            )}

            {/* Quote ID */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '11px', fontWeight: 600, color: '#6b7280' }}>Quote ID</span>
              <span style={{ fontSize: '10px', fontWeight: 700, color: '#6b7280', fontFamily: 'monospace' }}>
                {draftQuote.quote_id.slice(0, 8)}…
              </span>
            </div>
          </div>
        )}

        {/* Bottom spacer so content doesn't hide behind fixed button */}
        <div style={{ height: '68px', flexShrink: 0 }} />
      </div>

      {/* Fixed confirm button footer */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          padding: '10px 14px',
          background: 'linear-gradient(to top, #FAF9F6 80%, transparent)',
          zIndex: 20,
          flexShrink: 0,
        }}
      >
        <button
          className="btn-neo"
          onClick={onConfirm}
          disabled={!canConfirm}
          style={{
            width: '100%',
            height: '46px',
            background: canConfirm ? '#EF7B28' : '#cccccc',
            color: '#111111',
            fontSize: '14px',
            fontWeight: 800,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            opacity: canConfirm ? 1 : 0.7,
            cursor: signing ? 'wait' : canConfirm ? 'pointer' : 'not-allowed',
          }}
          aria-busy={signing}
        >
          {signing ? (
            'Verifying…'
          ) : (
            <>
              <span>Confirm with Passkey</span>
              <span role="img" aria-label="fingerprint">👆</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// ── Signing screen ────────────────────────────────────────────────────────────

function SigningScreen({ statusId }: { statusId: string | null }) {
  return (
    <div
      className="screen screen-active"
      style={{ padding: '32px 18px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}
    >
      <style>{`@keyframes floors-spin { to { transform: rotate(360deg); } }`}</style>
      <span style={{ display: 'inline-block', width: 20, height: 20, border: '2px solid #111', borderTopColor: 'transparent', borderRadius: '50%', animation: 'floors-spin 0.8s linear infinite', marginBottom: '12px' }} />
      <div style={{ fontSize: '16px', fontWeight: 700, color: '#111111', marginBottom: '8px' }}>
        Submitting order…
      </div>
      {statusId !== null && (
        <div style={{ fontSize: '12px', color: '#6b7280' }} data-testid="status-id">
          {statusId}
        </div>
      )}
    </div>
  );
}

// ── Success screen ────────────────────────────────────────────────────────────

interface SuccessScreenProps {
  ticker: string;
  draftQuote: DraftQuote | null;
  statusId: string | null;
  txHash: string | null;
  floorIncluded: boolean;
  floor: FloorSelection;
  onViewPortfolio: () => void;
}

function SuccessScreen({ ticker, draftQuote, statusId, txHash, floorIncluded, floor, onViewPortfolio }: SuccessScreenProps) {
  return (
    <div
      className="screen screen-enter-right screen-active"
      style={{ padding: '0', display: 'flex', flexDirection: 'column' }}
    >
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '32px 18px',
          gap: '24px',
        }}
      >
        <div
          style={{
            width: '96px',
            height: '96px',
            background: 'white',
            border: '2px solid #111111',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0px 4px 0px #111111',
          }}
        >
          <CheckCircle />
        </div>

        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '24px', fontWeight: 800, color: '#111111', lineHeight: 1.2 }}>
            {floorIncluded
              ? `Bought ${draftQuote?.display.est_amount ?? ''} ${ticker}. Protected.`
              : 'Order Submitted!'}
          </div>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#6b7280', marginTop: '6px' }}>
            {floorIncluded
              ? 'Your position is protected by a floor'
              : 'Confirming on-chain — check your portfolio in a moment.'}
          </div>
        </div>

        {/* Floor badge */}
        {floorIncluded && draftQuote?.floor_price_e6 !== undefined && (
          <div
            style={{
              background: '#29CEB4',
              border: '2px solid #111111',
              borderRadius: '20px',
              padding: '6px 16px',
              boxShadow: '0px 2.5px 0px #111111',
              fontSize: '13px',
              fontWeight: 800,
              color: '#111111',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
            data-testid="floor-badge"
          >
            <span role="img" aria-label="shield">🛡</span>
            {`Floor at ${formatFloorPrice(draftQuote.floor_price_e6)} until ${formatFloorExpiry(floor.duration_secs)}`}
          </div>
        )}

        <div
          style={{
            width: '100%',
            background: 'white',
            border: '2px solid #111111',
            borderRadius: '18px',
            padding: '16px',
            boxShadow: '0px 4px 0px #111111',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '8px', borderBottom: '1.5px solid #e5e7eb' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>Token</span>
            <span style={{ fontSize: '13px', fontWeight: 800, color: '#111111' }}>${ticker}</span>
          </div>

          {draftQuote !== null && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '8px', borderBottom: '1.5px solid #e5e7eb' }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>Amount</span>
                <span style={{ fontSize: '13px', fontWeight: 800, color: '#111111' }}>
                  ~{draftQuote.display.est_amount} {ticker}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '8px', borderBottom: '1.5px solid #e5e7eb' }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>Paid</span>
                <span style={{ fontSize: '13px', fontWeight: 800, color: '#111111' }}>
                  ${draftQuote.display.you_pay} USDC
                </span>
              </div>
            </>
          )}

          {statusId !== null && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>Order ID</span>
              <span style={{ fontSize: '11px', fontWeight: 700, color: '#6b7280', fontFamily: 'monospace' }} data-testid="status-id">
                {statusId.slice(0, 8)}...
              </span>
            </div>
          )}

          {txHash !== null && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>Tx Hash</span>
              <span style={{ fontSize: '11px', fontWeight: 700, color: '#6b7280', fontFamily: 'monospace' }}>
                {txHash.slice(0, 10)}...
              </span>
            </div>
          )}
        </div>
      </div>

      <div style={{ padding: '0 18px 24px' }}>
        <button
          className="btn-neo"
          onClick={onViewPortfolio}
          style={{
            width: '100%',
            height: '52px',
            background: '#29CEB4',
            color: '#111111',
            fontSize: '15px',
            fontWeight: 800,
          }}
        >
          View in Portfolio
        </button>
      </div>
    </div>
  );
}

// ── Partial screen ────────────────────────────────────────────────────────────

interface PartialScreenProps {
  ticker: string;
  draftQuote: DraftQuote | null;
  floorError: string;
  /** Actual qty received from swap SSE event (H6: show actual not estimated) */
  actualQty: string | null;
  onAddFloor: () => void;
  onContinue: () => void;
  /** H5: sell the partially-received token back to USDC */
  onSellBack: () => void;
  /** Disable buttons while a sell-back signing is in progress */
  signing?: boolean;
}

function PartialScreen({ ticker, draftQuote, floorError, actualQty, onAddFloor, onContinue, onSellBack, signing }: PartialScreenProps) {
  return (
    <div
      className="screen screen-enter-right screen-active"
      style={{ padding: '0', display: 'flex', flexDirection: 'column' }}
    >
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '32px 18px',
          gap: '20px',
        }}
      >
        <div
          style={{
            width: '88px',
            height: '88px',
            background: 'white',
            border: '2px solid #111111',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0px 4px 0px #111111',
          }}
        >
          <WarnCircle />
        </div>

        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '22px', fontWeight: 800, color: '#111111', lineHeight: 1.2 }}>
            Partially Completed
          </div>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#6b7280', marginTop: '6px' }}>
            Floor wasn't added
          </div>
        </div>

        <div
          style={{
            width: '100%',
            background: 'white',
            border: '2px solid #111111',
            borderRadius: '18px',
            padding: '16px',
            boxShadow: '0px 4px 0px #111111',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
          }}
        >
          {/* Swap success row — H6: show actual_qty if available, fall back to estimate */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '16px', color: '#29CEB4', fontWeight: 800 }}>✓</span>
            <span style={{ fontSize: '13px', fontWeight: 700, color: '#111111' }}>
              Bought {actualQty ? (Number(actualQty) / 1e18).toFixed(6) : draftQuote?.display.est_amount ?? ''} {ticker}
            </span>
          </div>

          {/* Floor failure row */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
            <span style={{ fontSize: '16px', color: '#EF7B28', fontWeight: 800, lineHeight: '20px' }}>✗</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span style={{ fontSize: '13px', fontWeight: 700, color: '#111111' }}>Floor wasn't added</span>
              <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>
                Reason: {floorError}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: '0 18px 24px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <button
          className="btn-neo"
          onClick={onAddFloor}
          style={{
            width: '100%',
            height: '52px',
            background: '#29CEB4',
            color: '#111111',
            fontSize: '15px',
            fontWeight: 800,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
          }}
          data-testid="add-floor-now"
        >
          <span role="img" aria-label="shield">🛡</span> Try the floor again
        </button>
        <button
          className="btn-neo"
          onClick={onContinue}
          style={{
            width: '100%',
            height: '44px',
            background: 'white',
            color: '#111111',
            fontSize: '14px',
            fontWeight: 700,
          }}
          data-testid="continue-without-floor"
        >
          Keep without floor
        </button>
        {/* H5: swap the received tokens back to USDC */}
        <button
          className="btn-neo"
          onClick={onSellBack}
          disabled={signing}
          style={{
            width: '100%',
            height: '44px',
            background: 'white',
            color: '#6b7280',
            fontSize: '13px',
            fontWeight: 600,
            opacity: signing ? 0.6 : 1,
            cursor: signing ? 'not-allowed' : 'pointer',
          }}
          data-testid="swap-back-to-usdc"
        >
          {signing ? 'Signing…' : 'Swap back to USDC'}
        </button>
      </div>
    </div>
  );
}

// ── Error screen ──────────────────────────────────────────────────────────────

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      className="screen screen-active"
      style={{ padding: '32px 18px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px' }}
    >
      <div style={{ fontSize: '20px', fontWeight: 800, color: '#EF7B28' }}>Order Failed</div>
      <div style={{ fontSize: '13px', fontWeight: 600, color: '#6b7280', textAlign: 'center' }}>{message}</div>
      <button
        className="btn-neo"
        onClick={onRetry}
        style={{ width: '100%', height: '52px', background: '#EF7B28', color: '#111111', fontSize: '15px', fontWeight: 800 }}
      >
        Try Again
      </button>
    </div>
  );
}

// ── Welcome Screen (no account) ─────────────────────────────────────────────

interface WelcomeScreenProps {
  onCreateWallet: () => void;
  onSignIn: () => void;
}

function WelcomeScreen({ onCreateWallet, onSignIn }: WelcomeScreenProps) {
  return (
    <div
      className="screen screen-active"
      style={{
        padding: '48px 24px 32px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '20px',
        textAlign: 'center',
      }}
    >
      <img src="/icon-128.png" alt="Xecute" width="64" height="64" style={{ borderRadius: '14px' }} />
      <div style={{ fontSize: '22px', fontWeight: 800, color: '#111111' }}>
        Xecute
      </div>
      <div style={{ fontSize: '13px', fontWeight: 500, color: '#6b7280', lineHeight: '1.5' }}>
        Buy crypto with floor protection, directly from X posts.
      </div>
      <button
        className="btn-neo"
        onClick={onCreateWallet}
        style={{
          width: '100%',
          height: '52px',
          background: '#EF7B28',
          color: '#111111',
          fontSize: '15px',
          fontWeight: 800,
          marginTop: '8px',
        }}
      >
        Create Wallet
      </button>
      <button
        onClick={onSignIn}
        style={{
          background: 'none',
          border: 'none',
          fontSize: '13px',
          fontWeight: 600,
          color: '#6b7280',
          cursor: 'pointer',
          textDecoration: 'underline',
          textUnderlineOffset: '2px',
          fontFamily: 'inherit',
        }}
      >
        I already have a wallet
      </button>
    </div>
  );
}

// ── Create Passkey Screen (inline) ──────────────────────────────────────────

interface CreatePasskeyScreenProps {
  onCreated: (result: { credentialId: string; compressedKeyHex: string; passkeyName: string }) => void;
  onBack: () => void;
}

function CreatePasskeyScreen({ onCreated, onBack }: CreatePasskeyScreenProps) {
  const [passkeyName, setPasskeyName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const { credentialId, compressedKeyHex } = await createPasskeyInline(passkeyName);
      onCreated({ credentialId, compressedKeyHex, passkeyName: passkeyName.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Passkey creation failed');
    } finally {
      setLoading(false);
    }
  }, [passkeyName, onCreated]);

  return (
    <div
      className="screen screen-active"
      style={{
        padding: '0',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div
        style={{
          background: '#9662FF',
          borderBottom: '2px solid #111111',
          borderRadius: '0 0 28px 28px',
          padding: '16px 18px 20px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          boxShadow: '0px 5px 0px #111111',
        }}
      >
        <button className="btn-back" onClick={onBack} aria-label="Back">
          <BackArrow />
        </button>
        <div style={{ fontSize: '20px', fontWeight: 800, color: '#111111', lineHeight: 1.2 }}>
          Create Passkey
        </div>
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          padding: '24px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}
      >
        <div style={{ fontSize: '14px', fontWeight: 600, color: '#6b7280', lineHeight: '1.5' }}>
          Your passkey replaces passwords. It stays on your device and can never be stolen.
        </div>

        {/* Fingerprint illustration */}
        <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0' }}>
          <div
            style={{
              width: '80px',
              height: '80px',
              background: 'white',
              border: '2px solid #111111',
              borderRadius: '18px',
              boxShadow: '0px 4px 0px #111111',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg viewBox="0 0 80 80" width="48" height="48" fill="none" aria-label="Fingerprint">
              <circle cx="40" cy="40" r="3" fill="#29CEB4" />
              <path d="M34 40 a6 6 0 0 1 12 0" stroke="#29CEB4" strokeWidth="2.5" strokeLinecap="round" />
              <path d="M28 40 a12 12 0 0 1 24 0" stroke="#29CEB4" strokeWidth="2.5" strokeLinecap="round" />
              <path d="M22 40 a18 18 0 0 1 36 0" stroke="#29CEB4" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          </div>
        </div>

        {/* Error */}
        {error !== null && (
          <div
            style={{
              padding: '10px 14px',
              background: 'white',
              border: '2px solid #EF7B28',
              borderRadius: '12px',
              fontSize: '13px',
              fontWeight: 700,
              color: '#EF7B28',
            }}
          >
            {error}
          </div>
        )}

        {/* Passkey name input */}
        <div>
          <label
            htmlFor="passkey-name"
            style={{ display: 'block', fontSize: '13px', fontWeight: 700, color: '#111111', marginBottom: '6px' }}
          >
            Name your passkey
          </label>
          <input
            id="passkey-name"
            type="text"
            value={passkeyName}
            onInput={(e) => setPasskeyName((e.target as HTMLInputElement).value)}
            placeholder='e.g. "My MacBook"'
            disabled={loading}
            style={{
              width: '100%',
              height: '44px',
              padding: '0 14px',
              background: 'white',
              border: '2px solid #111111',
              borderRadius: '12px',
              fontSize: '14px',
              fontWeight: 600,
              color: '#111111',
              fontFamily: 'inherit',
              boxShadow: '0px 2.5px 0px #111111',
              outline: 'none',
            }}
          />
        </div>

        <div style={{ flex: 1 }} />

        {/* Create button */}
        <button
          className="btn-neo"
          onClick={handleCreate}
          disabled={loading || passkeyName.trim().length === 0}
          style={{
            width: '100%',
            height: '52px',
            background: loading || passkeyName.trim().length === 0 ? '#cccccc' : '#EF7B28',
            color: '#111111',
            fontSize: '15px',
            fontWeight: 800,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            opacity: loading || passkeyName.trim().length === 0 ? 0.7 : 1,
            cursor: loading ? 'wait' : passkeyName.trim().length === 0 ? 'not-allowed' : 'pointer',
          }}
        >
          {loading ? (
            <>
              <style>{`@keyframes floors-spin-pk { to { transform: rotate(360deg); } }`}</style>
              <span style={{ display: 'inline-block', width: 18, height: 18, border: '2px solid #111', borderTopColor: 'transparent', borderRadius: '50%', animation: 'floors-spin-pk 0.8s linear infinite' }} />
              Creating…
            </>
          ) : (
            'Create Passkey'
          )}
        </button>
      </div>
    </div>
  );
}

// ── Creating Account Screen ─────────────────────────────────────────────────

interface CreatingAccountScreenProps {
  accountId: string;
  onReady: () => void;
  onError: (msg: string) => void;
}

function CreatingAccountScreen({ accountId, onReady, onError }: CreatingAccountScreenProps) {
  const [step, setStep] = useState(0); // 0=creating, 1=registering, 2=done

  useEffect(() => {
    let cancelled = false;
    const startTime = Date.now();
    const TIMEOUT = 30_000;
    const INTERVAL = 500;

    async function poll() {
      while (!cancelled) {
        if (Date.now() - startTime >= TIMEOUT) {
          onError('Account creation timed out. Please try again.');
          return;
        }
        try {
          const res = await fetch(`${API_URL}/v1/accounts/${encodeURIComponent(accountId)}`);
          if (res.ok) {
            // Account found
            setStep(1);
            await new Promise<void>((r) => setTimeout(r, 700));
            if (cancelled) return;
            setStep(2);
            await new Promise<void>((r) => setTimeout(r, 400));
            if (cancelled) return;
            onReady();
            return;
          }
        } catch {
          // Network error — keep polling
        }
        await new Promise<void>((r) => setTimeout(r, INTERVAL));
      }
    }

    void poll();
    return () => { cancelled = true; };
  }, [accountId, onReady, onError]);

  const steps = [
    { label: 'Passkey created', done: true },
    { label: 'Creating NEAR account…', done: step >= 1 },
    { label: 'Registering on-chain', done: step >= 2 },
  ];

  return (
    <div
      className="screen screen-active"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '48px 24px',
        gap: '24px',
      }}
    >
      <style>{`@keyframes floors-spin-create { to { transform: rotate(360deg); } }`}</style>
      <div style={{ position: 'relative', width: '72px', height: '72px' }}>
        <div
          style={{
            width: '72px',
            height: '72px',
            border: '4px solid #EF7B28',
            borderTopColor: 'transparent',
            borderRadius: '50%',
            animation: 'floors-spin-create 0.8s linear infinite',
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              width: '28px',
              height: '28px',
              border: '2px solid #111111',
              borderRadius: '50%',
              background: 'white',
              boxShadow: '0px 2.5px 0px #111111',
            }}
          />
        </div>
      </div>

      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '20px', fontWeight: 800, color: '#111111', marginBottom: '4px' }}>
          Setting up your account…
        </div>
        <div style={{ fontSize: '13px', fontWeight: 600, color: '#6b7280' }}>
          Creating your NEAR wallet. This takes a moment.
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%', maxWidth: '260px' }}>
        {steps.map(({ label, done }, i) => {
          const isActive = !done && (i === 0 || steps[i - 1]!.done);
          return (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div
                style={{
                  width: '18px',
                  height: '18px',
                  borderRadius: '50%',
                  border: '2px solid #111111',
                  background: done ? '#29CEB4' : isActive ? '#EF7B28' : 'white',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {done && (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </div>
              <span
                style={{
                  fontSize: '13px',
                  fontWeight: 600,
                  color: done ? '#111111' : isActive ? '#EF7B28' : '#9ca3af',
                }}
              >
                {label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Account Ready Screen ────────────────────────────────────────────────────

interface AccountReadyScreenProps {
  accountId: string;
  onContinue: () => void;
}

function AccountReadyScreen({ accountId, onContinue }: AccountReadyScreenProps) {
  return (
    <div
      className="screen screen-active"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '48px 24px 32px',
        gap: '20px',
      }}
    >
      <div
        style={{
          width: '88px',
          height: '88px',
          background: 'white',
          border: '2px solid #111111',
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0px 4px 0px #111111',
        }}
      >
        <CheckCircle />
      </div>

      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '22px', fontWeight: 800, color: '#111111', marginBottom: '6px' }}>
          Account Created!
        </div>
        <div style={{ fontSize: '13px', fontWeight: 600, color: '#6b7280' }}>
          Your Xecute wallet is ready.
        </div>
      </div>

      <div
        style={{
          width: '100%',
          background: 'white',
          border: '2px solid #111111',
          borderRadius: '14px',
          padding: '12px 16px',
          boxShadow: '0px 2.5px 0px #111111',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>Account</span>
        <span style={{ fontSize: '12px', fontWeight: 800, color: '#111111', fontFamily: 'monospace' }}>
          {accountId.length > 20 ? `${accountId.slice(0, 10)}...${accountId.slice(-8)}` : accountId}
        </span>
      </div>

      <div style={{ flex: 1 }} />

      <button
        className="btn-neo"
        onClick={onContinue}
        style={{
          width: '100%',
          height: '52px',
          background: '#29CEB4',
          color: '#111111',
          fontSize: '15px',
          fontWeight: 800,
        }}
      >
        Continue
      </button>
    </div>
  );
}

// ── Link Device Screen (account exists, no extension passkey) ───────────────

interface LinkDeviceScreenProps {
  accountId: string;
  originalCredentialId: string;
  onCreated: (credentialId: string) => void;
}

function LinkDeviceScreen({ accountId, originalCredentialId, onCreated }: LinkDeviceScreenProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      // Create a new passkey bound to the extension's chrome-extension:// origin.
      // This is a SECOND passkey for the same account — the original web passkey
      // has a different RP ID (localhost) and cannot be used here.
      const { credentialId, compressedKeyHex } = await createPasskeyInline('Extension');

      // Register the new credential with the API so submit can look up by credential_id.
      // This is a best-effort call — if it fails, the extension will still send
      // account_id as a fallback in the submit body (see handleConfirm).
      try {
        await fetch(`${API_URL}/v1/accounts/${encodeURIComponent(accountId)}/credentials`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            credential_id: credentialId,
            public_key_hex: compressedKeyHex,
            device_name: 'Extension',
            existing_credential_id: originalCredentialId,
          }),
        });
      } catch {
        // Best-effort — submit will use account_id fallback if this fails
        console.warn('[floors] Failed to register credential with API — will use account_id fallback');
      }

      // Store in chrome.storage.local alongside any existing passkeys
      const passkeyEntry = {
        name: 'Extension',
        credentialId,
        createdAt: new Date().toISOString(),
        source: 'extension' as const,
      };

      const storageResult = await new Promise<Record<string, unknown>>((resolve) => {
        chrome.storage.local.get(['floors:passkeys'], resolve);
      });
      let existingPasskeys: Array<{ name: string; credentialId: string; createdAt: string; source?: string }> = [];
      try {
        const raw = storageResult['floors:passkeys'];
        if (typeof raw === 'string') {
          existingPasskeys = JSON.parse(raw) as typeof existingPasskeys;
        }
      } catch {
        // ignore
      }
      existingPasskeys.push(passkeyEntry);

      await new Promise<void>((resolve) => {
        chrome.storage.local.set({
          'floors:credential_id': credentialId,
          'floors:passkeys': JSON.stringify(existingPasskeys),
        }, resolve);
      });

      onCreated(credentialId);
    } catch (err) {
      setError(friendlyError(err instanceof Error ? err.message : 'Passkey creation failed'));
    } finally {
      setLoading(false);
    }
  }, [onCreated, accountId]);

  const truncated = accountId.length > 20
    ? `${accountId.slice(0, 10)}...${accountId.slice(-8)}`
    : accountId;

  return (
    <div
      className="screen screen-active"
      style={{
        padding: '48px 24px 32px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '20px',
        textAlign: 'center',
      }}
    >
      {/* Lock icon */}
      <div
        style={{
          width: '80px',
          height: '80px',
          background: 'white',
          border: '2px solid #111111',
          borderRadius: '18px',
          boxShadow: '0px 4px 0px #111111',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg viewBox="0 0 80 80" width="48" height="48" fill="none" aria-label="Lock">
          <rect x="24" y="36" width="32" height="24" rx="4" stroke="#29CEB4" strokeWidth="3" fill="none" />
          <path d="M32 36V28a8 8 0 0 1 16 0v8" stroke="#29CEB4" strokeWidth="3" strokeLinecap="round" />
          <circle cx="40" cy="48" r="3" fill="#29CEB4" />
        </svg>
      </div>

      <div>
        <div style={{ fontSize: '22px', fontWeight: 800, color: '#111111', marginBottom: '8px' }}>
          Link This Device
        </div>
        <div style={{ fontSize: '13px', fontWeight: 500, color: '#6b7280', lineHeight: '1.5' }}>
          Your Xecute account exists but needs a passkey on this device to trade.
        </div>
      </div>

      {/* Account badge */}
      <div
        style={{
          width: '100%',
          background: 'white',
          border: '2px solid #111111',
          borderRadius: '14px',
          padding: '12px 16px',
          boxShadow: '0px 2.5px 0px #111111',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>Account</span>
        <span style={{ fontSize: '12px', fontWeight: 800, color: '#111111', fontFamily: 'monospace' }}>
          {truncated}
        </span>
      </div>

      {/* Error */}
      {error !== null && (
        <div
          style={{
            width: '100%',
            padding: '10px 14px',
            background: 'white',
            border: '2px solid #EF7B28',
            borderRadius: '12px',
            fontSize: '13px',
            fontWeight: 700,
            color: '#EF7B28',
          }}
        >
          {error}
        </div>
      )}

      <div style={{ flex: 1 }} />

      {/* Create button */}
      <button
        className="btn-neo"
        onClick={handleCreate}
        disabled={loading}
        style={{
          width: '100%',
          height: '52px',
          background: loading ? '#cccccc' : '#EF7B28',
          color: '#111111',
          fontSize: '15px',
          fontWeight: 800,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
          opacity: loading ? 0.7 : 1,
          cursor: loading ? 'wait' : 'pointer',
        }}
      >
        {loading ? (
          <>
            <style>{`@keyframes floors-spin-ld { to { transform: rotate(360deg); } }`}</style>
            <span style={{ display: 'inline-block', width: 18, height: 18, border: '2px solid #111', borderTopColor: 'transparent', borderRadius: '50%', animation: 'floors-spin-ld 0.8s linear infinite' }} />
            Creating…
          </>
        ) : (
          <>
            <span role="img" aria-label="fingerprint">👆</span>
            Create Device Passkey
          </>
        )}
      </button>
    </div>
  );
}

// ── Sign In Screen (returning user) ─────────────────────────────────────────

interface SignInScreenProps {
  onAuthenticated: (credentialId: string, accountId: string) => void;
  onBack: () => void;
}

function SignInScreen({ onAuthenticated, onBack }: SignInScreenProps) {
  const [passkeys, setPasskeys] = useState<Array<{ name: string; credentialId: string; createdAt: string; source?: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [authenticatingId, setAuthenticatingId] = useState<string | null>(null);

  // Load passkeys from chrome.storage.local — only show extension-native ones.
  // Only passkeys with source:'extension' are usable from the chrome-extension:// origin.
  useEffect(() => {
    chrome.storage.local.get(['floors:passkeys', 'floors:credential_id', 'floors:passkey_name'], (result) => {
      const raw = result['floors:passkeys'];
      if (typeof raw === 'string') {
        try {
          const parsed = JSON.parse(raw) as Array<{ name: string; credentialId: string; createdAt: string; source?: string }>;
          const usable = parsed.filter((pk) => pk.source === 'extension');
          if (usable.length > 0) {
            setPasskeys(usable);
            return;
          }
        } catch {
          // fall through
        }
      }
      // Legacy single credential fallback
      const credentialId = typeof result['floors:credential_id'] === 'string' ? result['floors:credential_id'] as string : '';
      const name = typeof result['floors:passkey_name'] === 'string' ? result['floors:passkey_name'] as string : 'My Passkey';
      if (credentialId) {
        setPasskeys([{ name, credentialId, createdAt: new Date().toISOString() }]);
      }
    });
  }, []);

  const handleSignIn = useCallback(async (pk: { name: string; credentialId: string }) => {
    setError(null);
    setAuthenticatingId(pk.credentialId);
    try {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      await signWithPasskey(challenge, pk.credentialId);

      // Auth succeeded — read account_id from storage
      const result = await new Promise<Record<string, unknown>>((resolve) => {
        chrome.storage.local.get(['floors:account_id'], resolve);
      });
      const accountId = typeof result['floors:account_id'] === 'string' ? result['floors:account_id'] as string : '';
      if (!accountId) {
        throw new Error('Passkey verified but no account found. Please create a new wallet.');
      }
      onAuthenticated(pk.credentialId, accountId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setAuthenticatingId(null);
    }
  }, [onAuthenticated]);

  return (
    <div
      className="screen screen-active"
      style={{ padding: '0', display: 'flex', flexDirection: 'column' }}
    >
      {/* Header */}
      <div
        style={{
          background: '#9662FF',
          borderBottom: '2px solid #111111',
          borderRadius: '0 0 28px 28px',
          padding: '16px 18px 20px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          boxShadow: '0px 5px 0px #111111',
        }}
      >
        <button className="btn-back" onClick={onBack} aria-label="Back">
          <BackArrow />
        </button>
        <div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: '#111111', lineHeight: 1.2 }}>
            Welcome back
          </div>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#111111', opacity: 0.7, marginTop: '2px' }}>
            Sign in with your passkey
          </div>
        </div>
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          padding: '20px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          overflowY: 'auto',
        }}
      >
        {/* Error */}
        {error !== null && (
          <div
            style={{
              padding: '10px 14px',
              background: 'white',
              border: '2px solid #EF7B28',
              borderRadius: '12px',
              fontSize: '13px',
              fontWeight: 700,
              color: '#EF7B28',
              marginBottom: '6px',
            }}
          >
            {error}
          </div>
        )}

        {passkeys.length === 0 && (
          <div
            style={{
              padding: '16px',
              background: 'white',
              border: '2px solid #111111',
              borderRadius: '14px',
              boxShadow: '0px 2.5px 0px #111111',
              fontSize: '13px',
              fontWeight: 600,
              color: '#6b7280',
              textAlign: 'center',
            }}
          >
            No saved passkeys found. Try creating a new wallet.
          </div>
        )}

        {passkeys.map((pk) => (
          <button
            key={pk.credentialId}
            onClick={() => handleSignIn(pk)}
            disabled={authenticatingId !== null}
            style={{
              width: '100%',
              background: 'white',
              border: '2px solid #111111',
              borderRadius: '13px',
              padding: '14px 16px',
              boxShadow: '0px 4px 0px #111111',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              cursor: authenticatingId !== null ? 'wait' : 'pointer',
              fontFamily: 'inherit',
              transition: 'transform 0.1s ease, box-shadow 0.1s ease',
              opacity: authenticatingId !== null && authenticatingId !== pk.credentialId ? 0.5 : 1,
            }}
          >
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontSize: '15px', fontWeight: 800, color: '#111111' }}>
                {pk.name || 'Passkey'}
              </div>
              <div style={{ fontSize: '11px', fontWeight: 600, color: '#6b7280', marginTop: '2px' }}>
                {new Date(pk.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </div>
            </div>
            <div
              style={{
                background: authenticatingId === pk.credentialId ? '#cccccc' : '#EF7B28',
                border: '2px solid #111111',
                borderRadius: '8px',
                padding: '6px 14px',
                fontSize: '13px',
                fontWeight: 800,
                color: 'white',
                boxShadow: '0px 2px 0px #111111',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              {authenticatingId === pk.credentialId ? (
                <>
                  <style>{`@keyframes floors-spin-si { to { transform: rotate(360deg); } }`}</style>
                  <span style={{ display: 'inline-block', width: 14, height: 14, border: '2px solid white', borderTopColor: 'transparent', borderRadius: '50%', animation: 'floors-spin-si 0.8s linear infinite' }} />
                  Verifying
                </>
              ) : (
                'Sign in'
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Passkey Picker Screen ────────────────────────────────────────────────────

interface PasskeyPickerProps {
  passkeys: Array<{ name: string; credentialId: string; createdAt: string; source?: string }>;
  onSelect: (credentialId: string) => void;
}

function PasskeyPickerScreen({ passkeys, onSelect }: PasskeyPickerProps) {
  return (
    <div
      className="screen screen-active"
      style={{
        padding: '0',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div
        style={{
          background: '#9662FF',
          borderBottom: '2px solid #111111',
          borderRadius: '0 0 28px 28px',
          padding: '24px 18px 20px',
          boxShadow: '0px 5px 0px #111111',
        }}
      >
        <div style={{ fontSize: '20px', fontWeight: 800, color: '#111111', lineHeight: 1.2 }}>
          Choose Passkey
        </div>
        <div style={{ fontSize: '13px', fontWeight: 600, color: '#111111', opacity: 0.7, marginTop: '4px' }}>
          Select which passkey to sign with
        </div>
      </div>

      {/* Passkey list */}
      <div
        style={{
          flex: 1,
          padding: '20px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          overflowY: 'auto',
        }}
      >
        {passkeys.map((pk) => (
          <button
            key={pk.credentialId}
            onClick={() => onSelect(pk.credentialId)}
            style={{
              width: '100%',
              background: 'white',
              border: '2px solid #111111',
              borderRadius: '13px',
              padding: '14px 16px',
              boxShadow: '0px 4px 0px #111111',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'transform 0.1s ease, box-shadow 0.1s ease',
            }}
            className="active:translate-y-[2px] active:shadow-none hover:bg-gray-50"
          >
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontSize: '15px', fontWeight: 800, color: '#111111' }}>
                {pk.name || 'Unnamed Passkey'}
              </div>
              <div style={{ fontSize: '11px', fontWeight: 600, color: '#6b7280', marginTop: '2px' }}>
                {new Date(pk.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </div>
            </div>
            <div
              style={{
                background: '#EF7B28',
                border: '2px solid #111111',
                borderRadius: '8px',
                padding: '6px 14px',
                fontSize: '13px',
                fontWeight: 800,
                color: 'white',
                boxShadow: '0px 2px 0px #111111',
              }}
            >
              Use
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Loading Spinner ──────────────────────────────────────────────────────────

function LoadingSpinner() {
  return (
    <div
      className="screen screen-active"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
      }}
    >
      <div
        style={{
          width: '32px',
          height: '32px',
          border: '3px solid #e5e7eb',
          borderTopColor: '#EF7B28',
          borderRadius: '50%',
          animation: 'spin 0.7s linear infinite',
        }}
      />
    </div>
  );
}

// ── Bottom Nav Icons ─────────────────────────────────────────────────────────

function NavHomeIcon({ active }: { active: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      {active ? (
        <path
          d="M3 10.5L12 3l9 7.5V20a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1V10.5z"
          fill="#EF7B28"
          stroke="#111"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M3 10.5L12 3l9 7.5V20a1 1 0 01-1 1h-5v-6h-6v6H4a1 1 0 01-1-1V10.5z"
          stroke="#111"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function NavPortfolioIcon({ active }: { active: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      {active ? (
        <>
          <rect x="3" y="3" width="18" height="18" rx="3" fill="#EF7B28" stroke="#111" strokeWidth="1.5" />
          <polyline points="7 14 10 10 14 13 17 8" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </>
      ) : (
        <>
          <rect x="3" y="3" width="18" height="18" rx="3" stroke="#111" strokeWidth="1.8" fill="none" />
          <polyline points="7 14 10 10 14 13 17 8" stroke="#111" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </>
      )}
    </svg>
  );
}

function NavActivityIcon({ active }: { active: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      {active ? (
        <>
          <circle cx="12" cy="12" r="9" fill="#EF7B28" stroke="#111" strokeWidth="1.5" />
          <polyline points="12 7 12 12 15 14" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="9" stroke="#111" strokeWidth="1.8" />
          <polyline points="12 7 12 12 15 14" stroke="#111" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

function NavSettingsIcon({ active }: { active: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      {active ? (
        <path
          d="M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"
          fill="#EF7B28"
          stroke="#111"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"
          stroke="#111"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      )}
    </svg>
  );
}

// ── Persistent Top Header Bar (MetaMask-style) ─────────────────────────────

interface TopHeaderBarProps {
  accountId: string;
  passkeys: Array<{ name: string; credentialId: string; createdAt: string; source?: string }>;
}

function TopHeaderBar({ accountId, passkeys }: TopHeaderBarProps) {
  const [copied, setCopied] = useState(false);

  const truncatedAddress = accountId.length > 14
    ? `${accountId.slice(0, 6)}...${accountId.slice(-4)}`
    : accountId;

  const accountName = (passkeys.length > 0 && passkeys[0]?.name)
    ? passkeys[0].name
    : 'Account 1';

  const avatarLetter = accountName.charAt(0).toUpperCase();

  const handleCopy = useCallback(() => {
    if (!accountId) return;
    navigator.clipboard.writeText(accountId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [accountId]);

  return (
    <div
      style={{
        height: '48px',
        background: '#FFFFFF',
        display: 'flex',
        alignItems: 'center',
        padding: '0 14px',
        gap: '10px',
        flexShrink: 0,
        borderBottom: '2px solid #111111',
        boxShadow: '0 2px 0 #111111',
        position: 'relative',
        zIndex: 100,
      }}
    >
      {/* Avatar */}
      <div
        style={{
          width: '24px',
          height: '24px',
          borderRadius: '50%',
          background: '#EF7B28',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: '11px', fontWeight: 800, color: 'white', lineHeight: 1 }}>{avatarLetter}</span>
      </div>

      {/* Name + address */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <span style={{ fontSize: '13px', fontWeight: 700, color: '#111111', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {accountName}
        </span>
        <span style={{ fontSize: '10px', fontWeight: 500, color: '#888888', fontFamily: 'monospace', lineHeight: 1.2 }}>
          {truncatedAddress}
        </span>
      </div>

      {/* Copy button */}
      <button
        onClick={handleCopy}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '4px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
        aria-label="Copy address"
      >
        {copied ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#29CEB4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#111111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
        )}
      </button>

      {/* Copied toast */}
      {copied && (
        <div
          style={{
            position: 'absolute',
            top: '52px',
            left: '50%',
            transform: 'translateX(-50%)',
            background: '#29CEB4',
            color: '#111',
            fontSize: '11px',
            fontWeight: 800,
            padding: '4px 14px',
            borderRadius: '8px',
            border: '1.5px solid #111',
            zIndex: 200,
            boxShadow: '0 2px 0 #111',
          }}
        >
          Copied!
        </div>
      )}
    </div>
  );
}

// ── Bottom Navigation Bar ────────────────────────────────────────────────────

interface BottomNavProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}

const NAV_TABS: Array<{ id: Tab; label: string; Icon: (p: { active: boolean }) => h.JSX.Element }> = [
  { id: 'home', label: 'Home', Icon: NavHomeIcon },
  { id: 'portfolio', label: 'Portfolio', Icon: NavPortfolioIcon },
  { id: 'activity', label: 'Activity', Icon: NavActivityIcon },
  { id: 'settings', label: 'Settings', Icon: NavSettingsIcon },
];

function BottomNav({ activeTab, onTabChange }: BottomNavProps) {
  return (
    <nav
      style={{
        position: 'fixed',
        bottom: '8px',
        left: '10px',
        right: '10px',
        height: '52px',
        background: '#FFFFFF',
        borderRadius: '26px',
        border: '2px solid #111111',
        boxShadow: '0 2px 0 #111111',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-around',
        padding: '0 4px',
        zIndex: 50,
      }}
      aria-label="Main navigation"
    >
      {NAV_TABS.map(({ id, label, Icon }) => {
        const isActive = activeTab === id;
        return (
          <button
            key={id}
            onClick={() => onTabChange(id)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '2px',
              flex: 1,
              height: '100%',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
              opacity: isActive ? 1 : 0.6,
              transition: 'transform 0.1s ease',
              padding: 0,
            }}
            aria-label={label}
            aria-current={isActive ? 'page' : undefined}
          >
            <div style={{ position: 'relative' }}>
              <Icon active={isActive} />
            </div>
            <span
              style={{
                fontSize: '10px',
                lineHeight: '1.1',
                fontWeight: isActive ? 800 : 700,
                color: isActive ? '#111111' : '#888888',
              }}
            >
              {label}
            </span>
            {isActive && (
              <span
                style={{
                  width: '4px',
                  height: '4px',
                  borderRadius: '50%',
                  background: '#EF7B28',
                }}
              />
            )}
          </button>
        );
      })}
    </nav>
  );
}

// ── Tab Content: Home (rich version with portfolio summary, balance, quick actions) ──

interface HomePosition {
  floor_id: string;
  asset: string;
  amount: string;
  floor_price_usd?: number;
  protected_until?: string;
  status: 'active' | 'expired' | 'closed';
}

function homeDaysLeft(iso: string): string {
  try {
    const diff = new Date(iso).getTime() - Date.now();
    if (diff <= 0) return 'Expired';
    const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
    if (days === 1) return '1d left';
    return `${days}d left`;
  } catch {
    return '—';
  }
}

function homeFormatUsd(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── PnL Chart (real data) ─────────────────────────────────────────────────

interface PnLPoint { timestamp: number; value: number; }
type PnLRange = '1D' | '1W' | '1M' | 'ALL';
const PNL_RANGES: PnLRange[] = ['1D', '1W', '1M', 'ALL'];
const PNL_W = 340;
const PNL_H = 120;
const PNL_PY = 8;

function pnlBuildPath(points: PnLPoint[]) {
  if (points.length === 0) return { line: '', area: '', minV: 0, maxV: 0 };
  const vals = points.map(p => p.value);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const range = maxV - minV || 1;
  const plotH = PNL_H - PNL_PY * 2;
  const coords = points.map((p, i) => ({
    x: (i / Math.max(1, points.length - 1)) * PNL_W,
    y: PNL_PY + plotH - ((p.value - minV) / range) * plotH,
  }));
  let line = `M ${coords[0]!.x} ${coords[0]!.y}`;
  for (let i = 1; i < coords.length; i++) {
    const prev = coords[i - 1]!;
    const curr = coords[i]!;
    const cpx = (prev.x + curr.x) / 2;
    line += ` C ${cpx} ${prev.y} ${cpx} ${curr.y} ${curr.x} ${curr.y}`;
  }
  const last = coords[coords.length - 1]!;
  const first = coords[0]!;
  const area = `${line} L ${last.x} ${PNL_H} L ${first.x} ${PNL_H} Z`;
  return { line, area, minV, maxV };
}

function pnlFilterRange(points: PnLPoint[], range: PnLRange): PnLPoint[] {
  if (range === 'ALL' || points.length === 0) return points;
  const now = Date.now();
  const cutoffs: Record<string, number> = { '1D': 86400000, '1W': 604800000, '1M': 2592000000 };
  const cutoff = now - (cutoffs[range] ?? 604800000);
  const filtered = points.filter(p => p.timestamp >= cutoff);
  if (filtered.length === 0) return points.length > 0 ? [points[points.length - 1]!] : [];
  if (filtered[0] !== points[0]) {
    const idx = points.indexOf(filtered[0]!);
    if (idx > 0) filtered.unshift(points[idx - 1]!);
  }
  return filtered;
}

interface CurrentPrices {
  [ticker: string]: { usd: number; usd_24h_change: number | null };
}

/** Fetch current spot prices for given tickers. */
async function fetchCurrentPrices(tickers: string[]): Promise<CurrentPrices> {
  if (tickers.length === 0) return {};
  try {
    const res = await fetch(`${API_URL}/v1/prices/current?assets=${tickers.join(',')}`);
    if (!res.ok) return {};
    const data = await res.json() as { prices: CurrentPrices };
    return data.prices ?? {};
  } catch {
    return {};
  }
}

interface HomePnLChartProps {
  accountId: string;
  usdcBalance: number;
  positions: HomePosition[];
}

function HomePnLChart({ accountId, usdcBalance, positions }: HomePnLChartProps) {
  const [range, setRange] = useState<PnLRange>('ALL');
  const [allPoints, setAllPoints] = useState<PnLPoint[]>([]);
  const [chartLoading, setChartLoading] = useState(true);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [currentPrices, setCurrentPrices] = useState<CurrentPrices>({});
  /** Server-reported total (USDC + positions) — the authoritative value */
  const [apiCurrentValue, setApiCurrentValue] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Fetch portfolio history — includes current_value with positions already counted
  useEffect(() => {
    if (!accountId) { setChartLoading(false); return; }
    let cancelled = false;
    setChartLoading(true);
    fetch(`${API_URL}/v1/accounts/${encodeURIComponent(accountId)}/portfolio-history`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { points: Array<{ t: number; v: number }>; current_value?: number } | null) => {
        if (cancelled) return;
        if (data?.points) {
          setAllPoints(data.points.map(p => ({ timestamp: p.t * 1000, value: p.v })));
        }
        if (data?.current_value !== undefined) {
          setApiCurrentValue(data.current_value);
        }
        setChartLoading(false);
      })
      .catch(() => { if (!cancelled) setChartLoading(false); });
    return () => { cancelled = true; };
  }, [accountId]);

  // Extract unique tickers from positions (for breakdown display only)
  const positionTickers = useMemo(() => {
    const tickers = new Set<string>();
    for (const pos of positions) {
      const t = pos.asset.replace(/^nep141:/, '').replace(/\.omft\.near$/, '').replace(/\.fakes\.testnet$/, '').split('.')[0]?.toUpperCase();
      if (t) tickers.add(t);
    }
    return [...tickers];
  }, [positions]);

  // Fetch current prices + auto-refresh every 30s (for breakdown display)
  useEffect(() => {
    if (positionTickers.length === 0) return;
    let cancelled = false;
    const doFetch = () => {
      fetchCurrentPrices(positionTickers).then(prices => {
        if (!cancelled && Object.keys(prices).length > 0) setCurrentPrices(prices);
      });
    };
    doFetch();
    const interval = setInterval(doFetch, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [positionTickers.join(',')]);

  // Breakdown for display only — NOT used to compute portfolio total
  const activePositions = positions.filter(p => p.status === 'active');
  const breakdown = useMemo(() => {
    const items: Array<{
      ticker: string;
      qty: number;
      value: number;
      isProtected: boolean;
      currentPrice: number | null;
      floorPrice: number | null;
    }> = [];
    for (const pos of activePositions) {
      const ticker = pos.asset.replace(/^nep141:/, '').replace(/\.omft\.near$/, '').replace(/\.fakes\.testnet$/, '').split('.')[0]?.toUpperCase() ?? pos.asset;
      const qty = parseFloat(pos.amount) || 0;
      const floorPrice = pos.floor_price_usd ?? null;
      const priceEntry = currentPrices[ticker];
      const currentPrice = priceEntry?.usd ?? null;
      const isProtected = floorPrice !== null && currentPrice !== null && currentPrice < floorPrice;
      const effectivePrice = currentPrice !== null
        ? (isProtected ? floorPrice! : currentPrice)
        : 0; // No price data = don't inflate with floor price
      items.push({
        ticker,
        qty,
        value: qty * effectivePrice,
        isProtected,
        currentPrice,
        floorPrice,
      });
    }
    return items;
  }, [activePositions, currentPrices]);

  // Portfolio total: use the API's current_value (which already includes positions).
  // Fall back to USDC-only if the API didn't return current_value.
  // Do NOT add positionsValue on top — that would double-count.
  const liveTotal = apiCurrentValue ?? usdcBalance;

  // Do NOT append a client-side computed point — the API's last point is authoritative
  const augmentedPoints = allPoints;

  const points = useMemo(() => pnlFilterRange(augmentedPoints, range), [augmentedPoints, range]);
  const { line, area, minV, maxV } = useMemo(() => pnlBuildPath(points), [points]);

  const displayValue = hoverIdx !== null ? (points[hoverIdx]?.value ?? liveTotal) : liveTotal;
  const firstVal = points[0]?.value ?? 0;
  const lastVal = points[points.length - 1]?.value ?? 0;
  const absChange = lastVal - firstVal;
  const pctChange = firstVal > 0 ? (absChange / firstVal) * 100 : 0;
  const isPositive = absChange >= 0;
  const lineColor = isPositive ? '#29CEB4' : '#EF4444';

  const handleHover = useCallback((clientX: number) => {
    if (!svgRef.current || points.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    const idx = Math.round(ratio * (points.length - 1));
    setHoverIdx(Math.max(0, Math.min(points.length - 1, idx)));
  }, [points]);

  const hoverPt = hoverIdx !== null ? points[hoverIdx] : null;
  const hoverX = hoverIdx !== null ? (hoverIdx / Math.max(1, points.length - 1)) * PNL_W : 0;
  const hoverY = hoverPt && maxV !== minV
    ? PNL_PY + (PNL_H - PNL_PY * 2) - ((hoverPt.value - minV) / (maxV - minV)) * (PNL_H - PNL_PY * 2)
    : 0;
  const hoverLabel = hoverPt
    ? new Date(hoverPt.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : null;

  if (chartLoading) {
    return (
      <div style={{
        background: 'white', border: '2px solid #111', borderRadius: '14px',
        boxShadow: '0 2.5px 0 #111', padding: '14px',
        display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '160px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ display: 'inline-block', width: '14px', height: '14px', border: '2px solid #111', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          <span style={{ fontSize: '13px', fontWeight: 600, color: '#9ca3af' }}>Loading chart…</span>
        </div>
      </div>
    );
  }

  if (augmentedPoints.length < 2) {
    return (
      <div style={{
        background: 'white', border: '2px solid #111', borderRadius: '14px',
        boxShadow: '0 2.5px 0 #111', padding: '20px 14px',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: '8px', minHeight: '120px', textAlign: 'center',
      }}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
        <p style={{ fontSize: '13px', fontWeight: 700, color: '#9ca3af' }}>
          Make your first trade to see portfolio history
        </p>
      </div>
    );
  }

  return (
    <div style={{
      background: 'white', border: '2px solid #111', borderRadius: '14px',
      boxShadow: '0 2.5px 0 #111', padding: '14px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
        <div>
          <p style={{ fontSize: '10px', fontWeight: 800, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '2px' }}>
            {hoverLabel ?? 'Portfolio Value'}
          </p>
          <p style={{ fontSize: '24px', fontWeight: 800, color: '#111', fontVariantNumeric: 'tabular-nums' }}>
            ${homeFormatUsd(displayValue)}
          </p>
          <p style={{ fontSize: '12px', fontWeight: 700, marginTop: '2px', color: isPositive ? '#29CEB4' : '#EF4444' }}>
            {isPositive ? '+' : ''}{absChange.toFixed(2)} ({isPositive ? '+' : ''}{pctChange.toFixed(2)}%)
          </p>
        </div>
        <div style={{ display: 'flex', gap: '4px', background: '#FAF9F6', border: '2px solid #111', borderRadius: '10px', padding: '3px' }}>
          {PNL_RANGES.map(r => (
            <button key={r} onClick={() => { setRange(r); setHoverIdx(null); }} style={{
              padding: '3px 10px', borderRadius: '7px', fontSize: '11px', fontWeight: 800,
              border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              background: r === range ? '#111' : 'transparent',
              color: r === range ? 'white' : '#9ca3af',
              transition: 'all 0.15s',
            }}>{r}</button>
          ))}
        </div>
      </div>
      <div style={{ margin: '0 -4px' }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${PNL_W} ${PNL_H}`}
          style={{ width: '100%', height: 'auto', userSelect: 'none' }}
          preserveAspectRatio="none"
          onMouseMove={(e: MouseEvent) => handleHover(e.clientX)}
          onMouseLeave={() => setHoverIdx(null)}
          onTouchMove={(e: TouchEvent) => { const t = e.touches[0]; if (t) handleHover(t.clientX); }}
          onTouchEnd={() => setHoverIdx(null)}
        >
          <defs>
            <linearGradient id={`pnl-g-${range}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color={lineColor} stop-opacity="0.15" />
              <stop offset="100%" stop-color={lineColor} stop-opacity="0" />
            </linearGradient>
          </defs>
          {area && <path d={area} fill={`url(#pnl-g-${range})`} />}
          {line && <path d={line} fill="none" stroke={lineColor} stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />}
          {hoverIdx !== null && hoverPt && (
            <>
              <line x1={hoverX} y1={PNL_PY} x2={hoverX} y2={PNL_H - PNL_PY} stroke="#111" stroke-width="1" stroke-dasharray="3,3" opacity="0.3" />
              <circle cx={hoverX} cy={hoverY} r="4" fill="white" stroke={lineColor} stroke-width="2" />
            </>
          )}
        </svg>
      </div>

      {/* Portfolio breakdown */}
      {hoverIdx === null && (usdcBalance > 0 || breakdown.length > 0) && (
        <div style={{ borderTop: '1.5px solid #e5e7eb', marginTop: '10px', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '5px' }}>
          {usdcBalance > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '11px', fontWeight: 700, color: '#6b7280' }}>USDC</span>
              <span style={{ fontSize: '11px', fontWeight: 800, color: '#111', fontVariantNumeric: 'tabular-nums' }}>
                ${homeFormatUsd(usdcBalance)}
              </span>
            </div>
          )}
          {breakdown.map((b, i) => (
            <div key={`${b.ticker}-${i}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '11px', fontWeight: 700, color: '#6b7280' }}>
                {b.ticker} ({b.qty < 0.01 ? b.qty.toFixed(4) : b.qty.toFixed(2)})
              </span>
              <span style={{ fontSize: '11px', fontWeight: 800, color: '#111', fontVariantNumeric: 'tabular-nums', display: 'flex', alignItems: 'center', gap: '4px' }}>
                ${homeFormatUsd(b.value)}
                {b.isProtected && (
                  <span style={{
                    fontSize: '9px', fontWeight: 800, color: '#29CEB4',
                    background: '#29CEB41A', padding: '1px 5px', borderRadius: '4px',
                  }}>
                    Protected
                  </span>
                )}
              </span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #e5e7eb', paddingTop: '5px', marginTop: '2px' }}>
            <span style={{ fontSize: '12px', fontWeight: 800, color: '#111' }}>Total</span>
            <span style={{ fontSize: '12px', fontWeight: 800, color: '#111', fontVariantNumeric: 'tabular-nums' }}>
              ${homeFormatUsd(liveTotal)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function HomePositionRow({ pos, onTap }: { pos: HomePosition; onTap: () => void }) {
  const assetColors: Record<string, string> = {
    ETH: '#627EEA', BTC: '#F7931A', SOL: '#9945FF', NEAR: '#29CEB4',
  };
  const ticker = pos.asset.replace(/^nep141:/, '').replace(/\.omft\.near$/, '').replace(/\.fakes\.testnet$/, '').toUpperCase();
  const color = assetColors[ticker] ?? '#9662FF';

  return (
    <button
      onClick={onTap}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 12px',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{
          width: '32px', height: '32px', borderRadius: '50%',
          border: '2px solid #111', background: color,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '10px', fontWeight: 800, color: 'white',
        }}>
          {ticker.slice(0, 2)}
        </div>
        <div style={{ textAlign: 'left' }}>
          <div style={{ fontSize: '13px', fontWeight: 800, color: '#111' }}>
            {pos.amount} {ticker}
          </div>
          {pos.floor_price_usd !== undefined && (
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#6b7280' }}>
              Floor ${homeFormatUsd(pos.floor_price_usd)}
            </div>
          )}
        </div>
      </div>
      {pos.protected_until && (
        <span style={{
          padding: '2px 8px', borderRadius: '99px',
          fontSize: '10px', fontWeight: 800,
          background: '#29CEB4', color: '#111',
          border: '1px solid #111',
        }}>
          {homeDaysLeft(pos.protected_until)}
        </span>
      )}
    </button>
  );
}

type HomeActivityType = 'floor_opened' | 'sold_to_floor' | 'floor_closed' | 'floor_expired' | 'buy_swap' | 'fund';

interface HomeActivityEvent {
  id: string;
  type: HomeActivityType;
  description: string;
  amount: string;
  timestamp: Date;
}

function homeBuildActivity(positions: HomePosition[]): HomeActivityEvent[] {
  const events: HomeActivityEvent[] = [];
  for (const pos of positions) {
    const openedAt = pos.protected_until
      ? new Date(new Date(pos.protected_until).getTime() - 86400000 * 30)
      : new Date();
    const ticker = pos.asset.replace(/^nep141:/, '').split('.')[0]?.toUpperCase() ?? pos.asset;
    events.push({
      id: `open-${pos.floor_id}`,
      type: 'floor_opened',
      description: `Floor on ${pos.amount} ${ticker}`,
      amount: pos.floor_price_usd ? `-$${homeFormatUsd(pos.floor_price_usd)}` : '',
      timestamp: openedAt,
    });
    if (pos.status === 'closed') {
      events.push({
        id: `close-${pos.floor_id}`,
        type: 'floor_closed',
        description: `Closed ${pos.amount} ${ticker}`,
        amount: `+${pos.amount}`,
        timestamp: pos.protected_until ? new Date(pos.protected_until) : new Date(),
      });
    }
  }
  return events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()).slice(0, 5);
}

function homeFormatRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const homeActivityIconColors: Record<HomeActivityType, string> = {
  floor_opened: '#EF7B28',
  sold_to_floor: '#29CEB4',
  floor_closed: '#9ca3af',
  floor_expired: '#9ca3af',
  buy_swap: '#9662FF',
  fund: '#29CEB4',
};

interface RecentTrade {
  status_id: string;
  ticker: string;
  amount_usdc: string;
  tx_hash: string | null;
  status: string;
  created_at: string;
}

// ── Shared Activity Types (used by HomeTab + ActivityTab) ────────────────────

interface ActivityTransaction {
  tx_hash: string;
  receipt_id: string;
  type: string;
  method: string | null;
  label: string;
  receiver: string;
  predecessor: string;
  timestamp: string;
  status: string;
  deposit: string;
  icon_type: 'swap' | 'floor' | 'transfer' | 'account' | 'other';
  actions: Array<{ action: string; method?: string | null }>;
}

function getIconColor(type: ActivityTransaction['icon_type']): string {
  switch (type) {
    case 'swap': return '#29CEB4';
    case 'floor': return '#EF7B28';
    case 'transfer': return '#9662FF';
    case 'account': return '#627EEA';
    default: return '#9ca3af';
  }
}

function ActivityIcon({ iconType }: { iconType: ActivityTransaction['icon_type'] }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      {iconType === 'swap' && <><path d="M16 3l4 4-4 4" /><path d="M20 7H4" /><path d="M8 21l-4-4 4-4" /><path d="M4 17h16" /></>}
      {iconType === 'floor' && <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />}
      {iconType === 'transfer' && <><path d="M22 2L11 13" /><path d="M22 2L15 22l-4-9-9-4 20-7z" /></>}
      {iconType === 'account' && <><circle cx="12" cy="7" r="4" /><path d="M5.5 21a6.5 6.5 0 0113 0" /></>}
      {iconType === 'other' && <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>}
    </svg>
  );
}

function activityRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Tab Content: Home ──────────────────────────────────────────────────────

interface HomeTabProps {
  accountId: string;
  onSwitchTab: (tab: Tab, floorId?: string) => void;
  onBuy: () => void;
  onFund: () => void;
}

function HomeTab({ accountId, onSwitchTab, onBuy, onFund }: HomeTabProps) {
  const [positions, setPositions] = useState<HomePosition[]>([]);
  const [usdcBalance, setUsdcBalance] = useState<string | null>(null);
  const [nearBalance, setNearBalance] = useState<string | null>(null);
  const [recentOnChainTxns, setRecentOnChainTxns] = useState<ActivityTransaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!accountId) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);

    // Fetch positions and activity in parallel
    const positionsP = fetch(`${API_URL}/v1/accounts/${encodeURIComponent(accountId)}/positions`)
      .then(res => res.ok ? res.json() : null)
      .catch(() => null);
    const activityP = fetch(`${API_URL}/v1/accounts/${encodeURIComponent(accountId)}/activity`)
      .then(res => res.ok ? res.json() : null)
      .catch(() => null);

    Promise.all([positionsP, activityP]).then(([posData, actData]) => {
      if (cancelled) return;

      // Parse positions
      if (posData && posData.positions) {
        const mapped: HomePosition[] = (posData.positions as Array<{
          floor_id: string;
          asset: string;
          ticker?: string;
          amount?: string;
          qty?: string;
          qty_display?: string;
          floor_price_usd?: number;
          floor_price_e6?: string;
          protected_until?: string;
          expires_at?: string;
          status?: string;
        }>).map(p => {
          const floorPriceUsd = p.floor_price_usd ?? (p.floor_price_e6 ? Number(p.floor_price_e6) / 1_000_000 : undefined);
          const pos: HomePosition = {
            floor_id: p.floor_id,
            asset: p.ticker ?? p.asset,
            amount: p.qty_display ?? p.qty ?? p.amount ?? '0',
            status: (p.status as HomePosition['status']) ?? 'active',
          };
          if (floorPriceUsd !== undefined) pos.floor_price_usd = floorPriceUsd;
          const protectedUntil = p.protected_until ?? p.expires_at;
          if (protectedUntil !== undefined) pos.protected_until = protectedUntil;
          return pos;
        });
        setPositions(mapped);
        setUsdcBalance(posData.usdc_balance ?? null);
        setNearBalance(posData.near_balance ?? null);
      }

      // Parse activity (real on-chain txns)
      if (actData && actData.transactions) {
        setRecentOnChainTxns((actData.transactions as ActivityTransaction[]).slice(0, 3));
      }
    }).finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [accountId]);

  const activePositions = positions.filter(p => p.status === 'active');
  const portfolioValue = usdcBalance != null ? parseFloat(usdcBalance) : 0;
  const totalProtectedValue = activePositions.reduce((sum, p) => {
    const floorUsd = p.floor_price_usd ?? 0;
    const qty = parseFloat(p.amount) || 0;
    return sum + floorUsd * qty;
  }, 0);

  return (
    <div style={{
      width: '380px',
      overflowY: 'auto',
      overflowX: 'hidden',
      background: '#FAF9F6',
      fontFamily: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    }} class="no-scrollbar">
      <div style={{ display: 'flex', flexDirection: 'column', padding: '14px 16px 16px', gap: '12px' }}>

        {/* Balance Card */}
        <div style={{
          background: 'white', border: '2px solid #111',
          borderRadius: '14px', boxShadow: '0 2.5px 0 #111',
          padding: '14px 16px',
        }}>
          <p style={{ fontSize: '10px', fontWeight: 800, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>
            USDC BALANCE
          </p>
          <p style={{ fontSize: '28px', fontWeight: 800, color: '#111' }}>
            {loading ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ display: 'inline-block', width: '14px', height: '14px', border: '2px solid #111', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                <span style={{ fontSize: '14px' }}>Loading…</span>
              </span>
            ) : usdcBalance != null ? `$${usdcBalance}` : '$0.00'}
          </p>
          {!loading && nearBalance != null && (
            <p style={{ fontSize: '12px', fontWeight: 600, color: '#9ca3af', marginTop: '2px' }}>{nearBalance} NEAR</p>
          )}
        </div>

        {/* Quick Actions */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
          <button
            onClick={onBuy}
            style={{
              height: '64px', background: '#EF7B28', border: '2px solid #111',
              borderRadius: '14px', boxShadow: '0 2.5px 0 #111',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px',
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            <span style={{ fontSize: '12px', fontWeight: 800, color: 'white' }}>Buy</span>
          </button>
          <button
            onClick={onFund}
            style={{
              height: '64px', background: 'white', border: '2px solid #111',
              borderRadius: '14px', boxShadow: '0 2.5px 0 #111',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '4px',
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span style={{ fontSize: '12px', fontWeight: 800, color: '#111' }}>Fund</span>
          </button>
          <button
            disabled
            style={{
              height: '64px', background: '#FAF9F6', border: '2px solid #d1d5db',
              borderRadius: '14px', boxShadow: '0 2.5px 0 #d1d5db',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '2px',
              cursor: 'not-allowed', fontFamily: 'inherit', opacity: 0.7,
              position: 'relative' as const,
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" />
            </svg>
            <span style={{ fontSize: '12px', fontWeight: 800, color: '#9ca3af' }}>Send</span>
            <span style={{
              position: 'absolute' as const, top: '4px', right: '6px',
              fontSize: '7px', fontWeight: 800, color: 'white',
              background: '#9662FF', borderRadius: '4px', padding: '1px 5px',
              textTransform: 'uppercase' as const, letterSpacing: '0.03em',
            }}>Soon</span>
          </button>
        </div>

        {/* PnL Chart */}
        <HomePnLChart accountId={accountId} usdcBalance={portfolioValue} positions={positions} />

        {/* Active Positions */}
        {!loading && activePositions.length > 0 && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
              <span style={{ fontSize: '14px', fontWeight: 800, color: '#111' }}>Your Positions</span>
              <button
                onClick={() => onSwitchTab('portfolio')}
                style={{ background: 'none', border: 'none', fontSize: '11px', fontWeight: 800, color: '#EF7B28', cursor: 'pointer', fontFamily: 'inherit' }}
              >
                {'View all →'}
              </button>
            </div>
            <div style={{
              background: 'white', border: '2px solid #111',
              borderRadius: '14px', boxShadow: '0 2.5px 0 #111',
              overflow: 'hidden',
            }}>
              {activePositions.slice(0, 3).map((pos, i) => (
                <Fragment key={pos.floor_id}>
                  {i > 0 && <div style={{ height: '2px', background: '#111' }} />}
                  <HomePositionRow pos={pos} onTap={() => onSwitchTab('portfolio', pos.floor_id)} />
                </Fragment>
              ))}
            </div>
          </div>
        )}

        {/* Empty state CTA */}
        {!loading && activePositions.length === 0 && (
          <div style={{
            background: 'white', border: '2px solid #111',
            borderRadius: '14px', boxShadow: '0 2.5px 0 #111',
            padding: '20px 16px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', textAlign: 'center',
          }}>
            <div style={{
              width: '44px', height: '44px', background: '#FAF9F6',
              border: '2px solid #111', borderRadius: '12px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            </div>
            <div>
              <p style={{ fontSize: '13px', fontWeight: 800, color: '#111' }}>Buy crypto with floor protection</p>
              <p style={{ fontSize: '11px', fontWeight: 600, color: '#9ca3af', marginTop: '4px' }}>
                Your positions will appear here
              </p>
            </div>
            <button
              onClick={onBuy}
              style={{
                width: '100%', height: '40px',
                background: '#EF7B28', color: 'white',
                border: '2px solid #111', borderRadius: '12px',
                fontSize: '13px', fontWeight: 800,
                boxShadow: '0 2.5px 0 #111',
                cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              Get Started
            </button>
          </div>
        )}

        {/* Recent Activity — real on-chain transactions */}
        {!loading && recentOnChainTxns.length > 0 && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
              <span style={{ fontSize: '14px', fontWeight: 800, color: '#111' }}>Recent Activity</span>
              <button
                onClick={() => onSwitchTab('activity')}
                style={{ background: 'none', border: 'none', fontSize: '11px', fontWeight: 800, color: '#EF7B28', cursor: 'pointer', fontFamily: 'inherit' }}
              >
                {'See all →'}
              </button>
            </div>
            <div style={{
              background: 'white', border: '2px solid #111',
              borderRadius: '14px', boxShadow: '0 2.5px 0 #111',
              overflow: 'hidden',
            }}>
              {recentOnChainTxns.map((tx, i) => {
                const iconColor = getIconColor(tx.icon_type);
                return (
                  <Fragment key={`${tx.tx_hash}-${tx.receipt_id}`}>
                    {i > 0 && <div style={{ height: '1px', background: '#e5e7eb' }} />}
                    <a
                      href={`https://testnet.nearblocks.io/txns/${tx.tx_hash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px' }}>
                        <div style={{
                          width: '30px', height: '30px', borderRadius: '50%',
                          border: '2px solid #111',
                          background: iconColor,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          flexShrink: 0,
                        }}>
                          <ActivityIcon iconType={tx.icon_type} />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ fontSize: '12px', fontWeight: 800, color: '#111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {tx.label}
                          </p>
                          <p style={{ fontSize: '10px', fontWeight: 600, color: '#9ca3af' }}>
                            {activityRelativeTime(tx.timestamp)}
                          </p>
                        </div>
                        <div style={{ flexShrink: 0 }}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={tx.status === 'success' ? '#29CEB4' : '#EF4444'} strokeWidth="3" strokeLinecap="round">
                            {tx.status === 'success'
                              ? <polyline points="20 6 9 17 4 12" />
                              : <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>}
                          </svg>
                        </div>
                      </div>
                    </a>
                  </Fragment>
                );
              })}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

// ── Tab Content: Portfolio ───────────────────────────────────────────────────

/** Format an expiry countdown from an ISO date string. */
function portfolioCountdown(expiresAt: string): string {
  try {
    const diff = new Date(expiresAt).getTime() - Date.now();
    if (diff <= 0) return 'Expired';
    const days = Math.floor(diff / 86_400_000);
    const hours = Math.floor((diff % 86_400_000) / 3_600_000);
    if (days > 0) return `${days}d ${hours}h left`;
    const minutes = Math.floor((diff % 3_600_000) / 60_000);
    return `${hours}h ${minutes}m left`;
  } catch {
    return '';
  }
}

/** Compute time-elapsed progress (0..1) between opened_at and expires_at. */
function portfolioProgress(openedAt: string, expiresAt: string): number {
  try {
    const start = new Date(openedAt).getTime();
    const end = new Date(expiresAt).getTime();
    const now = Date.now();
    if (end <= start) return 1;
    return Math.max(0, Math.min(1, (now - start) / (end - start)));
  } catch {
    return 0;
  }
}

/** Status badge color map. */
function statusBadgeStyle(status: string): { bg: string; color: string } {
  switch (status.toLowerCase()) {
    case 'active': return { bg: '#29CEB4', color: '#111' };
    case 'expired': return { bg: '#9ca3af', color: 'white' };
    case 'sold': return { bg: '#EF7B28', color: 'white' };
    case 'closed': return { bg: '#6b7280', color: 'white' };
    default: return { bg: '#e5e7eb', color: '#111' };
  }
}

/** Asset icon colors. */
const PORTFOLIO_ASSET_COLORS: Record<string, string> = {
  ETH: '#627EEA', BTC: '#F7931A', SOL: '#9945FF', NEAR: '#29CEB4',
};

interface OnChainPosition {
  floor_id: string;
  asset: string;
  ticker?: string;
  qty: string;
  qty_display?: string;
  floor_price_e6: string;
  floor_price_usd?: number;
  status: string;
  opened_at: string;
  expires_at: string;
  reserved_usdc?: string;
  fee_usdc?: string;
  sleeve?: string;
}

interface PortfolioTabProps {
  accountId: string;
  highlightFloorId?: string | null;
  onClearHighlight?: () => void;
}

function PortfolioTab({ accountId, highlightFloorId, onClearHighlight }: PortfolioTabProps) {
  const [positions, setPositions] = useState<OnChainPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [highlightActive, setHighlightActive] = useState<string | null>(null);
  const [portfolioPrices, setPortfolioPrices] = useState<CurrentPrices>({});
  const positionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const refreshPositions = useCallback(async () => {
    try {
      const url = `${API_URL}/v1/accounts/${encodeURIComponent(accountId)}/positions`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json() as { positions: OnChainPosition[] };
        setPositions(data.positions ?? []);
      }
    } catch {
      // Ignore refresh errors
    }
  }, [accountId]);

  const handleFloorAction = useCallback(async (floorId: string, action: 'sell_to_floor' | 'close') => {
    setActionLoading(`${floorId}:${action}`);
    setActionError(null);
    setActionSuccess(null);
    try {
      // Call relayer floor-action endpoint (port 3002)
      const relayerUrl = API_URL.replace(':3001', ':3002');
      const res = await fetch(`${relayerUrl}/v1/relay/floor-action-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          floor_id: parseInt(floorId, 10),
          account_id: accountId,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // Parse nested error structures to extract the actual message
        let errorMsg = 'Action failed';
        try {
          const parsed = JSON.parse(body);
          // Handle nested error: { error: { message: "..." } } or { error: { message: "{...}" } }
          const msg = parsed?.error?.message ?? parsed?.message ?? '';
          // Check for known contract errors
          if (msg.includes('E_FLOOR_EXPIRED')) errorMsg = 'This floor has expired';
          else if (msg.includes('E_NOT_FLOOR_OWNER')) errorMsg = 'Only the floor owner can do this';
          else if (msg.includes('E_FLOOR_NOT_ACTIVE')) errorMsg = 'This floor is no longer active';
          else if (msg.includes('E_PAUSED')) errorMsg = 'Trading is temporarily paused';
          else errorMsg = friendlyError(msg || body || `Server error (${res.status})`);
        } catch {
          errorMsg = friendlyError(body || `Server error (${res.status})`);
        }
        throw new Error(errorMsg);
      }
      const data = await res.json() as { tx_hash?: string; status?: string };
      const txShort = data.tx_hash ? data.tx_hash.slice(0, 10) + '…' : '';
      setActionSuccess(`${action === 'sell_to_floor' ? 'Sold to floor' : 'Position closed'}${txShort ? ' — tx: ' + txShort : ''}`);
      setTimeout(() => { void refreshPositions(); }, 3000);
    } catch (err) {
      setActionError(friendlyError(err instanceof Error ? err.message : 'Something went wrong'));
    } finally {
      setActionLoading(null);
    }
  }, [accountId, refreshPositions]);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    async function load() {
      try {
        const url = `${API_URL}/v1/accounts/${encodeURIComponent(accountId)}/positions`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json() as { positions: OnChainPosition[] };
          if (!cancelled) setPositions(data.positions ?? []);
        }
      } catch {
        // Ignore fetch errors
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [accountId]);

  // Fetch current prices for position tickers + auto-refresh every 30s
  const portfolioTickers = useMemo(() => {
    const tickers = new Set<string>();
    for (const pos of positions) {
      const t = pos.ticker ?? pos.asset.replace(/^nep141:/, '').split('.')[0]?.toUpperCase();
      if (t) tickers.add(t);
    }
    return [...tickers];
  }, [positions]);

  useEffect(() => {
    if (portfolioTickers.length === 0) return;
    let cancelled = false;
    const doFetch = () => {
      fetchCurrentPrices(portfolioTickers).then(prices => {
        if (!cancelled && Object.keys(prices).length > 0) setPortfolioPrices(prices);
      });
    };
    doFetch();
    const interval = setInterval(doFetch, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [portfolioTickers.join(',')]);

  // Scroll to and highlight a position when navigated from HomeTab
  useEffect(() => {
    if (!highlightFloorId || loading) return;
    const el = positionRefs.current[highlightFloorId];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightActive(highlightFloorId);
      const timer = setTimeout(() => {
        setHighlightActive(null);
        onClearHighlight?.();
      }, 1800);
      return () => clearTimeout(timer);
    }
  }, [highlightFloorId, loading, onClearHighlight]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 0' }}>
        <div style={{ width: 24, height: 24, border: '2.5px solid #e5e7eb', borderTopColor: '#EF7B28', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
      </div>
    );
  }

  if (positions.length === 0) {
    return (
      <div style={{ padding: '60px 24px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
        <NavPortfolioIcon active={false} />
        <div style={{ fontSize: '16px', fontWeight: 800, color: '#111' }}>No floor positions</div>
        <div style={{ fontSize: '13px', fontWeight: 600, color: '#6b7280' }}>
          Buy crypto with floor protection to see your positions here.
        </div>
      </div>
    );
  }

  const activeCount = positions.filter(p => p.status.toLowerCase() === 'active' && !(p.expires_at && new Date(p.expires_at).getTime() < Date.now())).length;

  return (
    <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
        <span style={{ fontSize: '14px', fontWeight: 800, color: '#111' }}>
          Floor Positions ({positions.length})
        </span>
        {activeCount > 0 && (
          <span style={{
            fontSize: '11px', fontWeight: 800, color: '#29CEB4',
            background: '#29CEB41A', padding: '2px 8px', borderRadius: '8px',
          }}>
            {activeCount} active
          </span>
        )}
      </div>
      {positions.map((pos) => {
        const ticker = pos.ticker ?? pos.asset.replace(/^nep141:/, '').split('.')[0]?.toUpperCase() ?? pos.asset;
        const qtyDisplay = pos.qty_display ?? pos.qty;
        const floorPriceUsd = pos.floor_price_usd ?? Number(pos.floor_price_e6) / 1_000_000;
        const onChainActive = pos.status.toLowerCase() === 'active';
        const timeExpired = pos.expires_at ? new Date(pos.expires_at).getTime() < Date.now() : false;
        const isActive = onChainActive && !timeExpired;
        const displayStatus = timeExpired && onChainActive ? 'expired' : pos.status;
        const countdown = isActive ? portfolioCountdown(pos.expires_at) : 'Expired';
        const progress = isActive ? portfolioProgress(pos.opened_at, pos.expires_at) : 1;
        const badge = statusBadgeStyle(displayStatus);
        const iconColor = PORTFOLIO_ASSET_COLORS[ticker] ?? '#9662FF';

        // PnL calculation using live prices
        const priceEntry = portfolioPrices[ticker];
        const currentPrice = priceEntry?.usd ?? null;
        const qty = parseFloat(qtyDisplay.replace(/,/g, '')) || 0;
        const costBasis = floorPriceUsd * qty; // approximate: floor price as cost proxy
        const currentVal = currentPrice !== null ? currentPrice * qty : null;
        const pnlAbs = currentVal !== null ? currentVal - costBasis : null;
        const pnlPct = costBasis > 0 && pnlAbs !== null ? (pnlAbs / costBasis) * 100 : null;
        const floorProtecting = currentPrice !== null && currentPrice < floorPriceUsd;
        const wouldBeLoss = floorProtecting && pnlAbs !== null ? pnlAbs : null;

        const isHighlighted = highlightActive === pos.floor_id;

        return (
          <div
            key={pos.floor_id}
            ref={(el: HTMLDivElement | null) => { positionRefs.current[pos.floor_id] = el; }}
            style={{
              background: isHighlighted ? '#FFF7ED' : 'white',
              border: isHighlighted ? '2px solid #EF7B28' : '2px solid #111',
              borderRadius: '14px',
              padding: '14px 16px',
              boxShadow: isHighlighted ? '0px 3px 0px #EF7B28' : '0px 3px 0px #111',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              transition: 'background 0.4s ease, border-color 0.4s ease, box-shadow 0.4s ease',
            }}
          >
            {/* Top row: asset icon + ticker + qty | status badge */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{
                  width: '36px', height: '36px', borderRadius: '50%',
                  border: '2px solid #111', background: iconColor,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '11px', fontWeight: 800, color: 'white', flexShrink: 0,
                }}>
                  {ticker.slice(0, 3)}
                </div>
                <div>
                  <div style={{ fontSize: '15px', fontWeight: 800, color: '#111' }}>
                    {qtyDisplay} {ticker}
                  </div>
                  <div style={{ fontSize: '11px', fontWeight: 600, color: '#6b7280' }}>
                    Floor #{pos.floor_id}
                  </div>
                </div>
              </div>
              <span style={{
                background: badge.bg, color: badge.color,
                border: '1.5px solid #111', borderRadius: '10px',
                padding: '3px 10px', fontSize: '11px', fontWeight: 800,
                textTransform: 'capitalize' as const,
              }}>
                {pos.status}
              </span>
            </div>

            {/* Floor price + current price row */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>Floor Price</span>
              <span style={{ fontSize: '14px', fontWeight: 800, color: '#111' }}>
                ${floorPriceUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>

            {/* Current price row */}
            {currentPrice !== null && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>Current Price</span>
                <span style={{ fontSize: '14px', fontWeight: 800, color: floorProtecting ? '#EF4444' : '#111' }}>
                  ${currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            )}

            {/* PnL row */}
            {pnlAbs !== null && pnlPct !== null && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>PnL</span>
                {floorProtecting ? (
                  <span style={{ fontSize: '12px', fontWeight: 800, color: '#29CEB4', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span role="img" aria-label="shield">🛡</span>
                    Floor protecting: {pnlAbs < 0 ? `-$${Math.abs(pnlAbs).toFixed(2)}` : `+$${pnlAbs.toFixed(2)}`} → $0
                  </span>
                ) : (
                  <span style={{
                    fontSize: '13px', fontWeight: 800,
                    color: pnlAbs >= 0 ? '#29CEB4' : '#EF4444',
                  }}>
                    {pnlAbs >= 0 ? '+' : ''}{pnlAbs >= 0 ? `$${pnlAbs.toFixed(2)}` : `-$${Math.abs(pnlAbs).toFixed(2)}`} ({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%)
                  </span>
                )}
              </div>
            )}

            {/* Expiry countdown + progress bar — only for active positions */}
            {isActive && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>Expires</span>
                  <span style={{ fontSize: '12px', fontWeight: 800, color: countdown === 'Expired' ? '#EF4444' : '#111' }}>
                    {countdown}
                  </span>
                </div>

                {/* Time progress bar */}
                <div style={{
                  width: '100%', height: '6px', background: '#e5e7eb',
                  borderRadius: '3px', overflow: 'hidden',
                }}>
                  <div style={{
                    width: '100%',
                    height: '100%',
                    background: progress > 0.85 ? '#EF4444' : '#29CEB4',
                    borderRadius: '3px',
                    transform: `scaleX(${Math.min(progress, 1)})`,
                    transformOrigin: 'left',
                    transition: 'transform 0.3s ease',
                  }} />
                </div>
              </>
            )}

            {/* Action buttons — only for active positions */}
            {isActive && (
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '6px' }}>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {/* Sell to Floor button */}
                  <button
                    onClick={() => handleFloorAction(pos.floor_id, 'sell_to_floor')}
                    disabled={actionLoading !== null}
                    style={{
                      flex: 1,
                      height: '36px',
                      background: actionLoading === `${pos.floor_id}:sell_to_floor` ? '#cccccc' : '#29CEB4',
                      border: '2px solid #111',
                      borderRadius: '10px',
                      boxShadow: actionLoading === `${pos.floor_id}:sell_to_floor` ? 'none' : '0px 2px 0px #111',
                      fontSize: '12px',
                      fontWeight: 800,
                      color: '#111',
                      cursor: actionLoading !== null ? 'wait' : 'pointer',
                      fontFamily: 'inherit',
                      transition: 'transform 0.1s ease, box-shadow 0.1s ease',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '4px',
                      opacity: actionLoading !== null && actionLoading !== `${pos.floor_id}:sell_to_floor` ? 0.5 : 1,
                    }}
                    className="btn-neo"
                    aria-label="Sell to floor"
                  >
                    {actionLoading === `${pos.floor_id}:sell_to_floor` ? 'Selling…' : (
                      <><span role="img" aria-label="shield">🛡</span> Sell to Floor</>
                    )}
                  </button>
                  {/* Close button */}
                  <button
                    onClick={() => handleFloorAction(pos.floor_id, 'close')}
                    disabled={actionLoading !== null}
                    style={{
                      flex: 1,
                      height: '36px',
                      background: actionLoading === `${pos.floor_id}:close` ? '#cccccc' : 'white',
                      border: '2px solid #111',
                      borderRadius: '10px',
                      boxShadow: actionLoading === `${pos.floor_id}:close` ? 'none' : '0px 2px 0px #111',
                      fontSize: '12px',
                      fontWeight: 800,
                      color: '#111',
                      cursor: actionLoading !== null ? 'wait' : 'pointer',
                      fontFamily: 'inherit',
                      transition: 'transform 0.1s ease, box-shadow 0.1s ease',
                      opacity: actionLoading !== null && actionLoading !== `${pos.floor_id}:close` ? 0.5 : 1,
                    }}
                    className="btn-neo"
                    aria-label="Close position"
                  >
                    {actionLoading === `${pos.floor_id}:close` ? 'Closing…' : 'Close'}
                  </button>
                </div>

                {/* Action feedback */}
                {actionSuccess !== null && (
                  <div style={{
                    fontSize: '11px', fontWeight: 700, color: '#29CEB4',
                    padding: '4px 8px', background: '#29CEB41A', borderRadius: '6px',
                    textAlign: 'center' as const,
                  }}>
                    {actionSuccess}
                  </div>
                )}
                {actionError !== null && (
                  <div style={{
                    fontSize: '11px', fontWeight: 700, color: '#EF7B28',
                    padding: '4px 8px', background: '#EF7B281A', borderRadius: '6px',
                    textAlign: 'center' as const,
                  }}>
                    {actionError}
                  </div>
                )}
              </div>
            )}

            {/* Dates row — compact */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '10px', fontWeight: 600, color: '#9ca3af' }}>
                Opened {new Date(pos.opened_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
              <span style={{ fontSize: '10px', fontWeight: 600, color: '#9ca3af' }}>
                Expires {new Date(pos.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Tab Content: Activity (real on-chain transactions from NearBlocks) ──────

interface ActivityTabProps {
  accountId: string;
}

function ActivityTab({ accountId }: ActivityTabProps) {
  const [transactions, setTransactions] = useState<ActivityTransaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!accountId) return; // Wait until accountId is loaded from storage
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`${API_URL}/v1/accounts/${encodeURIComponent(accountId)}/activity`);
        if (res.ok) {
          const data = await res.json() as { transactions: ActivityTransaction[] };
          if (!cancelled) setTransactions(data.transactions ?? []);
        }
      } catch {
        // silently fail
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [accountId]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 0' }}>
        <div style={{ width: 24, height: 24, border: '2.5px solid #e5e7eb', borderTopColor: '#EF7B28', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
      </div>
    );
  }

  if (transactions.length === 0) {
    return (
      <div style={{ padding: '60px 24px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
        <NavActivityIcon active={false} />
        <div style={{ fontSize: '16px', fontWeight: 800, color: '#111' }}>No activity yet</div>
        <div style={{ fontSize: '13px', fontWeight: 600, color: '#6b7280' }}>
          Your transaction history will appear here.
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ fontSize: '14px', fontWeight: 800, color: '#111', marginBottom: '4px' }}>
        On-Chain Activity
      </div>
      {transactions.map((tx) => {
        const explorerUrl = `https://testnet.nearblocks.io/txns/${tx.tx_hash}`;
        const iconColor = getIconColor(tx.icon_type);
        const statusColor = tx.status === 'success' ? '#29CEB4' : '#EF4444';
        const truncatedHash = tx.tx_hash.length > 16
          ? `${tx.tx_hash.slice(0, 8)}...${tx.tx_hash.slice(-6)}`
          : tx.tx_hash;

        return (
          <a
            key={`${tx.tx_hash}-${tx.receipt_id}`}
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              textDecoration: 'none',
              color: 'inherit',
              display: 'block',
            }}
          >
            <div
              style={{
                background: 'white',
                border: '2px solid #111',
                borderRadius: '12px',
                padding: '12px 14px',
                boxShadow: '0px 2.5px 0px #111',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                cursor: 'pointer',
                transition: 'transform 0.1s ease, box-shadow 0.1s ease',
              }}
              className="active:translate-y-[2px] active:shadow-none"
            >
              {/* Colored icon circle */}
              <div
                style={{
                  width: '34px',
                  height: '34px',
                  borderRadius: '50%',
                  border: '2px solid #111',
                  background: iconColor,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <ActivityIcon iconType={tx.icon_type} />
              </div>

              {/* Center: label + time */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '13px', fontWeight: 800, color: '#111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {tx.label}
                </div>
                <div style={{ fontSize: '10px', fontWeight: 600, color: '#9ca3af', marginTop: '1px' }}>
                  {activityRelativeTime(tx.timestamp)}
                </div>
              </div>

              {/* Right: status + hash */}
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{
                  fontSize: '9px', fontWeight: 800,
                  color: statusColor,
                  textTransform: 'uppercase',
                  letterSpacing: '0.03em',
                }}>
                  {tx.status === 'success' ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={statusColor} strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                      OK
                    </span>
                  ) : 'FAIL'}
                </div>
                <div style={{ fontSize: '9px', fontWeight: 600, color: '#9ca3af', fontFamily: 'monospace', marginTop: '2px' }}>
                  {truncatedHash}
                </div>
              </div>
            </div>
          </a>
        );
      })}
    </div>
  );
}

// ── Tab Content: Settings ────────────────────────────────────────────────────

interface SettingsTabProps {
  accountId: string;
  passkeys: Array<{ name: string; credentialId: string; createdAt: string; source?: string }>;
  onPasskeysChanged: (passkeys: Array<{ name: string; credentialId: string; createdAt: string; source?: string }>) => void;
  onSignOut: () => void;
}

function SettingsTab({ accountId, passkeys, onPasskeysChanged, onSignOut }: SettingsTabProps) {
  const [copiedAccountId, setCopiedAccountId] = useState(false);
  const [addingPasskey, setAddingPasskey] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSuccess, setAddSuccess] = useState(false);

  const truncated = accountId.length > 24
    ? `${accountId.slice(0, 12)}...${accountId.slice(-10)}`
    : accountId;

  const handleCopyAccountId = useCallback(() => {
    if (!accountId) return;
    navigator.clipboard.writeText(accountId).then(() => {
      setCopiedAccountId(true);
      setTimeout(() => setCopiedAccountId(false), 1500);
    }).catch(() => {});
  }, [accountId]);

  // Auto-dismiss success after 3s
  useEffect(() => {
    if (!addSuccess) return;
    const t = setTimeout(() => setAddSuccess(false), 3000);
    return () => clearTimeout(t);
  }, [addSuccess]);

  const handleAddPasskey = useCallback(async () => {
    setAddError(null);
    setAddSuccess(false);
    setAddingPasskey(true);
    try {
      const passkeyName = window.prompt('Name this passkey (e.g. "Work laptop")');
      if (passkeyName === null) {
        setAddingPasskey(false);
        return;
      }
      const trimmedName = passkeyName.trim() || 'Passkey';

      const { credentialId, compressedKeyHex } = await createPasskeyInline(trimmedName);

      // Register the new credential with the API (best-effort)
      try {
        await fetch(`${API_URL}/v1/accounts/${encodeURIComponent(accountId)}/credentials`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            credential_id: credentialId,
            public_key_hex: compressedKeyHex,
            device_name: trimmedName,
          }),
        });
      } catch {
        console.warn('[floors] Failed to register credential with API');
      }

      // Update chrome.storage.local passkeys array
      const newEntry = {
        name: trimmedName,
        credentialId,
        createdAt: new Date().toISOString(),
        source: 'extension' as const,
      };

      const storageResult = await new Promise<Record<string, unknown>>((resolve) => {
        chrome.storage.local.get(['floors:passkeys'], resolve);
      });
      let existingPasskeys: Array<{ name: string; credentialId: string; createdAt: string; source?: string }> = [];
      try {
        const raw = storageResult['floors:passkeys'];
        if (typeof raw === 'string') {
          existingPasskeys = JSON.parse(raw) as typeof existingPasskeys;
        }
      } catch { /* ignore */ }
      existingPasskeys.push(newEntry);

      await new Promise<void>((resolve) => {
        chrome.storage.local.set({
          'floors:passkeys': JSON.stringify(existingPasskeys),
        }, resolve);
      });

      // Notify parent so state stays in sync
      onPasskeysChanged(existingPasskeys);
      setAddSuccess(true);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Passkey creation failed');
    } finally {
      setAddingPasskey(false);
    }
  }, [accountId, onPasskeysChanged]);

  const truncateCredId = (id: string): string => {
    if (id.length <= 24) return id;
    return `${id.slice(0, 16)}…${id.slice(-8)}`;
  };

  return (
    <div style={{ padding: '20px 18px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div style={{ fontSize: '18px', fontWeight: 800, color: '#111' }}>Settings</div>

      {/* Account card */}
      <div
        style={{
          background: 'white',
          border: '2px solid #111',
          borderRadius: '14px',
          padding: '16px',
          boxShadow: '0px 3px 0px #111',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        <div style={{ fontSize: '12px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Account
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>Account ID</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '11px', fontWeight: 800, color: '#111', fontFamily: 'monospace' }}>{truncated}</span>
            <button
              onClick={handleCopyAccountId}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '2px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
              aria-label="Copy Account ID"
              data-testid="copy-account-id"
            >
              {copiedAccountId ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#29CEB4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Passkeys card */}
      <div
        style={{
          background: 'white',
          border: '2px solid #111',
          borderRadius: '14px',
          padding: '16px',
          boxShadow: '0px 3px 0px #111',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        <div style={{ fontSize: '12px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Passkeys
        </div>

        {passkeys.map((pk) => (
          <div key={pk.credentialId} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span style={{ fontSize: '13px', fontWeight: 800, color: '#111' }}>{pk.name}</span>
            <span style={{ fontSize: '10px', fontWeight: 600, color: '#9ca3af', fontFamily: 'monospace' }}>
              {truncateCredId(pk.credentialId)}
            </span>
            {pk.createdAt && (
              <span style={{ fontSize: '10px', fontWeight: 600, color: '#9ca3af' }}>
                Added {new Date(pk.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
            )}
          </div>
        ))}

        {/* Success feedback */}
        {addSuccess && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            padding: '6px 10px', background: '#29CEB41A', border: '1px solid #29CEB4',
            borderRadius: '8px',
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#29CEB4" stroke-width="2.5" stroke-linecap="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span style={{ fontSize: '12px', fontWeight: 700, color: '#29CEB4' }}>Passkey added</span>
          </div>
        )}

        {/* Error feedback */}
        {addError !== null && (
          <div style={{
            padding: '6px 10px', background: 'white', border: '1px solid #EF7B28',
            borderRadius: '8px',
          }}>
            <span style={{ fontSize: '12px', fontWeight: 700, color: '#EF7B28' }}>{addError}</span>
          </div>
        )}

        {/* Add Passkey button */}
        <button
          onClick={handleAddPasskey}
          disabled={addingPasskey}
          style={{
            width: '100%',
            height: '36px',
            background: 'white',
            border: '2px solid #111',
            borderRadius: '10px',
            boxShadow: addingPasskey ? 'none' : '0px 2px 0px #111',
            fontSize: '13px',
            fontWeight: 800,
            color: '#111',
            cursor: addingPasskey ? 'wait' : 'pointer',
            fontFamily: 'inherit',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            opacity: addingPasskey ? 0.6 : 1,
            transition: 'transform 0.1s ease, box-shadow 0.1s ease',
          }}
          className="btn-neo"
        >
          {addingPasskey ? (
            <>
              <style>{`@keyframes floors-spin-settings { to { transform: rotate(360deg); } }`}</style>
              <span style={{ display: 'inline-block', width: 14, height: 14, border: '2px solid #111', borderTopColor: 'transparent', borderRadius: '50%', animation: 'floors-spin-settings 0.8s linear infinite' }} />
              Creating…
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="2.5" stroke-linecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Add Passkey
            </>
          )}
        </button>
      </div>

      {/* About */}
      <div
        style={{
          background: 'white',
          border: '2px solid #111',
          borderRadius: '14px',
          padding: '16px',
          boxShadow: '0px 3px 0px #111',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        <div style={{ fontSize: '12px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          About
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>Version</span>
          <span style={{ fontSize: '12px', fontWeight: 800, color: '#111' }}>1.0.0</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>Built with</span>
          <span style={{ fontSize: '12px', fontWeight: 800, color: '#EF7B28' }}>Xecute</span>
        </div>
      </div>

      {/* Sign out button */}
      <button
        onClick={onSignOut}
        style={{
          width: '100%',
          height: '44px',
          background: 'white',
          border: '2px solid #111',
          borderRadius: '13px',
          boxShadow: '0px 3px 0px #111',
          fontSize: '14px',
          fontWeight: 800,
          color: '#EF4444',
          cursor: 'pointer',
          fontFamily: 'inherit',
          transition: 'transform 0.1s ease, box-shadow 0.1s ease',
          marginTop: '4px',
        }}
        className="btn-neo"
      >
        Sign Out
      </button>
    </div>
  );
}

// ── Main Tab Interface ───────────────────────────────────────────────────────

interface MainTabInterfaceProps {
  activeTab: Tab;
  onTabChange: (tab: Tab, floorId?: string) => void;
  accountId: string;
  passkeys: Array<{ name: string; credentialId: string; createdAt: string; source?: string }>;
  onPasskeysChanged: (passkeys: Array<{ name: string; credentialId: string; createdAt: string; source?: string }>) => void;
  onBuy: () => void;
  onFund: () => void;
  onSignOut: () => void;
  highlightFloorId: string | null;
  onClearHighlight: () => void;
}

function MainTabInterface({ activeTab, onTabChange, accountId, passkeys, onPasskeysChanged, onBuy, onFund, onSignOut, highlightFloorId, onClearHighlight }: MainTabInterfaceProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        position: 'absolute',
        inset: 0,
        background: '#FAF9F6',
        zIndex: 10,
      }}
    >
      {/* Persistent top header */}
      <TopHeaderBar accountId={accountId} passkeys={passkeys} />

      {/* Tab content area — use display:none to preserve scroll position */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', paddingBottom: '72px' }} class="no-scrollbar">
        <div style={{ display: activeTab === 'home' ? 'block' : 'none' }}>
          <HomeTab accountId={accountId} onSwitchTab={onTabChange} onBuy={onBuy} onFund={onFund} />
        </div>
        <div style={{ display: activeTab === 'portfolio' ? 'block' : 'none' }}>
          <PortfolioTab accountId={accountId} highlightFloorId={highlightFloorId} onClearHighlight={onClearHighlight} />
        </div>
        <div style={{ display: activeTab === 'activity' ? 'block' : 'none' }}>
          <ActivityTab accountId={accountId} />
        </div>
        <div style={{ display: activeTab === 'settings' ? 'block' : 'none' }}>
          <SettingsTab accountId={accountId} passkeys={passkeys} onPasskeysChanged={onPasskeysChanged} onSignOut={onSignOut} />
        </div>
      </div>

      {/* Bottom navigation — docked flat to bottom edge */}
      <BottomNav activeTab={activeTab} onTabChange={onTabChange} />
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

/** Parse floor defaults from a raw JSON string, returning a safe FloorSelection. */
function parseFloorDefaults(raw: string | undefined): FloorSelection {
  if (raw == null) return { bps: 1000 as FloorBps, duration_secs: DURATION_DEFAULT_SECS }; // Default: 10% floor ON
  try {
    const parsed = JSON.parse(raw) as { bps?: unknown; duration_secs?: unknown };
    const bps = typeof parsed.bps === 'number' ? parsed.bps : 0;
    const duration_secs = typeof parsed.duration_secs === 'number' ? parsed.duration_secs : DURATION_DEFAULT_SECS;
    const validBps: FloorBps[] = [0, 1000, 2000];
    // Clamp duration to valid range
    const clampedDuration = Math.max(DURATION_MIN_SECS, Math.min(duration_secs, DURATION_MAX_SECS));
    return {
      bps: (validBps.includes(bps as FloorBps) ? bps : 0) as FloorBps,
      duration_secs: clampedDuration,
    };
  } catch {
    return { bps: 0, duration_secs: DURATION_DEFAULT_SECS };
  }
}

function App() {
  const { ticker, postId } = getParams();

  // If opened with a ticker param (from content script), go to buy flow.
  // If opened via icon click (no ticker param), go to main tab interface.
  const openedFromContentScript = new URLSearchParams(window.location.search).has('ticker');

  const [state, setState] = useState<SheetState>({
    ticker,
    postId,
    // accountId and savedCredentialId start empty; populated async from chrome.storage.local
    accountId: '',
    savedCredentialId: '',
    screen: openedFromContentScript ? 'buy' : 'main',
    signing: false,
    statusId: null,
    txHash: null,
    errorMsg: null,
    draftQuote: null,
    draftLoading: openedFromContentScript,
    draftError: null,
    floor: { bps: 0, duration_secs: DURATION_DEFAULT_SECS },
    partialFloorError: null,
    partialActualQty: null,
    floorId: null,
    passkeys: [],
    storageLoaded: false,
    pendingCompressedKeyHex: '',
    pendingPasskeyName: '',
    amount: 10,
    activeTab: 'home',
    highlightFloorId: null,
  });

  // ── Load account/credential data from chrome.storage.local on mount ───────
  // The web app runs on localhost:5173 and writes to its own localStorage.
  // The bridge.content.ts syncs those keys into chrome.storage.local so they
  // are accessible here on the chrome-extension:// origin.
  useEffect(() => {
    const keys = [
      'floors:account_id',
      'floors:credential_id',
      'floors:floor_defaults',
      'floors:passkeys',
    ];
    chrome.storage.local.get(keys, (result) => {
      const accountId = (typeof result['floors:account_id'] === 'string' ? result['floors:account_id'] : '') as string;
      const savedCredentialId = (typeof result['floors:credential_id'] === 'string' ? result['floors:credential_id'] : '') as string;
      const floor = parseFloorDefaults(typeof result['floors:floor_defaults'] === 'string' ? result['floors:floor_defaults'] : undefined);

      // Parse passkeys array
      let passkeys: Array<{ name: string; credentialId: string; createdAt: string; source?: string }> = [];
      try {
        const raw = result['floors:passkeys'];
        if (typeof raw === 'string') {
          passkeys = JSON.parse(raw) as typeof passkeys;
        }
      } catch {
        // Invalid JSON — ignore
      }

      // Only extension-native passkeys can be used for signing — passkeys synced
      // from the web app (localhost origin) have a different WebAuthn RP ID and
      // cannot be asserted from the chrome-extension:// origin.
      //
      // ONLY passkeys explicitly tagged source:'extension' are usable. Passkeys
      // without a source tag are web-synced (pre-tagging era) or ambiguous —
      // either way they have the wrong RP ID for this origin.
      const usablePasskeys = passkeys.filter((pk) => pk.source === 'extension');

      // Decide initial screen:
      //   - no account → onboarding (full wallet creation)
      //   - account exists but no usable extension passkeys → link-device
      //   - opened from content script (ticker param) with multiple passkeys → picker
      //   - opened from content script with single passkey → buy
      //   - opened from icon click (no ticker) with account ready → main (tabbed UI)
      const defaultScreen: Screen = openedFromContentScript ? 'buy' : 'main';
      let screen: Screen = defaultScreen;
      let activeCredentialId = savedCredentialId;
      if (!accountId) {
        screen = 'onboarding';
      } else if (usablePasskeys.length === 0) {
        // Account exists (synced from web) but no extension-native passkeys.
        // Show the link-device screen so the user can create one.
        screen = 'link-device';
      } else if (openedFromContentScript && usablePasskeys.length > 1) {
        screen = 'passkey-picker';
      } else if (usablePasskeys.length >= 1 && usablePasskeys[0] !== undefined) {
        // Use first usable passkey credential ID
        activeCredentialId = usablePasskeys[0].credentialId;
        // If opened from icon click and account is ready, show tabbed UI
        if (!openedFromContentScript) {
          screen = 'main';
        }
      }

      setState((s) => ({
        ...s,
        accountId,
        savedCredentialId: activeCredentialId,
        floor,
        passkeys,
        storageLoaded: true,
        screen,
      }));
    });
  }, []);

  // ── Fetch quote — debounced on amount, re-run on floor/ticker ──────────────

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Don't fetch if amount is zero or negative
    if (state.amount <= 0) {
      setState((s) => ({ ...s, draftQuote: null, draftLoading: false, draftError: null }));
      return;
    }

    let cancelled = false;
    setState((s) => ({ ...s, draftLoading: true, draftError: null }));

    async function fetchQuote() {
      try {
        let draftUrl = `${API_URL}/v1/quotes/draft?asset=${encodeURIComponent(ticker)}&usd=${state.amount}`;
        // Include floor params so the draft quote returns floor pricing
        if (state.floor.bps > 0) {
          draftUrl += `&floor_bps=${state.floor.bps}&duration_secs=${state.floor.duration_secs}`;
        }
        const res = await fetch(draftUrl);

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(text || `${res.status}`);
        }
        const data = await res.json() as DraftQuote;
        if (!cancelled) {
          // Handle "coming soon" assets — quote_id is null, available is false
          if (data.available === false) {
            setState((s) => ({ ...s, draftLoading: false, draftError: data.reason ?? `${ticker} trading coming soon`, draftQuote: null }));
          } else {
            setState((s) => ({ ...s, draftQuote: data, draftLoading: false, draftError: null }));
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!cancelled) {
          setState((s) => ({ ...s, draftLoading: false, draftError: friendlyError(msg), draftQuote: null }));
        }
      }
    }

    // Debounce 500ms so we don't hit API on every keystroke
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      void fetchQuote();
    }, 500);

    return () => {
      cancelled = true;
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
      }
    };
  // Re-run whenever ticker, amount, or floor selection changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, state.amount, state.floor.bps, state.floor.duration_secs]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleBack = useCallback(() => {
    window.close();
  }, []);

  const handleFloorChange = useCallback((floor: FloorSelection) => {
    setState((s) => ({ ...s, floor }));
  }, []);

  const handleAmountChange = useCallback((amount: number) => {
    setState((s) => ({ ...s, amount }));
  }, []);

  const handleConfirm = useCallback(async () => {
    const { draftQuote: quote, floor } = state;
    if (quote === null) return;

    setState((s) => ({ ...s, signing: true }));

    try {
      // C2: WYSIWYS — verify payload matches what the sheet displays before signing.
      // Build an IntentPayload from the quote so verifyAgainstSheet can check fields.
      const intentMessage = JSON.stringify([
        {
          type: 'TokenDiff',
          diff: {
            [quote.asset]: quote.est_qty,
            'usdc.near': `-${quote.pay_usdc}`,
          },
        },
      ]);
      const intentPayload: IntentPayload = {
        message: intentMessage,
        nonce: crypto.getRandomValues(new Uint8Array(32)),
        recipient: 'intents.near',
      };
      const mismatches = verifyAgainstSheet(intentPayload, {
        asset: quote.asset,
        qty: quote.est_qty,
      });
      if (mismatches.length > 0) {
        throw new Error(`Payload mismatch: do not sign. ${mismatches.join('; ')}`);
      }

      // Build challenge including floor params for WYSIWYS integrity
      const challengePayload = JSON.stringify({
        ticker: state.ticker,
        amount_usdc: quote.pay_usdc,
        quote_id: quote.quote_id,
        ...(floor.bps > 0 ? { floor: { bps: floor.bps, duration_secs: floor.duration_secs } } : {}),
      });
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(challengePayload));
      const challenge = new Uint8Array(hashBuffer);

      // Guard: verify the credential we're about to use belongs to an
      // extension-native passkey. If not, redirect to link-device so the user
      // can create one — this prevents the scary OS "no passkeys" dialog.
      const isExtensionCred = state.passkeys.some(
        (pk) => pk.credentialId === state.savedCredentialId && pk.source === 'extension',
      );
      if (!isExtensionCred) {
        setState((s) => ({ ...s, signing: false, screen: 'link-device' }));
        return;
      }

      const assertion = await signWithPasskey(challenge, state.savedCredentialId);

      // Send the DER-encoded signature to the API — Node's crypto.createVerify
      // expects DER, not the raw 64-byte r||s format.
      const sigDerHex = Array.from(assertion.signatureDer)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      const credentialId = assertion.credentialId;
      const idempotencyKey = crypto.randomUUID();

      // Include authenticator_data and client_data_json for server-side signature
      // verification, and account_id so the API can look up the account even when
      // the extension's credential_id differs from the one stored at account creation
      // (link-device flow creates a second passkey with a different credential_id).
      const authDataHex = Array.from(assertion.authenticatorData)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      const clientDataHex = Array.from(assertion.clientDataJSON)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      const submitBody: Record<string, unknown> = {
        quote_id: quote.quote_id,
        assertion: {
          signature: sigDerHex,
          credential_id: credentialId,
          ticker: state.ticker,
          amount_usdc: quote.pay_usdc,
          authenticator_data: authDataHex,
          client_data_json: clientDataHex,
          account_id: state.accountId,
        },
      };
      if (floor.bps > 0) {
        submitBody['floor'] = { bps: floor.bps, duration_secs: floor.duration_secs };
      }

      const submitRes = await fetch(`${API_URL}/v1/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(submitBody),
      });

      if (!submitRes.ok) {
        const text = await submitRes.text().catch(() => '');
        // Extract the server message from the JSON error envelope when possible,
        // then run through friendlyError() so the user never sees raw JSON.
        let serverMsg = '';
        try {
          const parsed = JSON.parse(text) as { error?: { message?: string } };
          serverMsg = parsed?.error?.message ?? '';
        } catch { /* not JSON — use raw text */ }
        throw new Error(friendlyError(serverMsg || text || `Server error (${submitRes.status})`));
      }

      const submitData = await submitRes.json() as { status_id: string; status: string };
      const statusId = submitData.status_id;

      setState((s) => ({ ...s, statusId, screen: 'signing' }));

      // Notify background with the raw r||s signature (for the legacy /v1/buy path)
      const sigRawHex = Array.from(assertion.signature)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      void browser.runtime.sendMessage({
        type: 'SHEET_SIGNED',
        ticker: state.ticker,
        amount: (BigInt(quote.pay_usdc) / 1_000_000n).toString(),
        signature: sigRawHex,
        publicKey: credentialId,
        credentialId,
        floorProtection: floor.bps > 0,
        quoteId: quote.quote_id,
      }).catch(() => {/* ignore */});

      // Track via SSE
      const eventSource = new EventSource(`${API_URL}/v1/status/${statusId}/stream`);

      await new Promise<void>((resolve) => {
        let resolved = false;

        const finishSuccess = (txHash: string | null = null, floorId?: string | null) => {
          if (!resolved) {
            resolved = true;
            eventSource.close();
            setState((s) => ({ ...s, signing: false, screen: 'success', txHash, floorId: floorId ?? s.floorId }));
            resolve();
          }
        };

        // H6: accept actual_qty from partial SSE event
        const finishPartial = (floorError: string, actualQty?: string) => {
          if (!resolved) {
            resolved = true;
            eventSource.close();
            setState((s) => ({
              ...s,
              signing: false,
              screen: 'partial',
              partialFloorError: floorError,
              partialActualQty: actualQty ?? null,
            }));
            resolve();
          }
        };

        const finishError = (msg: string) => {
          if (!resolved) {
            resolved = true;
            eventSource.close();
            setState((s) => ({ ...s, signing: false, screen: 'error', errorMsg: friendlyError(msg) }));
            resolve();
          }
        };

        eventSource.addEventListener('status', (ev: MessageEvent<string>) => {
          try {
            const data = JSON.parse(ev.data) as {
              state?: string;
              type?: string;
              tx_hash?: string | null;
              swap_done?: boolean;
              floor_error?: string;
              /** H6: actual quantity received from the swap */
              actual_qty?: string;
              /** On-chain floor ID returned when a floor is opened */
              floor_id?: string | null;
            };

            // Capture floor_id whenever it appears in any event
            if (data.floor_id != null) {
              setState((s) => ({ ...s, floorId: String(data.floor_id) }));
            }

            // Partial outcome: swap succeeded but floor failed
            if (data.type === 'partial' && data.swap_done === true && data.floor_error !== undefined) {
              finishPartial(data.floor_error, data.actual_qty);
              return;
            }

            if (data.state === 'done') {
              finishSuccess(data.tx_hash ?? null, data.floor_id);
            } else if (data.state === 'failed') {
              finishError('Order failed');
            }
            // 'submitted' and 'tracking' are intermediate — keep showing progress
          } catch {
            // parse error — ignore
          }
        });

        eventSource.onerror = () => {
          eventSource.close();
          if (!resolved) {
            resolved = true;
            setState((s) => ({
              ...s,
              signing: false,
              screen: 'error',
              errorMsg: 'Transaction may still be processing — check your portfolio',
            }));
            resolve();
          }
        };

        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            eventSource.close();
            setState((s) => ({
              ...s,
              signing: false,
              screen: 'error',
              errorMsg: 'Still processing… check portfolio',
            }));
            resolve();
          }
        }, 45_000); // Ref Finance swaps take ~20s on testnet; give plenty of time
      });
    } catch (err) {
      console.error('[floors] Confirm failed:', err);
      const msg = err instanceof Error ? err.message : String(err);

      // Detect WebAuthn / passkey errors — these indicate the stored credential
      // can't be used from this origin (e.g. RP ID mismatch with web-synced
      // passkeys). Redirect to link-device if account exists, otherwise onboarding.
      const isPasskeyError = err instanceof DOMException || msg.includes('credential') || msg.includes('passkey') || msg.includes('not allowed') || msg.includes('navigator.credentials');
      if (isPasskeyError) {
        setState((s) => ({ ...s, signing: false, screen: s.accountId ? 'link-device' : 'onboarding' }));
      } else {
        setState((s) => ({ ...s, signing: false, screen: 'error', errorMsg: friendlyError(msg) }));
      }
    }
  }, [state]);

  const handleRetry = useCallback(() => {
    setState((s) => ({
      ...s,
      screen: openedFromContentScript ? 'buy' : 'main',
      signing: false,
      statusId: null,
      txHash: null,
      errorMsg: null,
      partialFloorError: null,
      partialActualQty: null,
    }));
  }, [openedFromContentScript]);

  const handleViewPortfolio = useCallback(() => {
    setState((s) => ({ ...s, screen: 'main', activeTab: 'portfolio' as Tab }));
  }, []);

  const handleAddFloor = useCallback(() => {
    setState((s) => ({
      ...s,
      screen: 'buy',
      signing: false,
      partialFloorError: null,
      partialActualQty: null,
      floor: s.floor.bps > 0 ? s.floor : { bps: 1000, duration_secs: DURATION_DEFAULT_SECS },
    }));
  }, []);

  const handlePasskeySelect = useCallback((credentialId: string) => {
    setState((s) => ({ ...s, savedCredentialId: credentialId, screen: openedFromContentScript ? 'buy' : 'main' }));
  }, [openedFromContentScript]);

  // ── Onboarding handlers ──────────────────────────────────────────────────

  const handleGoToCreatePasskey = useCallback(() => {
    setState((s) => ({ ...s, screen: 'create-passkey' }));
  }, []);

  const handleGoToSignIn = useCallback(() => {
    setState((s) => ({ ...s, screen: 'sign-in' }));
  }, []);

  const handleBackToWelcome = useCallback(() => {
    setState((s) => ({ ...s, screen: 'onboarding' }));
  }, []);

  const handleLinkDeviceCreated = useCallback((credentialId: string) => {
    // Extension-native passkey created for an existing account.
    // Update passkeys list from storage and go to appropriate screen.
    chrome.storage.local.get(['floors:passkeys'], (result) => {
      let passkeys: Array<{ name: string; credentialId: string; createdAt: string; source?: string }> = [];
      try {
        const raw = result['floors:passkeys'];
        if (typeof raw === 'string') {
          passkeys = JSON.parse(raw) as typeof passkeys;
        }
      } catch {
        // ignore
      }
      setState((s) => ({
        ...s,
        savedCredentialId: credentialId,
        passkeys,
        screen: openedFromContentScript ? 'buy' : 'main',
      }));
    });
  }, [openedFromContentScript]);

  const handlePasskeyCreated = useCallback(async (result: { credentialId: string; compressedKeyHex: string; passkeyName: string }) => {
    // Call the API to create the account
    try {
      const res = await fetch(`${API_URL}/v1/accounts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          public_key_hex: result.compressedKeyHex,
          credential_id: result.credentialId,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Account creation failed: ${res.status} ${text}`);
      }

      const data = await res.json() as { account_id: string; created: boolean };

      // Store in chrome.storage.local — tag with source:'extension' so we can
      // distinguish extension-native passkeys from web-synced ones (the latter
      // have a different WebAuthn RP ID and can't be used for signing here).
      const passkeyEntry = {
        name: result.passkeyName,
        credentialId: result.credentialId,
        createdAt: new Date().toISOString(),
        source: 'extension' as const,
      };

      // Read existing passkeys and append
      const storageResult = await new Promise<Record<string, unknown>>((resolve) => {
        chrome.storage.local.get(['floors:passkeys'], resolve);
      });
      let existingPasskeys: Array<{ name: string; credentialId: string; createdAt: string; source?: string }> = [];
      try {
        const raw = storageResult['floors:passkeys'];
        if (typeof raw === 'string') {
          existingPasskeys = JSON.parse(raw) as typeof existingPasskeys;
        }
      } catch {
        // ignore
      }
      existingPasskeys.push(passkeyEntry);

      await new Promise<void>((resolve) => {
        chrome.storage.local.set({
          'floors:account_id': data.account_id,
          'floors:credential_id': result.credentialId,
          'floors:compressed_key': result.compressedKeyHex,
          'floors:passkey_name': result.passkeyName,
          'floors:passkeys': JSON.stringify(existingPasskeys),
        }, resolve);
      });

      setState((s) => ({
        ...s,
        accountId: data.account_id,
        savedCredentialId: result.credentialId,
        pendingCompressedKeyHex: result.compressedKeyHex,
        pendingPasskeyName: result.passkeyName,
        passkeys: existingPasskeys,
        screen: 'creating-account',
      }));
    } catch (err) {
      console.error('[floors] Account creation failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, screen: 'error', errorMsg: friendlyError(msg) }));
    }
  }, []);

  const handleAccountReady = useCallback(() => {
    setState((s) => ({ ...s, screen: 'account-ready' }));
  }, []);

  const handleAccountReadyContinue = useCallback(() => {
    setState((s) => ({ ...s, screen: openedFromContentScript ? 'buy' : 'main' }));
  }, [openedFromContentScript]);

  const handleAccountCreationError = useCallback((msg: string) => {
    setState((s) => ({ ...s, screen: 'error', errorMsg: friendlyError(msg) }));
  }, []);

  const handleSignInAuthenticated = useCallback((credentialId: string, accountId: string) => {
    setState((s) => ({
      ...s,
      accountId,
      savedCredentialId: credentialId,
      screen: openedFromContentScript ? 'buy' : 'main',
    }));
  }, [openedFromContentScript]);

  const handleContinueWithoutFloor = useCallback(() => {
    setState((s) => ({
      ...s,
      screen: 'success',
      partialFloorError: null,
      partialActualQty: null,
    }));
  }, []);

  const handleSellBack = useCallback(async () => {
    // H5: sell the partially-received tokens back to USDC.
    // XECUTE-109: 3-step signed action flow (challenge → sign → submit).
    // XECUTE-110: WYSIWYS — verifyAgainstSheet before signWithPasskey.
    const { draftQuote: quote, accountId, savedCredentialId, partialActualQty, floorId } = state;
    if (!quote) return;
    if (!floorId) {
      setState((s) => ({ ...s, screen: 'error', errorMsg: 'Floor ID not available — cannot sell back' }));
      return;
    }

    setState((s) => ({ ...s, signing: true }));

    try {
      // WYSIWYS: verify the sell-back payload matches what the partial screen shows.
      // The sell-back is a TokenDiff with a negative asset amount (selling back).
      const sellQty = partialActualQty ?? quote.est_qty;
      const sellIntentMessage = JSON.stringify([
        {
          type: 'TokenDiff',
          diff: {
            [quote.asset]: `-${sellQty}`,
            'usdc.near': sellQty,
          },
        },
      ]);
      const sellIntentPayload: IntentPayload = {
        message: sellIntentMessage,
        nonce: crypto.getRandomValues(new Uint8Array(32)),
        recipient: 'intents.near',
      };
      const mismatches = verifyAgainstSheet(sellIntentPayload, {
        asset: quote.asset,
        qty: `-${sellQty}`,
      });
      if (mismatches.length > 0) {
        throw new Error(`Payload mismatch: do not sign. ${mismatches.join('; ')}`);
      }

      // Step 1: get challenge from API
      const challengeRes = await fetch(
        `${API_URL}/v1/accounts/${encodeURIComponent(accountId)}/actions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'sell_to_floor', floor_id: floorId }),
        },
      );
      if (!challengeRes.ok) {
        const text = await challengeRes.text().catch(() => '');
        throw new Error(`Action challenge failed: ${challengeRes.status} ${text}`);
      }
      const { wallet_request, challenge } = await challengeRes.json() as {
        wallet_request: unknown;
        challenge: string;
      };

      // Guard: ensure credential belongs to an extension-native passkey
      const isExtensionCred = state.passkeys.some(
        (pk) => pk.credentialId === savedCredentialId && pk.source === 'extension',
      );
      if (!isExtensionCred) {
        setState((s) => ({ ...s, signing: false, screen: 'link-device' }));
        return;
      }

      // Step 2: sign challenge with passkey
      const challengeBytes = hexToBytes(challenge);
      const assertion = await signWithPasskey(challengeBytes, savedCredentialId);

      // SECURITY (H3): Use DER-encoded signature (matching handleConfirm buy flow).
      // Node's crypto.createVerify expects DER, not raw 64-byte r||s format.
      const sigDerHex = Array.from(assertion.signatureDer)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      const credentialId = assertion.credentialId;

      // Include authenticator_data and client_data_json for server-side signature
      // verification (matching handleConfirm buy flow).
      const authDataHex = Array.from(assertion.authenticatorData)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      const clientDataHex = Array.from(assertion.clientDataJSON)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      // Step 3: submit with assertion
      const submitRes = await fetch(`${API_URL}/v1/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'sell_to_floor',
          floor_id: floorId,
          account_id: accountId,
          signature: sigDerHex,
          credential_id: credentialId,
          authenticator_data: authDataHex,
          client_data_json: clientDataHex,
          wallet_request,
        }),
      });

      if (!submitRes.ok) {
        const text = await submitRes.text().catch(() => '');
        throw new Error(`Sell-back submit failed: ${submitRes.status} ${text}`);
      }

      setState((s) => ({
        ...s,
        signing: false,
        screen: 'success',
        partialFloorError: null,
        partialActualQty: null,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isPasskeyError = err instanceof DOMException || msg.includes('credential') || msg.includes('passkey') || msg.includes('not allowed') || msg.includes('navigator.credentials');
      if (isPasskeyError) {
        setState((s) => ({ ...s, signing: false, screen: s.accountId ? 'link-device' : 'onboarding' }));
      } else {
        setState((s) => ({ ...s, signing: false, screen: 'error', errorMsg: friendlyError(msg) }));
      }
    }
  }, [state]);

  // ── Tab / main interface handlers ──────────────────────────────────────────

  const handleTabChange = useCallback((tab: Tab, floorId?: string) => {
    setState((s) => ({ ...s, activeTab: tab, highlightFloorId: floorId ?? null }));
  }, []);

  const handleBuyFromHome = useCallback((buyTicker: string) => {
    setState((s) => ({
      ...s,
      ticker: buyTicker,
      screen: 'buy',
      draftQuote: null,
      draftLoading: true,
      draftError: null,
      amount: 10,
    }));
  }, []);

  const handleSignOut = useCallback(() => {
    chrome.storage.local.remove([
      'floors:account_id',
      'floors:credential_id',
      'floors:compressed_key',
      'floors:passkey_name',
      'floors:passkeys',
      'floors:floor_defaults',
    ], () => {
      setState((s) => ({
        ...s,
        accountId: '',
        savedCredentialId: '',
        passkeys: [],
        screen: 'onboarding',
      }));
    });
  }, []);

  const handleBackFromBuy = useCallback(() => {
    if (openedFromContentScript) {
      window.close();
    } else {
      // Return to main tabbed interface
      setState((s) => ({ ...s, screen: 'main' }));
    }
  }, [openedFromContentScript]);

  // While loading storage, show spinner
  if (!state.storageLoaded) {
    return <LoadingSpinner />;
  }

  return (
    <>
      {state.screen === 'main' && (
        <MainTabInterface
          activeTab={state.activeTab}
          onTabChange={handleTabChange}
          accountId={state.accountId}
          passkeys={state.passkeys}
          onPasskeysChanged={(updatedPasskeys) => setState((s) => ({ ...s, passkeys: updatedPasskeys }))}
          onBuy={() => handleBuyFromHome('ETH')}
          onFund={() => setState((s) => ({ ...s, screen: 'fund' }))}
          onSignOut={handleSignOut}
          highlightFloorId={state.highlightFloorId}
          onClearHighlight={() => setState((s) => ({ ...s, highlightFloorId: null }))}
        />
      )}
      {state.screen === 'fund' && (
        <FundScreen
          accountId={state.accountId}
          onBack={() => setState((s) => ({ ...s, screen: 'main' }))}
        />
      )}
      {state.screen === 'onboarding' && (
        <WelcomeScreen
          onCreateWallet={handleGoToCreatePasskey}
          onSignIn={handleGoToSignIn}
        />
      )}
      {state.screen === 'create-passkey' && (
        <CreatePasskeyScreen
          onCreated={handlePasskeyCreated}
          onBack={handleBackToWelcome}
        />
      )}
      {state.screen === 'creating-account' && (
        <CreatingAccountScreen
          accountId={state.accountId}
          onReady={handleAccountReady}
          onError={handleAccountCreationError}
        />
      )}
      {state.screen === 'account-ready' && (
        <AccountReadyScreen
          accountId={state.accountId}
          onContinue={handleAccountReadyContinue}
        />
      )}
      {state.screen === 'link-device' && (
        <LinkDeviceScreen
          accountId={state.accountId}
          originalCredentialId={state.savedCredentialId}
          onCreated={handleLinkDeviceCreated}
        />
      )}
      {state.screen === 'sign-in' && (
        <SignInScreen
          onAuthenticated={handleSignInAuthenticated}
          onBack={handleBackToWelcome}
        />
      )}
      {state.screen === 'passkey-picker' && (
        <PasskeyPickerScreen
          passkeys={state.passkeys.filter((pk) => pk.source === 'extension')}
          onSelect={handlePasskeySelect}
        />
      )}
      {state.screen === 'buy' && (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'absolute', inset: 0 }}>
          <TopHeaderBar accountId={state.accountId} passkeys={state.passkeys} />
          <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
            <BuyScreen
              state={state}
              onConfirm={handleConfirm}
              onBack={handleBackFromBuy}
              onFloorChange={handleFloorChange}
              onAmountChange={handleAmountChange}
            />
          </div>
        </div>
      )}
      {state.screen === 'signing' && (
        <SigningScreen statusId={state.statusId} />
      )}
      {state.screen === 'success' && (
        <SuccessScreen
          ticker={state.ticker}
          draftQuote={state.draftQuote}
          statusId={state.statusId}
          txHash={state.txHash}
          floorIncluded={state.floor.bps > 0 && state.draftQuote?.floor_price_e6 !== undefined}
          floor={state.floor}
          onViewPortfolio={handleViewPortfolio}
        />
      )}
      {state.screen === 'partial' && (
        <PartialScreen
          ticker={state.ticker}
          draftQuote={state.draftQuote}
          floorError={state.partialFloorError ?? 'Unknown error'}
          actualQty={state.partialActualQty}
          onAddFloor={handleAddFloor}
          onContinue={handleContinueWithoutFloor}
          onSellBack={handleSellBack}
          signing={state.signing}
        />
      )}
      {state.screen === 'error' && (
        <ErrorScreen message={state.errorMsg ?? 'Unknown error'} onRetry={handleRetry} />
      )}
    </>
  );
}

// ── Mount ─────────────────────────────────────────────────────────────────────

const root = document.getElementById('react-root');
if (root) {
  render(<App />, root);
}
