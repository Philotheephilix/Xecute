/**
 * Floors Buy Sheet — extension popup page entrypoint.
 *
 * P2-6: Floor protection row, WYSIWYS floor fields, partial outcome screen,
 *       floor badge on success.
 */

import { h, render, Fragment } from 'preact';
import { useState, useCallback, useEffect } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { signWithPasskey } from '../../lib/webauthn.js';

const API_URL = 'http://localhost:3001';

// ── Types ─────────────────────────────────────────────────────────────────────

type Screen = 'buy' | 'signing' | 'success' | 'partial' | 'error';

/** Floor selection: bps=0 means off */
type FloorBps = 0 | 500 | 1000;
type FloorDuration = 2592000 | 7776000 | 15552000; // 30d / 90d / 180d in secs

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
}

interface SheetState {
  ticker: string;
  postId: string | undefined;
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
}

// ── URL params ────────────────────────────────────────────────────────────────

function getParams(): { ticker: string; postId: string | undefined } {
  const params = new URLSearchParams(window.location.search);
  const ticker = params.get('ticker') ?? 'ETH';
  const postId = params.get('postId') ?? undefined;
  return { ticker, postId };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatFloorPrice(floor_price_e6: string): string {
  // floor_price_e6 is a micro-dollar integer (6 decimal places)
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
  return expiry.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

// ── SVG icons ─────────────────────────────────────────────────────────────────

function BackArrow() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#111111"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
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
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
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
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
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
    { label: 'OFF', value: 0 },
    { label: '5%', value: 500 },
    { label: '10%', value: 1000 },
  ];
  const durationOptions: { label: string; value: FloorDuration }[] = [
    { label: '30d', value: 2592000 },
    { label: '90d', value: 7776000 },
    { label: '180d', value: 15552000 },
  ];

  const isActive = floor.bps > 0;

  const btnBase: h.JSX.CSSProperties = {
    border: '2px solid #111111',
    borderRadius: '8px',
    padding: '4px 10px',
    fontSize: '12px',
    fontWeight: 800,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'transform 0.1s ease, box-shadow 0.1s ease',
  };
  const btnInactive: h.JSX.CSSProperties = {
    ...btnBase,
    background: 'white',
    color: '#111111',
  };
  const btnActive: h.JSX.CSSProperties = {
    ...btnBase,
    background: '#29CEB4',
    color: '#111111',
    // boxShadow removed — handled by shadow-neo-sm Tailwind class below
  };
  const btnActiveClass = 'shadow-neo-sm active:translate-y-[2px] active:shadow-none';

  return (
    <div
      style={{
        background: 'white',
        border: '2px solid #111111',
        borderRadius: '14px',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
      aria-label="Floor protection options"
    >
      {/* Top row: label + bps toggle */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '13px', fontWeight: 700, color: '#111111', display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span role="img" aria-label="shield">🛡</span> Floor Protection
        </span>
        <div style={{ display: 'flex', gap: '6px' }}>
          {bpsOptions.map(({ label, value }) => (
            <button
              key={value}
              class={floor.bps === value ? btnActiveClass : undefined}
              style={floor.bps === value ? btnActive : btnInactive}
              onClick={() => onChange({ ...floor, bps: value })}
              aria-pressed={floor.bps === value}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Duration row — only when floor is on */}
      {isActive && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>Duration</span>
          <div style={{ display: 'flex', gap: '6px' }}>
            {durationOptions.map(({ label, value }) => (
              <button
                key={value}
                class={floor.duration_secs === value ? btnActiveClass : undefined}
                style={floor.duration_secs === value ? btnActive : btnInactive}
                onClick={() => onChange({ ...floor, duration_secs: value })}
                aria-pressed={floor.duration_secs === value}
              >
                {label}
              </button>
            ))}
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

// ── Buy screen ────────────────────────────────────────────────────────────────

interface BuyScreenProps {
  state: SheetState;
  onConfirm: () => void;
  onBack: () => void;
  onFloorChange: (floor: FloorSelection) => void;
}

function BuyScreen({ state, onConfirm, onBack, onFloorChange }: BuyScreenProps) {
  const { draftQuote, draftLoading, draftError, ticker, signing, floor } = state;
  const hasFloor = floor.bps > 0;

  return (
    <div
      class="screen screen-active"
      style={{ padding: '0', display: 'flex', flexDirection: 'column' }}
    >
      {/* Header */}
      <div
        style={{
          background: 'linear-gradient(to bottom, #ED7725, #F28530)',
          borderBottom: '2px solid #111111',
          borderRadius: '0 0 28px 28px',
          padding: '16px 18px 20px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          boxShadow: '0px 5px 0px #111111',
        }}
      >
        <button class="btn-back" onClick={onBack} aria-label="Back">
          <BackArrow />
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#5A2D0C', lineHeight: 1.2 }}>
            Buy Crypto
          </div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: '#111111', lineHeight: 1.2 }}>
            Buy ${ticker}
          </div>
        </div>
        <div
          style={{
            background: 'white',
            border: '2px solid #111111',
            borderRadius: '20px',
            padding: '4px 12px',
            fontSize: '13px',
            fontWeight: 800,
            boxShadow: '0px 2.5px 0px #111111',
          }}
        >
          ${ticker}
        </div>
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          padding: '20px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
          overflowY: 'auto',
        }}
      >
        {/* WYSIWYS Quote Card */}
        <div
          style={{
            background: 'white',
            border: '2px solid #111111',
            borderRadius: '18px',
            padding: '16px',
            boxShadow: '0px 4px 0px #111111',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
          aria-label="Quote details"
        >
          <div style={{ fontSize: '12px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Order Preview
          </div>

          {draftLoading && (
            <div style={{ fontSize: '14px', color: '#6b7280', textAlign: 'center', padding: '8px 0' }}>
              Fetching best price...
            </div>
          )}

          {draftError !== null && !draftLoading && (
            <div style={{ fontSize: '13px', color: '#ef4444', fontWeight: 600 }}>
              {draftError}
            </div>
          )}

          {draftQuote !== null && !draftLoading && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '12.5px', fontWeight: 600, color: '#6b7280' }}>Buying</span>
                <span style={{ fontSize: '15px', fontWeight: 800, color: '#111111' }} data-testid="est-amount">
                  ~{draftQuote.display.est_amount} {ticker}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '12.5px', fontWeight: 600, color: '#6b7280' }}>Paying</span>
                <span style={{ fontSize: '15px', fontWeight: 800, color: '#111111' }} data-testid="you-pay">
                  ${draftQuote.display.you_pay} USDC
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '12.5px', fontWeight: 600, color: '#6b7280' }}>Quote expires</span>
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#9ca3af' }}>
                  {draftQuote.display.expires}
                </span>
              </div>

              {/* WYSIWYS floor section — shown before user signs */}
              {hasFloor && draftQuote.floor_price_e6 !== undefined && (
                <>
                  <div style={{ borderTop: '1.5px solid #e5e7eb', margin: '2px 0' }} />
                  <div style={{ fontSize: '11px', fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span role="img" aria-label="shield">🛡</span> Floor Protection
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>Floor price</span>
                    <span style={{ fontSize: '14px', fontWeight: 800, color: '#111111' }}>
                      {formatFloorPrice(draftQuote.floor_price_e6)}
                    </span>
                  </div>
                  {draftQuote.fee_usdc !== undefined && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '12px', fontWeight: 700, color: '#29CEB4' }}>Most you can lose</span>
                      <span style={{ fontSize: '13px', fontWeight: 800, color: '#111111' }}>
                        {formatFee(draftQuote.fee_usdc)}
                      </span>
                    </div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>Protected until</span>
                    <span style={{ fontSize: '12px', fontWeight: 700, color: '#111111' }}>
                      {formatFloorExpiry(floor.duration_secs)}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>Quote ID</span>
                    <span style={{ fontSize: '11px', fontWeight: 700, color: '#9ca3af', fontFamily: 'monospace' }}>
                      {draftQuote.quote_id.slice(0, 8)}...
                    </span>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* Floor Protection Row */}
        <FloorRow
          floor={floor}
          draftQuote={draftQuote}
          onChange={onFloorChange}
        />

        <div style={{ flex: 1 }} />

        {/* Confirm button */}
        <button
          class="btn-neo"
          onClick={onConfirm}
          disabled={signing || draftQuote === null || draftLoading}
          style={{
            width: '100%',
            height: '52px',
            background: signing || draftQuote === null ? '#cccccc' : '#EF7B28',
            color: '#111111',
            fontSize: '15px',
            fontWeight: 800,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            opacity: (signing || draftQuote === null) ? 0.7 : 1,
            cursor: (signing || draftQuote === null) ? 'wait' : 'pointer',
          }}
          aria-busy={signing}
        >
          {signing ? (
            'Verifying...'
          ) : (
            <>
              <span>Confirm with Face ID</span>
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
      class="screen screen-active"
      style={{ padding: '32px 18px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}
    >
      <div style={{ fontSize: '16px', fontWeight: 700, color: '#111111', marginBottom: '8px' }}>
        Submitting Order...
      </div>
      {statusId !== null && (
        <div style={{ fontSize: '12px', color: '#9ca3af' }} data-testid="status-id">
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
      class="screen screen-enter-right screen-active"
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
            background: '#E6FBF7',
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
              : 'Your buy order is being processed'}
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
              <span style={{ fontSize: '11px', fontWeight: 700, color: '#9ca3af', fontFamily: 'monospace' }} data-testid="status-id">
                {statusId.slice(0, 8)}...
              </span>
            </div>
          )}

          {txHash !== null && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>Tx Hash</span>
              <span style={{ fontSize: '11px', fontWeight: 700, color: '#9ca3af', fontFamily: 'monospace' }}>
                {txHash.slice(0, 10)}...
              </span>
            </div>
          )}
        </div>
      </div>

      <div style={{ padding: '0 18px 24px' }}>
        <button
          class="btn-neo"
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
  onAddFloor: () => void;
  onContinue: () => void;
}

function PartialScreen({ ticker, draftQuote, floorError, onAddFloor, onContinue }: PartialScreenProps) {
  return (
    <div
      class="screen screen-enter-right screen-active"
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
            background: '#FFF7ED',
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
            One step didn't finish
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
          {/* Swap success row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '16px', color: '#22c55e', fontWeight: 800 }}>✓</span>
            <span style={{ fontSize: '13px', fontWeight: 700, color: '#111111' }}>
              Bought {draftQuote?.display.est_amount ?? ''} {ticker}
            </span>
          </div>

          {/* Floor failure row */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
            <span style={{ fontSize: '16px', color: '#ef4444', fontWeight: 800, lineHeight: '20px' }}>✗</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span style={{ fontSize: '13px', fontWeight: 700, color: '#111111' }}>Floor wasn't added</span>
              <span style={{ fontSize: '12px', fontWeight: 600, color: '#9ca3af' }}>
                Reason: {floorError}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: '0 18px 24px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <button
          class="btn-neo"
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
          class="btn-neo"
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
        {/* TODO(deferred): "Swap back to USDC" — requires reversing the swap;
            complex flow, deferred. See docs/20-extension-x-overlay.md §partial-outcome. */}
      </div>
    </div>
  );
}

// ── Error screen ──────────────────────────────────────────────────────────────

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      class="screen screen-active"
      style={{ padding: '32px 18px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px' }}
    >
      <div style={{ fontSize: '20px', fontWeight: 800, color: '#ef4444' }}>Order Failed</div>
      <div style={{ fontSize: '13px', fontWeight: 600, color: '#6b7280', textAlign: 'center' }}>{message}</div>
      <button
        class="btn-neo"
        onClick={onRetry}
        style={{ width: '100%', height: '52px', background: '#EF7B28', color: '#111111', fontSize: '15px', fontWeight: 800 }}
      >
        Try Again
      </button>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
  const { ticker, postId } = getParams();

  const [state, setState] = useState<SheetState>({
    ticker,
    postId,
    screen: 'buy',
    signing: false,
    statusId: null,
    txHash: null,
    errorMsg: null,
    draftQuote: null,
    draftLoading: true,
    draftError: null,
    floor: { bps: 0, duration_secs: 2592000 },
    partialFloorError: null,
  });

  // ── Fetch quote (refetches when floor selection changes) ──────────────────

  useEffect(() => {
    let cancelled = false;

    setState((s) => ({ ...s, draftLoading: true, draftError: null, draftQuote: null }));

    async function fetchQuote() {
      try {
        // Build request body; include floor when active
        const body: Record<string, unknown> = {
          asset: ticker,
          usd: 10,
        };
        if (state.floor.bps > 0) {
          body['floor'] = { bps: state.floor.bps, duration_secs: state.floor.duration_secs };
        }

        const res = await fetch(`${API_URL}/v1/quotes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        // Fall back to draft endpoint if the quotes endpoint isn't up yet
        if (!res.ok && res.status === 404) {
          const draftRes = await fetch(
            `${API_URL}/v1/quotes/draft?asset=${encodeURIComponent(ticker)}&usd=10`,
          );
          if (!draftRes.ok) {
            const text = await draftRes.text().catch(() => '');
            throw new Error(`Quote API ${draftRes.status}: ${text}`);
          }
          const data = await draftRes.json() as DraftQuote;
          if (!cancelled) {
            setState((s) => ({ ...s, draftQuote: data, draftLoading: false, draftError: null }));
          }
          return;
        }

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Quote API ${res.status}: ${text}`);
        }
        const data = await res.json() as DraftQuote;
        if (!cancelled) {
          setState((s) => ({ ...s, draftQuote: data, draftLoading: false, draftError: null }));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!cancelled) {
          setState((s) => ({ ...s, draftLoading: false, draftError: `Could not fetch quote: ${msg}` }));
        }
      }
    }

    void fetchQuote();
    return () => { cancelled = true; };
  // Re-run whenever ticker or floor selection changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, state.floor.bps, state.floor.duration_secs]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleBack = useCallback(() => {
    window.close();
  }, []);

  const handleFloorChange = useCallback((floor: FloorSelection) => {
    setState((s) => ({ ...s, floor }));
  }, []);

  const handleConfirm = useCallback(async () => {
    const { draftQuote: quote, floor } = state;
    if (quote === null) return;

    setState((s) => ({ ...s, signing: true }));

    try {
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

      const assertion = await signWithPasskey(challenge);

      const sigHex = Array.from(assertion.signature)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      const credentialId = assertion.credentialId;
      const idempotencyKey = crypto.randomUUID();

      const submitBody: Record<string, unknown> = {
        quote_id: quote.quote_id,
        assertion: {
          signature: sigHex,
          credential_id: credentialId,
          ticker: state.ticker,
          amount_usdc: quote.pay_usdc,
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
        throw new Error(`Submit failed: ${submitRes.status} ${text}`);
      }

      const submitData = await submitRes.json() as { status_id: string; status: string };
      const statusId = submitData.status_id;

      setState((s) => ({ ...s, statusId, screen: 'signing' }));

      void browser.runtime.sendMessage({
        type: 'SHEET_SIGNED',
        ticker: state.ticker,
        amount: (BigInt(quote.pay_usdc) / 1_000_000n).toString(),
        signature: sigHex,
        publicKey: credentialId,
        credentialId,
        floorProtection: floor.bps > 0,
        quoteId: quote.quote_id,
      }).catch(() => {/* ignore */});

      // Track via SSE
      const eventSource = new EventSource(`${API_URL}/v1/status/${statusId}/stream`);

      await new Promise<void>((resolve) => {
        let resolved = false;

        const finishSuccess = (txHash: string | null = null) => {
          if (!resolved) {
            resolved = true;
            eventSource.close();
            setState((s) => ({
              ...s,
              signing: false,
              screen: 'success',
              txHash,
            }));
            resolve();
          }
        };

        const finishPartial = (floorError: string) => {
          if (!resolved) {
            resolved = true;
            eventSource.close();
            setState((s) => ({
              ...s,
              signing: false,
              screen: 'partial',
              partialFloorError: floorError,
            }));
            resolve();
          }
        };

        const finishError = (msg: string) => {
          if (!resolved) {
            resolved = true;
            eventSource.close();
            setState((s) => ({ ...s, signing: false, screen: 'error', errorMsg: msg }));
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
            };

            // Partial outcome: swap succeeded but floor failed
            if (data.type === 'partial' && data.swap_done === true && data.floor_error !== undefined) {
              finishPartial(data.floor_error);
              return;
            }

            if (data.state === 'submitted' || data.state === 'tracking' || data.state === 'done') {
              finishSuccess(data.tx_hash ?? null);
            } else if (data.state === 'failed') {
              finishError('Order failed');
            }
          } catch {
            // parse error — ignore
          }
        });

        eventSource.onerror = () => {
          finishSuccess(null);
        };

        setTimeout(() => finishSuccess(null), 8_000);
      });
    } catch (err) {
      console.error('[floors] Confirm failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, signing: false, screen: 'error', errorMsg: msg }));
    }
  }, [state]);

  const handleRetry = useCallback(() => {
    setState((s) => ({
      ...s,
      screen: 'buy',
      signing: false,
      statusId: null,
      txHash: null,
      errorMsg: null,
      partialFloorError: null,
    }));
  }, []);

  const handleViewPortfolio = useCallback(() => {
    window.close();
  }, []);

  const handleAddFloor = useCallback(() => {
    // Re-open to buy screen with floor enabled (keep existing selection or default 5%)
    setState((s) => ({
      ...s,
      screen: 'buy',
      signing: false,
      partialFloorError: null,
      floor: s.floor.bps > 0 ? s.floor : { bps: 500, duration_secs: 2592000 },
    }));
  }, []);

  const handleContinueWithoutFloor = useCallback(() => {
    // Swap is done; just show success screen
    setState((s) => ({
      ...s,
      screen: 'success',
      partialFloorError: null,
    }));
  }, []);

  return (
    <>
      {state.screen === 'buy' && (
        <BuyScreen
          state={state}
          onConfirm={handleConfirm}
          onBack={handleBack}
          onFloorChange={handleFloorChange}
        />
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
          onAddFloor={handleAddFloor}
          onContinue={handleContinueWithoutFloor}
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
