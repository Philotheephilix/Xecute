# Unwired / Fake / Broken Features Audit

> Generated 2026-11-14 by multi-agent Opus review.
> Priority: BROKEN > FAKE > STUBBED > DISABLED (top to bottom within each tier).

---

## P0 — BROKEN (supposed to work, errors at runtime)

### 1. Web: Sell-to-Floor / Close action endpoint mismatch
- **Where:** `apps/web/src/api/client.ts:328`
- **What:** `getActionChallenge()` calls `POST /v1/accounts/:account_id/actions` (nested path). Server registers `POST /v1/actions` (flat path). Result: 404 on every sell-to-floor and close attempt from the web Portfolio screen. The entire floor-action flow from web is non-functional.
- **Fix:** Change client to `POST /v1/actions` with `account_id` in the request body, or add an aliased server route at the nested path.

### 2. Extension: Double-submit on every buy
- **Where:** `apps/extension/src/entrypoints/sheet/index.tsx:4053, 4083`
- **What:** Sheet calls `/v1/submit` directly (line 4053), gets back `status_id`, transitions to SSE tracking. Then fires `SHEET_SIGNED` to background (line 4083, fire-and-forget), which calls `postBuy()` with a *different* idempotency key. Every buy hits the API twice. Second call either fails (quote consumed) or creates a duplicate order.
- **Fix:** Remove the `SHEET_SIGNED` -> `postBuy` path in background. Background should only update local state / badge, not re-submit.

### 3. Extension: SHEET_SIGNED schema missing quoteId
- **Where:** `apps/extension/src/content/messages.ts:10`
- **What:** `SheetSignedMessageSchema` does not declare `quoteId`. Sheet sends it (line 4091), background's `SheetSignedExtendedSchema` requires it. Works only because Zod passthrough mode keeps undeclared fields. Enabling `strict()` would break the background handler.
- **Fix:** Add `quoteId: z.string()` to `SheetSignedMessageSchema`.

### 4. Extension: Fund button triggers impossible buy
- **Where:** Extension popup HomeTab quick actions (line ~2890)
- **What:** Fund button calls `handleBuyFromHome('USDC')`. USDC is not in the API's `ASSET_IDS` or `REF_POOL_IDS` maps. Server returns "unsupported asset" which surfaces as "This asset isn't available yet." Fund should deposit USDC into the account, not buy USDC with USDC.
- **Fix:** Wire Fund to a deposit/on-ramp flow, not the buy screen.

### 5. Extension + API: BTC in registry, missing from API
- **Where:** `apps/extension/src/content/registry.ts:5` vs `services/api/src/routes/quotes.ts:13`
- **What:** Extension `SUPPORTED_TICKERS` includes `'BTC'`. API `ASSET_IDS` only has ETH and SOL. Any BTC buy attempt from the extension chips will fail with "unsupported asset."
- **Fix:** Either add BTC to `ASSET_IDS` + `REF_POOL_IDS` + `TESTNET_TOKEN_OUT` + `TOKEN_DECIMALS`, or remove BTC from `SUPPORTED_TICKERS` until the pool exists.

### 6. API: SOL pool_id = -1
- **Where:** `services/api/src/routes/quotes.ts:25`
- **What:** SOL is in `ASSET_IDS` (has a token address) but `REF_POOL_IDS` has `pool_id = -1`. The draft-quote endpoint checks for -1 and returns "asset not available." SOL appears buyable in the UI but fails at quote time.
- **Fix:** Deploy a testnet Ref Finance SOL pool or guard the UI to show SOL as "coming soon."

---

## P1 — FAKE (renders UI, does nothing on interaction)

### 7. Web: Send button (Home + Portfolio)
- **Where:** `apps/web/src/screens/Home.tsx:72`, `apps/web/src/screens/Portfolio.tsx:152`
- **What:** `action: null`, disabled, "Coming soon" label. No handler, no API, no send flow exists anywhere.
- **Fix:** Build send flow (recipient input, amount, WebAuthn sign, relay) or remove from UI.

### 8. Web: Buy button (Home + Portfolio)
- **Where:** `apps/web/src/screens/Home.tsx:73`, `apps/web/src/screens/Portfolio.tsx:152`
- **What:** `action: null`, disabled, "Coming soon" label. Extension has buy; web does not. No web buy screen exists.
- **Fix:** Port extension buy flow to web, or remove from UI.

