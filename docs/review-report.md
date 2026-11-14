# Floors Code Review Report

**Date:** 2026-11-14
**Scope:** Contracts, Services (API + Relayer), Extension, Web App
**Tests:** 39 unit tests pass, 1 sandbox integration test passes, TypeScript compiles clean (zero errors)

---

## CRITICAL — Must Fix Before Shipping (3)

### C1. Tier-3 credential fallback enables unauthenticated buys
**Location:** `services/api/src/routes/submit.ts:276`

The 3-tier credential lookup's tier-3 path trusts the client-supplied `account_id` to resolve any account. Combined with `isLinkedDevice=true` (which skips WebAuthn), an attacker who knows any valid `account_id` can submit a buy with a fabricated `credential_id` and garbage signature. Attack chain: send nonexistent credential_id + victim's account_id → tier-1/2 miss → tier-3 resolves victim → isLinkedDevice=true → WebAuthn skipped → buy executes against victim's account.

### C2. Credentials endpoint has zero authentication
**Location:** `services/api/src/routes/accounts.ts:246`

`POST /v1/accounts/:account_id/credentials` requires no auth. Anyone who knows an account_id can register their own credential for that account, then use it through tier-2 lookup in submit.ts to make authenticated purchases. This is a full account-takeover vector.

### C3. DB error in isLinkedDevice IIFE skips WebAuthn verification
**Location:** `services/api/src/routes/submit.ts:308`

The async IIFE determining `isLinkedDevice` catches DB errors and returns `false`. This is negated, so `isLinkedDevice = !(false) = true`, causing WebAuthn verification to be skipped for primary credentials during any transient DB issue. An attacker who can induce DB latency (connection exhaustion, slow query injection) gets a window to submit with invalid signatures.

---

## HIGH — Should Fix Soon (3)

### H1. Ref Finance swap has zero slippage protection
**Location:** `services/relayer/src/routes/swap.ts:279`

`min_amount_out: '0'` means any output is accepted. Sandwich attacks on Ref Finance pools would drain the USDC input for near-zero output. Even on testnet this teaches bad habits that will ship to mainnet.

### H2. Relayer transfers entire output token balance, not just swap proceeds
**Location:** `services/relayer/src/routes/swap.ts:316`

After a swap, `ft_balance_of` returns the relayer's *total* balance of the output token, not just proceeds from this swap. Accumulated tokens from prior failed transfers get sent to the next user. Concurrent swaps create a race condition where one user receives another's tokens.

### H3. handleSellBack sends raw r||s signature instead of DER
**Location:** `apps/extension/src/entrypoints/sheet/index.tsx:4021-4023`

`handleSellBack` sends raw 64-byte `assertion.signature`, while `handleConfirm` (buy flow) correctly sends `assertion.signatureDer` because "Node's crypto.createVerify expects DER." The sell-back will fail server-side signature verification every time. Also missing: `authenticator_data` and `client_data_json` fields that the buy flow includes.

---

## MEDIUM — Tech Debt / Correctness (6)

### M1. `init_sleeve` creates unbacked USDC (accounting fiction)
**Location:** `contracts/floors/src/sleeves.rs:46-51`

Credits `sleeve.free_usdc` and increments `totals.held` + `totals.free` without actual USDC deposit. Testnet bootstrap is intentional, but the method is gated by `assert_admin()` (not a testnet-only flag). Any admin calling this in production creates phantom USDC that passes solvency checks but fails reconciliation, triggering a global pause.

### M2. `on_sell_payout` failure path has asymmetric surplus accounting
**Location:** `contracts/floors/src/floors.rs:110-126, 205-241`

In `sell_to_floor`, surplus (reserved_usdc - payout_usdc) vanishes from `reserved` without going to `free`. The failure revert path tries `free -= surplus` via `saturating_sub`, but `free` was never incremented. Currently masked by saturating arithmetic, but this asymmetry will produce incorrect totals in edge cases.

### M3. handleSellBack WYSIWYS verification uses wrong USDC diff
**Location:** `apps/extension/src/entrypoints/sheet/index.tsx:3969-3977`

