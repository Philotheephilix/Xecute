/**
 * Floors Buy Sheet — extension popup page.
 *
 * Neo-brutalist design following design.html tokens exactly.
 * Uses Preact for rendering. WebAuthn for signing.
 *
 * P1-C: Real quote → sign → submit → SSE status flow.
 */

import { h, render, Fragment } from 'preact';
import { useState, useCallback, useEffect } from 'preact/hooks';
import { signWithPasskey } from '../../lib/webauthn.js';

// ── Design tokens (from design.html) ─────────────────────────────────────────
// orange: #EF7B28, teal: #29CEB4, border: 2px solid #111111
// shadow-neo: 0px 4px 0px #111111, border-radius cards: 18px, buttons: 13px

const API_URL = 'http://localhost:3001';

type Screen = 'buy' | 'signing' | 'success' | 'error';

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
}

// ── Parse URL params ──────────────────────────────────────────────────────────

function getParams(): { ticker: string; postId: string | undefined } {
  const params = new URLSearchParams(window.location.search);
  const ticker = params.get('ticker') ?? 'ETH';
  const postId = params.get('postId') ?? undefined;
  return { ticker, postId };
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
  onConfirm: () => void;
  onBack: () => void;
}

function BuyScreen({ state, onConfirm, onBack }: BuyScreenProps) {
  const { draftQuote, draftLoading, draftError, ticker } = state;

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
          gap: '16px',
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
            </>
          )}
        </div>

        <div style={{ flex: 1 }} />

        {/* Confirm button */}
        <button
          class="btn-neo"
          onClick={onConfirm}
          disabled={state.signing || draftQuote === null || draftLoading}
          style={{
            width: '100%',
            height: '52px',
            background: state.signing || draftQuote === null ? '#cccccc' : '#EF7B28',
            color: '#111111',
            fontSize: '15px',
            fontWeight: 800,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            opacity: (state.signing || draftQuote === null) ? 0.7 : 1,
            cursor: (state.signing || draftQuote === null) ? 'wait' : 'pointer',
          }}
          aria-busy={state.signing}
        >
          {state.signing ? (
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
      style={{ padding: '0', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}
    >
      <div style={{ fontSize: '16px', fontWeight: 700, color: '#111111', marginBottom: '8px' }}>
        Submitting Order...
      </div>
      {statusId !== null && (
        <div style={{ fontSize: '12px', color: '#9ca3af' }} data-testid="status-id">
          Status: {statusId}
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
  onViewPortfolio: () => void;
}

function SuccessScreen({ ticker, draftQuote, statusId, txHash, onViewPortfolio }: SuccessScreenProps) {
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
            Order Submitted!
          </div>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#6b7280', marginTop: '6px' }}>
            Your buy order is being processed
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
        style={{
          width: '100%',
          height: '52px',
          background: '#EF7B28',
          color: '#111111',
          fontSize: '15px',
          fontWeight: 800,
        }}
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
  });

  // ── Fetch draft quote on mount ────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    async function fetchDraft() {
      try {
        const res = await fetch(
          `${API_URL}/v1/quotes/draft?asset=${encodeURIComponent(ticker)}&usd=10`,
        );
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Quote API returned ${res.status}: ${text}`);
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

    void fetchDraft();
    return () => { cancelled = true; };
  }, [ticker]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleBack = useCallback(() => {
    window.close();
  }, []);

  const handleConfirm = useCallback(async () => {
    const { draftQuote } = state;
    if (draftQuote === null) return;

    setState((s) => ({ ...s, signing: true }));

    try {
      // Build challenge: SHA-256(JSON.stringify({ ticker, amount_usdc, quote_id }))
      const challengePayload = JSON.stringify({
        ticker: state.ticker,
        amount_usdc: draftQuote.pay_usdc,
        quote_id: draftQuote.quote_id,
      });
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(challengePayload));
      const challenge = new Uint8Array(hashBuffer);

      // Sign with passkey
      const assertion = await signWithPasskey(challenge);

      // Hex-encode signature
      const sigHex = Array.from(assertion.signature)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      // credential_id is Base64URL from webauthn lib — pass as-is
      const credentialId = assertion.credentialId;

      // Generate idempotency key
      const idempotencyKey = crypto.randomUUID();

      // POST /v1/submit
      const submitRes = await fetch(`${API_URL}/v1/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          quote_id: draftQuote.quote_id,
          assertion: {
            signature: sigHex,
            credential_id: credentialId,
            ticker: state.ticker,
            amount_usdc: draftQuote.pay_usdc,
          },
        }),
      });

      if (!submitRes.ok) {
        const text = await submitRes.text().catch(() => '');
        throw new Error(`Submit failed: ${submitRes.status} ${text}`);
      }

      const submitData = await submitRes.json() as { status_id: string; status: string };
      const statusId = submitData.status_id;

      setState((s) => ({ ...s, statusId, screen: 'signing' }));

      // Open SSE stream
      const eventSource = new EventSource(`${API_URL}/v1/status/${statusId}/stream`);

      await new Promise<void>((resolve) => {
        let resolved = false;
        const done = (txHash: string | null = null) => {
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

        // Resolve to success after "submitted" — the order is in the system
        eventSource.addEventListener('status', (ev: MessageEvent<string>) => {
          try {
            const data = JSON.parse(ev.data) as {
              state: string;
              tx_hash?: string | null;
            };
            if (
              data.state === 'submitted' ||
              data.state === 'tracking' ||
              data.state === 'done'
            ) {
              done(data.tx_hash ?? null);
            } else if (data.state === 'failed') {
              if (!resolved) {
                resolved = true;
                eventSource.close();
                setState((s) => ({
                  ...s,
                  signing: false,
                  screen: 'error',
                  errorMsg: 'Order failed to process',
                }));
                resolve();
              }
            }
          } catch {
            // parse error — ignore
          }
        });

        eventSource.onerror = () => {
          // SSE error or server closed — treat as success since submit already returned 202
          done(null);
        };

        // Timeout safety: if SSE never resolves in 10s, show success anyway
        setTimeout(() => done(null), 10_000);
      });
    } catch (err) {
      console.error('[floors] Confirm failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      setState((s) => ({
        ...s,
        signing: false,
        screen: 'error',
        errorMsg: msg,
      }));
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
    }));
  }, []);

  const handleViewPortfolio = useCallback(() => {
    window.close();
  }, []);

  return (
    <>
      {state.screen === 'buy' && (
        <BuyScreen
          state={state}
          onConfirm={handleConfirm}
          onBack={handleBack}
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
          onViewPortfolio={handleViewPortfolio}
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