### 9. Web: Markets section — all prices are placeholders
- **Where:** `apps/web/src/screens/Home.tsx:151`
- **What:** Renders 4 market rows (ETH, BTC, SOL, NEAR) with em-dash placeholders for every price. No price API call. Static "Prices unavailable" text. Purely decorative.
- **Fix:** Wire to Pyth or CoinGecko price feed, or remove section.

### 10. Web: Add Passkey button (Settings)
- **Where:** `apps/web/src/screens/Settings.tsx:149`
- **What:** Permanently disabled, "Coming soon." No implementation to register additional passkeys.
- **Fix:** Call WebAuthn `navigator.credentials.create()` + `POST /v1/accounts/:id/credentials` (if endpoint exists) or build it.

### 11. Web: Notifications toggle (Settings)
- **Where:** `apps/web/src/screens/Settings.tsx:179`
- **What:** Static div, opacity-40, cursor-not-allowed, "Coming soon." No state, no handler, no notification system.
- **Fix:** Build push notification subscription or remove toggle.

### 12. Web: Terms link (Settings)
- **Where:** `apps/web/src/screens/Settings.tsx:207`
- **What:** `<span>` with underline + cursor-pointer but no `onClick` and no `href`. Click does nothing. No terms page exists.
- **Fix:** Create `/terms` page or link to hosted doc.

### 13. Web: Privacy link (Settings)
- **Where:** `apps/web/src/screens/Settings.tsx:208`
- **What:** Same as Terms — styled as link, no handler, no destination.
- **Fix:** Create `/privacy` page or link to hosted doc.

### 14. Web: Price history chart (PositionDetail)
- **Where:** `apps/web/src/screens/PositionDetail.tsx:82`
- **What:** Static card saying "Price history coming soon" with descriptive text. No chart, no data, no API call.
- **Fix:** Wire to portfolio-history endpoint (exists at `GET /v1/accounts/:id/portfolio-history`) or Pyth historical prices.

### 15. Extension: Settings — Add Passkey button missing
- **Where:** Extension popup SettingsTab Security card (line ~3642)
- **What:** No "Add Passkey" button exists. Security section only shows a static "Passkey" badge. No way to add additional passkeys post-setup.
- **Fix:** Add button that triggers `navigator.credentials.create()` + registers new credential with API.

### 16. Extension: Settings — Copy Account ID missing
- **Where:** Extension popup SettingsTab Account card (line ~3571)
- **What:** Account ID shown as truncated text with no tap-to-copy. Copy button exists only in TopHeaderBar (copies address). No way to copy account ID from Settings.
- **Fix:** Add a copy-to-clipboard handler on the Account ID text or a dedicated copy icon.

### 17. Web: ActivityFeed uses hardcoded mock transactions
- **Where:** `apps/web/src/components/ActivityFeed.tsx:55, 319`
- **What:** `MOCK_TRANSACTIONS` array is always used. Comment says "API NEEDED: GET /v1/accounts/:account_id/transactions." `handleRefresh` is a TODO that just sleeps 800ms. No server endpoint exists.
- **Fix:** Build `GET /v1/accounts/:id/transactions` endpoint, wire ActivityFeed to call it.

### 18. Web: Activity screen reverse-engineers fake events
- **Where:** `apps/web/src/screens/Activity.tsx:6`
- **What:** Has "TODO: Replace with /v1/accounts/:id/transactions when available." Invents activity events from position data (e.g., subtracting 1 day from `protected_until` for timestamps). No real transaction history.
- **Fix:** Same as #17 — wire to real transactions endpoint once built.

### 19. Web: PnLChart uses random-walk mock data
- **Where:** `apps/web/src/components/PnLChart.tsx:33`
- **What:** `generateMockData()` produces random walk data for all time ranges (1D/1W/1M/ALL). Server has a portfolio-history endpoint but PnLChart never calls it. Comments document API endpoints "not yet implemented." Chart is entirely for show.
- **Fix:** Wire to `GET /v1/accounts/:id/portfolio-history` (exists but lacks range filtering — extend server endpoint, then call from PnLChart).

