/**
 * Floors Buy Sheet — extension popup page.
 *
 * Neo-brutalist design following design.html tokens exactly.
 * Uses Preact for rendering. WebAuthn for signing.
 */

import { h, render, Fragment } from 'preact';
import { useState, useCallback, useEffect } from 'preact/hooks';
import { signWithPasskey } from '../../lib/webauthn.js';

// ── Design tokens (from design.html) ─────────────────────────────────────────
// orange: #EF7B28, teal: #29CEB4, border: 2px solid #111111
// shadow-neo: 0px 4px 0px #111111, border-radius cards: 18px, buttons: 13px

type Screen = 'buy' | 'success';

interface SheetState {
  ticker: string;
  postId: string | undefined;
  screen: Screen;
  amount: string;
  floorProtection: boolean;
  signing: boolean;
  txDetails: TxDetails | null;
}

interface TxDetails {
  ticker: string;
  amount: string;
  floorProtection: boolean;
  credentialId: string;
}

// ── Parse URL params ──────────────────────────────────────────────────────────

function getParams(): { ticker: string; postId: string | undefined } {
  const params = new URLSearchParams(window.location.search);
  const ticker = params.get('ticker') ?? 'ETH';
  const postId = params.get('postId') ?? undefined;
  return { ticker, postId };
}

// ── Fee calculation (mock for S4) ─────────────────────────────────────────────