Sell-back `TokenDiff` sets `'usdc.near': sellQty` — reusing the raw token quantity as the USDC amount. Selling 0.005 ETH does not yield 0.005 USDC. The USDC diff should derive from the quote, not the token quantity.

### M4. handleConfirm / handleSellBack have stale closure over entire state
**Location:** `apps/extension/src/entrypoints/sheet/index.tsx:3779, 4061`

`useCallback` depends on `[state]` — the entire state object. Since `setState` produces a new object every render, the callback recreates every render (defeating memoization). During async execution, reads like `state.savedCredentialId` capture a snapshot that can go stale if the user switches credentials or storage listener fires mid-flight.

### M5. PositionCard countdown useMemo never recomputes on tick
**Location:** `apps/web/src/components/PositionCard.tsx:173-185`

`setTick` forces re-render every 60s, but `countdown` useMemo has `[position.protected_until]` as deps (eslint rule suppressed). `tick` is not in the dependency array, so cached value persists until `protected_until` changes (which it never does for a given position). Same issue affects the `progress` useMemo at line 188.

### M6. Invite code consumed before duplicate account check
**Location:** `services/api/src/routes/accounts.ts:150`

Invite code is redeemed at line 155 BEFORE the account existence check at line 167. If the derived `account_id` already exists, the invite code is wasted and unrecoverable.

---

## LOW — Nice to Have (4)

### L1. "Close Position" button is a no-op
**Location:** `apps/extension/src/entrypoints/sheet/index.tsx:3001-3019`

PortfolioTab renders a "Close Position" button that has no handler wired up.

### L2. ActivityFeed explorerUrl has no URL sanitization
**Location:** `apps/web/src/components/ActivityFeed.tsx:187-188`

`tx_hash` is interpolated directly into a URL passed to `window.open`. Should use `encodeURIComponent(txHash)` for correctness, even though the fixed domain limits risk.

### L3. Portfolio fetches positions independently from AppContext
**Location:** `apps/web/src/screens/Portfolio.tsx:49-75`

Portfolio maintains its own position state while AppContext also fetches positions. Both tabs mount simultaneously (show/hide pattern), causing double API calls. After sell/close in Portfolio, AppContext state stays stale. Portfolio should use `useApp()` positions and `refreshPositions()`.

### L4. Testnet swap creates new signing account per call
**Location:** `services/relayer/src/routes/swap.ts:452`

Testnet path uses `createSigningAccount(config)` each time instead of the `getSigningAccount` singleton already available in relay.ts.

---

## Overall Assessment

### Shippable? NO — not without fixing the 3 critical auth bypasses.

The **authentication/authorization layer in services/api is fundamentally broken**. Findings C1, C2, and C3 together form a complete attack surface: anyone can register credentials for any account (C2), then use the tier-3 fallback to bypass verification (C1), and transient DB issues disable WebAuthn entirely (C3). These are not theoretical — they require only knowledge of a victim's account_id and basic HTTP requests.

The **relayer** has two high-severity financial bugs (H1, H2) that allow value extraction through sandwich attacks and token balance confusion.

The **extension sell-back flow** (H3) is non-functional due to the signature format mismatch.

The **contracts** are in better shape — the two medium findings are testnet-specific bookkeeping issues with clear paths to fix before mainnet.

### Recommended Fix Order

1. **Immediately:** C1, C2, C3 — add authentication to credentials endpoint, fix isLinkedDevice error handling (default to `false` = NOT linked = require WebAuthn), remove or restrict tier-3 fallback
2. **Before any user-facing deploy:** H1, H2, H3 — add slippage protection, track swap proceeds separately from total balance, fix sell-back signature format
3. **Before mainnet:** M1, M2 — gate `init_sleeve` behind testnet flag, fix surplus accounting symmetry
4. **Next sprint:** remaining medium and low findings

### Strengths

- Contracts have solid test coverage (39 unit + 1 integration, all passing)
- TypeScript compiles clean with zero type errors and zero `as any` casts
- The WYSIWYS (What You See Is What You Sign) pattern in the extension is a good security design
- Solvency reconciliation mechanism in contracts is well-designed (it caught the accounting issue by design)
- near-sdk version pinning with `=` for reproducible builds is correct practice