### 20. API: Suggestions route not registered
- **Where:** `services/api/src/routes/suggestions.ts` (file exists) vs `services/api/src/app.ts` (not imported)
- **What:** `registerSuggestionsRoutes` is never called in `app.ts`. Route only works in tests. In production, `GET /v1/suggestions` returns 404. Web client's `getSuggestions()` silently falls back to hardcoded defaults, masking the bug.
- **Fix:** Add `import { registerSuggestionsRoutes } from './routes/suggestions.js'` and call it in `app.ts`.

---

## P2 — STUBBED (partially works, incomplete)

### 21. Extension: Home position row tap — no detail view
- **Where:** Extension popup HomeTab position rows (line ~2949)
- **What:** `onTap` calls `onSwitchTab('portfolio')` for every row regardless of which position was tapped. No position detail screen exists in the extension. Tap navigates to Portfolio tab generically.
- **Fix:** Build a PositionDetail view in the extension, or open the web PositionDetail URL.

### 22. Extension: Dead tooltip state code (PortfolioTab)
- **Where:** Extension popup PortfolioTab (line ~3131)
- **What:** `closeTooltipId` state, auto-dismiss effect (lines 3214-3217), and `showTooltip` computation (line 3265) are dead code. The "Coming soon" tooltip JSX was removed but its state management was left behind.
- **Fix:** Delete `closeTooltipId` state, the `useEffect`, and the `showTooltip` computation.

### 23. Extension: Console.log debug statements in PortfolioTab
- **Where:** Extension popup PortfolioTab useEffect (lines ~3186-3200)
- **What:** Five `console.log` statements leaking to production. Not user-facing but indicates incomplete cleanup.
- **Fix:** Remove or gate behind `__DEV__`.

### 24. Web: PnLChart component is dead code
- **Where:** `apps/web/src/components/PnLChart.tsx`
- **What:** Never imported or rendered by any screen (confirmed via grep). Uses `generateMockData()`. Completely unused.
- **Fix:** Delete file, or wire into a screen once mock data is replaced with real API calls.

---

## P3 — DISABLED (intentionally off, should be enabled eventually)

### 25. Extension: Send button (HomeTab)
- **Where:** Extension popup HomeTab quick actions (line ~2903)
- **What:** Explicitly disabled with opacity 0.7, cursor: not-allowed, "Soon" badge. No onClick. Intentional placeholder.
- **Fix:** Build send flow when ready, then enable.

---

## P4 — DEAD CODE (no user impact, cleanup needed)

### 26. Extension: chip.ts (Shadow DOM custom element)
- **Where:** `apps/extension/src/content/chip.ts`
- **What:** `FloorsBuyChip` class with `defineFloorsBuyChip()`, never imported. Active content script creates plain divs. Entire file is dead code.
- **Fix:** Delete file.

### 27. Extension: background/index.ts (duplicate background script)
- **Where:** `apps/extension/src/background/index.ts`
- **What:** Full duplicate of `src/entrypoints/background.ts` with different API (chrome.* vs WXT browser.*). WXT only bundles the entrypoints version. Will drift and confuse developers.
- **Fix:** Delete file.

### 28. Extension: content/index.ts (duplicate content script)
- **Where:** `apps/extension/src/content/index.ts`
- **What:** Older copy of `src/entrypoints/content.ts`. WXT build ignores it. Dead code.
- **Fix:** Delete file.

---

## Summary

| Priority | Count | Category |
|----------|-------|----------|
| P0 | 6 | BROKEN — errors at runtime |
| P1 | 14 | FAKE — UI present, no function |
| P2 | 4 | STUBBED — partially works |
| P3 | 1 | DISABLED — intentional placeholder |
| P4 | 3 | DEAD CODE — cleanup |
| **Total** | **28** | |

### Highest-impact fixes (address first)

1. **#1 Actions endpoint mismatch** — sell-to-floor/close completely broken on web
2. **#2 Double-submit** — every extension buy hits API twice, risk of duplicate orders
3. **#5 BTC missing from API** — extension shows BTC chips that always fail
4. **#20 Suggestions route not registered** — 404 in production, silently masked
5. **#4 Fund = buy USDC** — wrong semantics, confusing UX
6. **#17-19 Mock data triad** — ActivityFeed, Activity screen, PnLChart all showing fake data