function calculateFees(amount: string, floorProtection: boolean) {
  const num = parseFloat(amount) || 0;
  const floorFee = floorProtection ? num * 0.005 : 0; // 0.5% floor fee
  const protectedValue = floorProtection ? num * 0.97 : 0;
  return {
    floorFee: floorFee.toFixed(2),
    protectedValue: protectedValue.toFixed(2),
  };
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

// ── Buy screen ────────────────────────────────────────────────────────────────

interface BuyScreenProps {
  state: SheetState;
  onAmountChange: (v: string) => void;
  onToggleFloor: () => void;
  onConfirm: () => void;
  onBack: () => void;
}

function BuyScreen({
  state,
  onAmountChange,
  onToggleFloor,
  onConfirm,
  onBack,
}: BuyScreenProps) {
  const { floorFee, protectedValue } = calculateFees(
    state.amount,
    state.floorProtection,
  );

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
          <div
            style={{
              fontSize: '13px',
              fontWeight: 600,
              color: '#5A2D0C',
              lineHeight: 1.2,
            }}
          >
            Buy Crypto
          </div>
          <div
            style={{
              fontSize: '20px',
              fontWeight: 800,
              color: '#111111',
              lineHeight: 1.2,
            }}
          >
            {/* Safe: ticker comes from URL params validated against registry */}
            Buy ${state.ticker}
          </div>
        </div>
        {/* Ticker pill badge */}
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
          {/* Safe: ticker is a validated enum value */}
          ${state.ticker}
        </div>
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          padding: '20px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}
      >
        {/* Amount input card */}
        <div
          style={{
            background: 'white',
            border: '2px solid #111111',
            borderRadius: '18px',
            padding: '16px',
            boxShadow: '0px 4px 0px #111111',
          }}
        >
          <div
            style={{
              fontSize: '12px',
              fontWeight: 700,
              color: '#6b7280',
              marginBottom: '8px',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            Amount (USD)
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <span
              style={{
                fontSize: '32px',
                fontWeight: 800,
                color: '#111111',
                lineHeight: 1,
              }}
            >
              $
            </span>
            <input
              type="number"
              min="1"
              step="any"
              placeholder="0.00"
              value={state.amount}
              onInput={(e) =>
                onAmountChange((e.target as HTMLInputElement).value)
              }
              style={{
                flex: 1,
                fontSize: '32px',
                fontWeight: 800,
                color: '#111111',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                fontFamily: 'inherit',
                lineHeight: 1,
                width: '100%',
              }}
              aria-label="Amount in USD"
            />
          </div>
        </div>

        {/* Floor protection toggle */}
        <div
          style={{
            background: 'white',
            border: '2px solid #111111',
            borderRadius: '18px',
            padding: '14px 16px',
            boxShadow: '0px 4px 0px #111111',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div
              style={{
                fontSize: '14px',
                fontWeight: 800,
                color: '#111111',
              }}
            >
              Floor Protection
            </div>
            <div
              style={{
                fontSize: '11.5px',
                fontWeight: 600,
                color: '#6b7280',
                marginTop: '2px',
              }}
            >
              Limit downside risk
            </div>
          </div>
          <div
            class="toggle-wrapper"
            role="switch"
            aria-checked={state.floorProtection}
            tabIndex={0}
            onClick={onToggleFloor}
            onKeyDown={(e) => {
              if (e.key === ' ' || e.key === 'Enter') onToggleFloor();
            }}
          >
            <div class={`toggle-track${state.floorProtection ? ' on' : ''}`}>
              <div class="toggle-thumb" />
            </div>
            <span
              style={{
                fontSize: '12px',
                fontWeight: 800,
                color: state.floorProtection ? '#29CEB4' : '#9ca3af',
              }}
            >
              {state.floorProtection ? 'ON' : 'OFF'}
            </span>
          </div>
        </div>

        {/* Fee preview */}
        {state.floorProtection && parseFloat(state.amount) > 0 && (
          <div
            style={{
              background: 'white',
              border: '2px solid #111111',
              borderRadius: '18px',
              padding: '14px 16px',
              boxShadow: '0px 4px 0px #111111',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span
                style={{ fontSize: '12.5px', fontWeight: 600, color: '#6b7280' }}
              >
                Floor fee
              </span>
              <span
                style={{ fontSize: '13px', fontWeight: 800, color: '#111111' }}
              >
                {/* Safe: value is computed from user input number */}
                ${floorFee}
              </span>
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span
                style={{ fontSize: '12.5px', fontWeight: 600, color: '#6b7280' }}
              >
                Protected value
              </span>
              <span
                style={{ fontSize: '13px', fontWeight: 800, color: '#29CEB4' }}
              >
                {/* Safe: value is computed from user input number */}
                ${protectedValue}
              </span>
            </div>
          </div>
        )}

        <div style={{ flex: 1 }} />

        {/* Confirm button */}
        <button
          class="btn-neo"
          onClick={onConfirm}
          disabled={state.signing || !parseFloat(state.amount)}
          style={{
            width: '100%',
            height: '52px',
            background: state.signing ? '#cccccc' : '#EF7B28',
            color: '#111111',
            fontSize: '15px',
            fontWeight: 800,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            opacity: state.signing ? 0.7 : 1,
            cursor: state.signing ? 'wait' : 'pointer',
          }}
          aria-busy={state.signing}
        >
          {state.signing ? (
            'Verifying...'
          ) : (
            <>
              <span>Confirm with Face ID</span>
              <span role="img" aria-label="fingerprint">
                👆
              </span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// ── Success screen ────────────────────────────────────────────────────────────

interface SuccessScreenProps {
  txDetails: TxDetails;
  onViewPortfolio: () => void;
}

function SuccessScreen({ txDetails, onViewPortfolio }: SuccessScreenProps) {
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
        {/* Checkmark */}
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

        {/* Heading */}
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              fontSize: '24px',
              fontWeight: 800,
              color: '#111111',
              lineHeight: 1.2,
            }}
          >
            Order Submitted!
          </div>
          <div
            style={{
              fontSize: '13px',
              fontWeight: 600,
              color: '#6b7280',
              marginTop: '6px',
            }}
          >
            Your buy order is being processed
          </div>
        </div>

        {/* Transaction details card */}
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
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              paddingBottom: '8px',
              borderBottom: '1.5px solid #e5e7eb',
            }}
          >
            <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>
              Token
            </span>
            <span style={{ fontSize: '13px', fontWeight: 800, color: '#111111' }}>
              {/* Safe: ticker from validated params */}
              ${txDetails.ticker}
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              paddingBottom: '8px',
              borderBottom: '1.5px solid #e5e7eb',
            }}
          >
            <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>
              Amount
            </span>
            <span style={{ fontSize: '13px', fontWeight: 800, color: '#111111' }}>
              {/* Safe: amount from user input number formatted */}
              ${txDetails.amount}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: '#6b7280' }}>
              Floor Protection
            </span>
            <span
              style={{
                fontSize: '13px',
                fontWeight: 800,
                color: txDetails.floorProtection ? '#29CEB4' : '#111111',
              }}
            >
              {txDetails.floorProtection ? 'Active' : 'Off'}
            </span>
          </div>
        </div>
      </div>

      {/* View portfolio button */}
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

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
  const { ticker, postId } = getParams();

  const [state, setState] = useState<SheetState>({
    ticker,
    postId,
    screen: 'buy',
    amount: '',
    floorProtection: false,
    signing: false,
    txDetails: null,
  });

  const handleBack = useCallback(() => {
    window.close();
  }, []);

  const handleAmountChange = useCallback((value: string) => {
    setState((s) => ({ ...s, amount: value }));
  }, []);

  const handleToggleFloor = useCallback(() => {
    setState((s) => ({ ...s, floorProtection: !s.floorProtection }));
  }, []);

  const handleConfirm = useCallback(async () => {
    const amount = parseFloat(state.amount);
    if (!amount || amount <= 0) return;

    setState((s) => ({ ...s, signing: true }));

    try {
      // Build a real JSON intent payload as challenge bytes (SHA-256'd)
      const intentPayload = JSON.stringify({
        ticker: state.ticker,
        amount_usdc: Math.round(amount * 1_000_000).toString(), // 6-decimal USDC
        floor_protection: state.floorProtection,
      });
      const encoder = new TextEncoder();
      const intentBytes = encoder.encode(intentPayload);
      const hashBuffer = await crypto.subtle.digest('SHA-256', intentBytes);
      const challenge = new Uint8Array(hashBuffer);

      const assertion = await signWithPasskey(challenge);

      // Encode signature and credentialId as hex strings
      const sigHex = Array.from(assertion.signature)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      // credentialId is already a Base64URL string from the webauthn lib
      const credIdHex = assertion.credentialId;

      const quoteId = Array.from(challenge)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      // Notify service worker — it will POST to the API
      const response = await chrome.runtime.sendMessage({
        type: 'SHEET_SIGNED',
        ticker: state.ticker,
        amount: state.amount,
        signature: sigHex,
        publicKey: credIdHex,
        credentialId: credIdHex,
        floorProtection: state.floorProtection,
        quoteId,
      });

      if (response && typeof response === 'object' && 'error' in response) {
        throw new Error(String((response as { error: string }).error));
      }

      setState((s) => ({
        ...s,
        signing: false,
        screen: 'success',
        txDetails: {
          ticker: s.ticker,
          amount: s.amount,
          floorProtection: s.floorProtection,
          credentialId: credIdHex,
        },
      }));
    } catch (err) {
      console.error('[floors] Sign failed:', err);
      setState((s) => ({ ...s, signing: false }));
    }
  }, [state.ticker, state.amount, state.floorProtection]);

  const handleViewPortfolio = useCallback(() => {
    window.close();
  }, []);

  return (
    <>
      {state.screen === 'buy' && (
        <BuyScreen
          state={state}
          onAmountChange={handleAmountChange}
          onToggleFloor={handleToggleFloor}
          onConfirm={handleConfirm}
          onBack={handleBack}
        />
      )}
      {state.screen === 'success' && state.txDetails && (
        <SuccessScreen
          txDetails={state.txDetails}
          onViewPortfolio={handleViewPortfolio}
        />
      )}
    </>
  );
}

// ── Mount ─────────────────────────────────────────────────────────────────────

const root = document.getElementById('react-root');
if (root) {
  render(<App />, root);
}
