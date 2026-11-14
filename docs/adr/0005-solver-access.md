# ADR-0005: Solver Access

Date: 2026-11-13
Status: Accepted

## Context

Floors executes cross-chain token swaps (buying ETH, SOL, STRK with NEAR/USDC). We need
to confirm: (a) is there a live solver network with public access, (b) do ETH/SOL/STRK have
active liquidity, and (c) what latency should we design against?

## Research findings

### 1. Solver relay infrastructure

From `docs.near-intents.org/llms-full.txt` (offset 200 000):

- **WebSocket endpoint:** `wss://solver-relay-v2.chaindefuser.com/ws`
- **Authentication:** Partner JWT (via `X-API-Key` header on REST endpoints)
- **REST RPC endpoints:**
  - `quote` — price quotes from all connected solvers
  - `publish_intent` — submit a single signed user intent
  - `publish_intents` — batch submit, auto-retry
  - `get_status` — check intent execution status

The network is a competitive **auction model**: solvers bid within a time window, the
lowest-price/fastest solver is selected, and must honor the quoted rate or face penalties.

### 2. Is there a public solver?

Access to the solver relay requires a **Partner JWT** (API key). This is not fully open/anonymous
but partner onboarding appears to be available — the 1Click API and SDK (`1click.chaindefuser.com`)
provide a higher-level abstraction that handles solver routing without requiring direct relay access.

**Two access paths available to Floors:**

| Path | Access | Latency | Complexity |
|------|--------|---------|-----------|
| 1Click Swap API (`POST /v0/submit-intent`) | Public (no key for basic) | Adds ~100-300ms HTTP overhead | Low |
| Direct solver relay (WebSocket JWT) | Partner key required | Native relay latency | Higher |

For P1 (one-tap buy), the 1Click API path is the fastest integration. The direct relay
path is available for P2 if tighter latency is required.

### 3. Supported tokens: ETH, SOL, STRK

From live token endpoint `https://1click.chaindefuser.com/v0/tokens` (queried 2026-11-12):

| Token | Price | NEP-141 contract | Status |
|-------|-------|-----------------|--------|
| **ETH** | $2,014.58 | `eth.bridge.near` (also Arb, Base, Opt, Gnosis variants via OMFT) | **Live** |
| **SOL** | $81.60 | `sol.omft.near` | **Live** |
| **STRK** | $0.0368 | `starknet.omft.near` | **Live** |

All three target tokens have live pricing and solver coverage. ETH has multiple chain
variants (Ethereum mainnet + L2s). STRK uses the OMFT bridge.

### 4. Latency expectations

From solver relay documentation:

| Leg | Latency target |
|-----|---------------|
| Top-level quote auction window | **300 ms minimum** collection window |
| Router FastQuote sub-leg | **< ~50 ms** end-to-end accept window |
| Full auction (quote → selection → on-chain settlement) | **~50 ms – 3000 ms** range |
| Solver response deadline | Up to **3000 ms** wait |

**p50 fill time estimate: ~500–800 ms** for ETH (liquid, multiple solvers).
STRK may be slower given its lower liquidity; design against 3 s worst case.

For the extension UX, we should show a "filling…" state after signature submission and
poll `get_status` at 500 ms intervals with a 10 s timeout.

### 5. `defuse-labs` / third-party solvers

The `defuse-protocol/defuse-sdk` repo was archived August 2025; the active repo is
`defuse-protocol/sdk-monorepo`. Third-party solver documentation is available through
the solver relay partner onboarding. No public "run your own solver" quick-start was
found in this spike.

## Decision

**Go.**

ETH, SOL, and STRK all have live solver coverage on the NEAR Intents network. The 1Click
Swap API provides a no-key-required integration path for P1. Direct relay access is available
with partner onboarding for lower latency in P2.

Design latency budget: **3 s timeout**, **500 ms poll interval**, **p50 ~800 ms**.

## Consequences

- P1 integration uses `POST https://1click.chaindefuser.com/v0/submit-intent` — no partner
  key setup required for initial development.
- STRK token identifier: `starknet.omft.near` (NEP-141 on NEAR).
- ETH token identifier: `eth.bridge.near` for Ethereum mainnet ETH; use OMFT variants for L2.
- SOL token identifier: `sol.omft.near`.
- Extension must handle 3 s+ fill times gracefully (loading state, not spinner-of-death).
- For production, apply for partner JWT to access the direct solver relay WebSocket.

## Open items

1. Confirm minimum swap amounts for ETH/SOL/STRK (docs reference a "Swap Limits" page
   not retrieved in this spike).
2. Confirm whether 1Click API requires any auth header for `submit-intent` at volume.
3. Evaluate STRK solver depth — price impact for $10–$100 buys at current $0.037 price.
4. Apply for solver relay partner JWT for P2 direct integration.
