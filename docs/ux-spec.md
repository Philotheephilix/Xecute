# Floors UX Specification v2.0

Complete screen architecture, navigation, data requirements, and user journeys for the Floors crypto trading app redesign. Replaces the current single-destination Portfolio screen with a full-featured post-onboarding experience.

**Status**: Implementation-ready specification
**Stack**: React + TypeScript + Tailwind CSS, Preact (extension sheet)
**Design System**: Neo-brutalist (thick borders, shadows, bold colors)

---

## Table of Contents

1. [Navigation Architecture](#1-navigation-architecture)
2. [Screen Inventory](#2-screen-inventory)
3. [User Flows](#3-user-flows)
4. [Component Library](#4-component-library)
5. [Extension Popup Spec](#5-extension-popup-spec)
6. [Data Requirements](#6-data-requirements)
7. [Design Tokens](#7-design-tokens)

---

## 1. Navigation Architecture

### 1.1 App Phases

The app operates in two distinct phases, governed by `AppPhase` in `AppContext.tsx`:

```
Phase 1: ONBOARDING (linear wizard, no bottom nav)
  welcome > sign-in > invite-code > create-passkey > creating-account >
  account-ready > setup-defaults > enable-trading > fund

Phase 2: MAIN (bottom nav, tab-based)
  home | portfolio | activity | settings
  Each tab can push sub-screens (position-detail, fund-account, etc.)
```

Transition from Phase 1 to Phase 2 occurs when the user completes onboarding (reaches the end of the `fund` screen or returns via `sign-in`). The `AppContext` holds the current phase and all shared state.

### 1.2 Bottom Navigation Bar (4 Tabs)

The bottom nav appears on ALL post-onboarding screens. It is a fixed bar at the bottom of the viewport.

| Position | Tab ID | Label | Icon (Active) | Icon (Inactive) | Badge |
|----------|--------|-------|---------------|-----------------|-------|
| 1 | `home` | Home | House filled `#EF7B28` | House outline `#111` | None |
| 2 | `portfolio` | Portfolio | Chart-rect filled `#EF7B28` | Chart-rect outline `#111` | Position count (number) |
| 3 | `activity` | Activity | Clock-circle filled `#EF7B28` | Clock-circle outline `#111` | Pending tx count (dot) |
| 4 | `settings` | Settings | Gear filled `#EF7B28` | Gear outline `#111` | None |

**Existing implementation**: `src/components/BottomNav.tsx` -- already built with all four tabs, badge support, active indicator dot. Uses `Tab` type from `AppContext.tsx`.

**Navigation behavior**:
- Tapping active tab scrolls to top
- Tapping inactive tab switches with no transition animation (instant swap)
- Sub-screens (position-detail, fund-account) slide in from right, hide bottom nav
- Back gesture/button from sub-screen reveals bottom nav again

**Layout spec**:
```css
.bottom-nav {
  position: fixed;
  bottom: 0;
  left: 0; right: 0;
  height: 56px;
  background: #FAF9F6;
  border-top: 2px solid #111;
  display: flex;
  z-index: 50;
  padding-bottom: env(safe-area-inset-bottom);
}
```

### 1.3 Screen Hierarchy

```
main/
  home/
    [home-overview]              ← default screen for Home tab
  portfolio/
    [portfolio-overview]         ← default screen for Portfolio tab
    position-detail/:floorId     ← sub-screen, slides in from right
    fund-account                 ← sub-screen, reuses Fund screen content
  activity/
    [activity-feed]              ← default screen for Activity tab
    transaction-detail/:txId     ← sub-screen (future: when API returns tx data)
  settings/
    [settings-main]              ← default screen for Settings tab
    settings-floor-defaults      ← sub-screen (future: inline edit)
```

---

## 2. Screen Inventory

### 2.1 Onboarding Screens (Phase 1 -- Unchanged)

These screens use the existing linear `Screen` type from `App.tsx` with slide transitions. No bottom nav. No changes needed except the final destination: instead of navigating to the old `portfolio` screen, onboarding completion should transition to `Phase 2: main` with `tab: 'home'`.

| Screen | File | Purpose | Exit Condition |
|--------|------|---------|----------------|
| `welcome` | `Welcome.tsx` | Landing. "Get Started" + "Sign in" | User taps CTA |
| `sign-in` | `SignIn.tsx` | Pick saved passkey, sign challenge | Auth success -> Phase 2 |
| `invite-code` | `InviteCode.tsx` | 8-char code entry (when `VITE_REQUIRE_INVITE=true`) | Valid code |
| `create-passkey` | `CreatePasskey.tsx` | Name input + WebAuthn create | Passkey created |
| `creating-account` | `CreatingAccount.tsx` | Poll until account on-chain | Account confirmed |
| `account-ready` | `AccountReady.tsx` | Show address, 3 CTAs | User taps any CTA |
| `setup-defaults` | `SetupDefaults.tsx` | Floor protection defaults | User saves or skips |
| `enable-trading` | `EnableTrading.tsx` | Register passkey with NEAR Intents | Done or skipped |
| `fund` | `Fund.tsx` | Show deposit addresses | User taps "Open Portfolio" or "Done" |

**Key change**: `AccountReady.tsx` CTAs should route to:
- "Set Up Trading" -> `setup-defaults` (existing)
- "Fund Your Account" -> `fund` (existing)
- "Open Portfolio" -> Phase 2 `main` with `tab: 'home'`

### 2.2 Home Tab (`home`)

**File**: `src/screens/Home.tsx` (exists, needs wiring to bottom nav)

**Purpose**: Dashboard overview. Greets user, shows balance summary, active floors at a glance, market prices placeholder, and quick actions.

**Layout (top to bottom)**:

#### 2.2.1 Header Row (sticky, 56px)
- Left: "Floors" logo text (20px extrabold `#111`)
- Right: Avatar circle (40x40, `#EF7B28` bg, `#111` border, neo-shadow)
- Background: `#FAF9F6`

#### 2.2.2 Balance Summary Card
- White card, `border-2 border-[#111]`, `rounded-[18px]`, `shadow-neo`, padding 20px
- Label: "USDC BALANCE" (12px extrabold gray-500 uppercase)
- Value: `$XX.XX` (36px extrabold `#111`, tabular-nums)
- Sub-value: `X.XX NEAR` (14px semibold gray-400) -- only if near_balance present
- **Data**: `getPositions(accountId)` returns `usdc_balance` and `near_balance`

#### 2.2.3 Quick Action Pills (3-column grid)
- Fund: active, navigates to fund-account sub-screen
- Send: disabled, "Coming soon" badge
- Buy: disabled, "Coming soon" badge
- Each: 88px tall, white bg, neo border/shadow, icon + label + optional badge

#### 2.2.4 Active Floors Summary
- Section header: "Your Floors" (16px extrabold) + "View all ->" link (navigates to Portfolio tab)
- Shows top 3 active positions as condensed rows:
  - `{amount} {asset}` | `Floor $X.XX` | `Xd left` badge
- Empty state: card with lightning icon + "Get Started" + "Buy with Floor" CTA
- **Data**: `positions.filter(p => p.status === 'active').slice(0, 3)` from AppContext

#### 2.2.5 Markets Section (placeholder)
- Section header: "Markets"
- List of ETH, BTC, SOL, NEAR with colored circle icons
- Price: "--" placeholder (prices unavailable until `GET /v1/prices/current` exists)
- **Data needed (future)**: `GET /v1/prices/current?assets=ETH,BTC,SOL,NEAR`

### 2.3 Portfolio Tab (`portfolio`)

**File**: `src/screens/Portfolio.tsx` (exists, needs significant refactoring)

**Purpose**: Full portfolio view with PnL chart, position list with rich cards, and total value.

**Layout (top to bottom)**:

#### 2.3.1 Top Bar (sticky, 56px)
- Center: "Portfolio" text (16px extrabold)
- Background: `#FAF9F6`

#### 2.3.2 PnL Chart Component
- **Component**: `src/components/PnLChart.tsx` (exists, fully built)
- White card with neo styling
- Portfolio value header: `$XX.XX` (30px extrabold)
- Change indicator: `+$X.XX (+X.XX%)` green/red
- Time range selector: 1D | 1W | 1M | ALL (pill toggles)
- SVG line chart with gradient fill, hover/touch crosshair
- **Data**: Currently uses mock data generator. Needs `GET /v1/accounts/:id/portfolio-history?range=1D|1W|1M|ALL`
- **Fallback**: Until API exists, show mock data with "Sample data" label

#### 2.3.3 USDC Balance Card
- Same as Home tab balance card but more compact (inline with positions section)
- Shows USDC balance prominently

#### 2.3.4 Positions List
- Section header: "Your Floors" + position count badge
- Uses `PositionCard` component (exists at `src/components/PositionCard.tsx`) for each position
- Each card shows:
  - Asset icon (colored square, 40x40) + name + quantity + current value
  - Floor price with shield icon
  - Unrealized PnL (green/red) when `current_price_usd` available
  - Expiry countdown with urgency styling (orange <24h, red <1h)
  - Progress bar (time elapsed / total duration)
  - Action buttons: "Sell to Floor" (green) + "Close" (white) for active positions
- Tapping a card navigates to `position-detail` sub-screen
- Empty state: "No floors yet" card with "Fund Account" CTA
- **Data**: `positions` from AppContext + action handlers via `getActionChallenge` + `submitAction`

#### 2.3.5 Position Detail Sub-Screen
- **File**: `src/screens/PositionDetail.tsx` (exists, fully built)
- Slides in from right, hides bottom nav
- Back button returns to portfolio list
- Shows: asset info card, floor protection card, timing card with progress bar, action buttons, transaction history timeline
- **Data**: Fetches from `getPositions()` and filters by `floorId`

### 2.4 Activity Tab (`activity`)

**File**: `src/screens/Activity.tsx` (exists, fully built)

**Purpose**: Chronological feed of all transactions grouped by date.

**Layout (top to bottom)**:

#### 2.4.1 Header (sticky)
- Center: "Activity" (20px extrabold)
- Filter pills: All | Floors | Swaps | Funding (horizontal scroll)
- Active filter: `#EF7B28` bg, white text
- Inactive filter: white bg, gray-500 text
- Background: `#FAF9F6` with bottom border

#### 2.4.2 Date-Grouped Event List
- Groups: "Today", "Yesterday", "Mon DD" for older
- Each group is a white card with divided rows
- Each row:
  - Left: Colored icon circle (36px) with event type icon
  - Center: Description text (14px extrabold) + status dot + relative timestamp (11px)
  - Right: Amount string (14px bold)
- Event types with icons/colors:

| Type | Icon | Background | Description Pattern |
|------|------|------------|-------------------|
| `floor_opened` | Shield | `#EF7B28` | "Floor opened on 0.005 ETH" |
| `sold_to_floor` | Down arrow | `#29CEB4` | "Sold to floor -- received $X USDC" |
| `floor_closed` | X circle | gray-400 | "Floor closed -- 0.005 ETH returned" |
| `floor_expired` | Clock | gray-400 | "Floor expired -- 0.005 ETH returned" |
| `buy_swap` | Cart | `#29CEB4` | "Bought 0.005 ETH" |
| `fund` | Plus | `#9662FF` | "Deposited $50 USDC" |

- Empty state: Clock icon + "No activity yet" + "Your trades and floor events will appear here" + "Buy with Floor" CTA
- **Data source (current)**: Derived from positions via `buildActivityFromPositions()` -- creates synthetic events from position state
- **Data source (future)**: `GET /v1/accounts/:id/transactions?cursor=&limit=20` -- aggregates from buy_submissions, contract events, ft_transfers

#### 2.4.3 Pull-to-Refresh
- Built into `ActivityFeed` component (exists in `src/components/ActivityFeed.tsx`)
- Touch start at scrollTop=0, drag down 60px threshold
- Shows spinner during refresh
- Currently a no-op; will call transactions API when available

### 2.5 Settings Tab (`settings`)

**File**: `src/screens/Settings.tsx` (exists, fully built)

**Purpose**: Account info, passkey management, preferences, sign out.

**Layout (top to bottom)**:

#### 2.5.1 Header
- Center: "Settings" (16px extrabold)

#### 2.5.2 Account Card
- Avatar circle (56px, `#EF7B28`)
- Account ID (truncated with copy button)
- "Created via {passkeyName}" subtitle
- Copy button with checkmark confirmation

#### 2.5.3 Passkeys Section
- Lists all registered passkeys from `localStorage['floors:passkeys']`
- Each: name + truncated credential ID + created date
- "Add Passkey" button (disabled, "Coming soon")

#### 2.5.4 Preferences Section
- Floor protection default: `X.X%` (read from `localStorage['floors:floor_defaults']`)
- Duration default: `X days`
- Notifications toggle (disabled, "Coming soon")

#### 2.5.5 Sign Out Button
- Red outlined button
- Clears all `floors:*` localStorage keys
- Returns to Welcome screen (Phase 1)

#### 2.5.6 App Info
- "Floors v0.1.0" + "Testnet" badge
- Terms + Privacy links

---

## 3. User Flows

### 3.1 New User Onboarding

```
1. User visits app URL
2. Welcome screen -> "Get Started"
3. [If VITE_REQUIRE_INVITE=true] Invite Code entry
4. Create Passkey: name input + WebAuthn fingerprint
5. Creating Account: spinner polling API until on-chain
6. Account Ready: copy address, 3 CTAs
7. Setup Defaults: floor protection % + duration
8. Enable Trading: register with NEAR Intents
9. Fund: show deposit addresses
10. -> Phase 2: Home tab (bottom nav visible)
```

### 3.2 Returning User Sign-In

```
1. App loads, detects floors:account_id in localStorage
2. -> Sign-In screen (lists saved passkeys)
3. User picks passkey, signs random challenge
4. Auth success -> Phase 2: Home tab
```

### 3.3 Buying via Extension (X.com)

```
1. User browses X, sees post mentioning $ETH
2. Content script injects <floors-chip> after cashtag link
3. User clicks "Buy $ETH" chip
4. bridge.content.ts forwards OPEN_SHEET to background
5. background.ts opens sheet.html popup window (412x680)
6. Sheet reads chrome.storage.local for account data
7a. [No account] -> Onboarding screen -> "Create Wallet" opens web app
7b. [Multiple passkeys] -> Passkey picker screen
7c. [Single passkey] -> Buy screen
8. Fetches draft quote: GET /v1/quotes/draft?asset=ETH&usd=10
9. Displays WYSIWYS quote card + floor protection toggle
10. User configures floor (OFF/5%/10%, 30d/90d/180d)
11. User taps "Confirm with Passkey"
12. WYSIWYS verification: verifyAgainstSheet checks payload matches display
13. SHA-256 challenge from quote data, WebAuthn sign
14. POST /v1/submit with signed assertion
15. SSE tracking: GET /v1/status/:id/stream
16. -> Success (with floor badge) | Partial (swap ok, floor failed) | Error
17. Success: "View in Portfolio" -> closes popup
```

### 3.4 Managing a Position (Portfolio)

```
1. User navigates to Portfolio tab
2. PnL chart shows portfolio value over time
3. Position cards list all floors
4. User taps a position card -> Position Detail sub-screen
5a. "Sell to Floor": challenge -> sign -> submit -> refresh
5b. "Close Position": challenge -> sign -> submit -> refresh
6. Back button returns to Portfolio tab
```

### 3.5 Viewing Activity

```
1. User navigates to Activity tab
2. Sees date-grouped transaction feed
3. Filter pills narrow to: All | Floors | Swaps | Funding
4. Pull-to-refresh reloads data
5. [Future] Tapping a completed transaction opens explorer link
```

### 3.6 Funding Account

```
1. From Home tab "Fund" pill, or Portfolio empty state CTA
2. Opens fund-account sub-screen (reuses Fund.tsx content)
3. Shows NEAR deposit address + copy button
4. Lists chains: NEAR, Ethereum, Base, Arbitrum, Solana
5. User copies address, sends USDC externally
6. Back button returns to previous tab
```

---

## 4. Component Library

### 4.1 Existing Components (Built, Ready to Wire)

| Component | File | Props | Notes |
|-----------|------|-------|-------|
| `BottomNav` | `components/BottomNav.tsx` | `activeTab, onTabChange, positionCount?, pendingTxCount?` | 4-tab nav, badges, active indicator |
| `PnLChart` | `components/PnLChart.tsx` | `data?, currentValue?` | SVG line chart, time range selector, hover/touch |
| `ActivityFeed` | `components/ActivityFeed.tsx` | `accountId?, transactions?, limit?, onTransactionTap?` | Pull-to-refresh, expandable, mock data fallback |
| `PositionCard` | `components/PositionCard.tsx` | `position, onSellToFloor?, onClose?, actionLoading?` | Rich card: icon, PnL, countdown, progress bar, actions |

### 4.2 Existing Screens (Built, Need Wiring to Tab System)

| Screen | File | Status | Integration Work |
|--------|------|--------|-----------------|
| `Home` | `screens/Home.tsx` | Built | Wire to `useApp()` context instead of local state |
| `Portfolio` | `screens/Portfolio.tsx` | Built (old) | Refactor to use `PositionCard` component + `PnLChart` |
| `Activity` | `screens/Activity.tsx` | Built | Already uses `useApp()` context |
| `Settings` | `screens/Settings.tsx` | Built | Wire sign-out to `useApp().signOut()` |
| `PositionDetail` | `screens/PositionDetail.tsx` | Built | Wire as sub-screen via `pushSubScreen` |

### 4.3 Shared UI Primitives

#### Neo Card
```tsx
<div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo p-5">
  {children}
</div>
```
Variants: `shadow-neo` (large), `shadow-neo-sm` (small), no shadow (flat).

#### Neo Button
```tsx
<button className="h-[44px] bg-[#EF7B28] text-white border-2 border-[#111] rounded-[13px] text-sm font-extrabold shadow-neo-sm shadow-neo-active">
  {label}
</button>
```
Colors: Orange primary (`#EF7B28`), Green success (`#29CEB4`), White secondary, Purple accent (`#9662FF`).

#### Status Badge
```tsx
<span className="px-2 py-0.5 rounded-full text-[11px] font-extrabold bg-[#29CEB4] text-[#111] border border-[#111]">
  ACTIVE
</span>
```
Variants: Active (green), Expired (gray-200), Closed (orange).

#### Section Header
```tsx
<div className="flex items-center justify-between">
  <span className="text-base font-extrabold text-[#111]">{title}</span>
  <button className="text-xs font-extrabold text-[#EF7B28]">{action} &rarr;</button>
</div>
```

#### Loading Spinner
```tsx
<span className="w-4 h-4 border-2 border-[#111] border-t-transparent rounded-full animate-spin" />
```

#### Empty State
```tsx
<div className="bg-white border-2 border-[#111] rounded-[18px] shadow-neo-sm p-6 flex flex-col items-center gap-3 text-center">
  <div className="w-12 h-12 bg-[#FAF9F6] border-2 border-[#111] rounded-[13px] flex items-center justify-center">
    {icon}
  </div>
  <p className="text-sm font-extrabold text-[#111]">{title}</p>
  <p className="text-xs font-semibold text-gray-500">{subtitle}</p>
  <button className="...">{cta}</button>
</div>
```

#### Filter Pills (horizontal scroll)
```tsx
<div className="flex gap-2 overflow-x-auto no-scrollbar">
  {filters.map(f => (
    <button className={`px-4 py-1.5 rounded-full border-2 border-[#111] text-sm font-extrabold whitespace-nowrap ${
      active ? 'bg-[#EF7B28] text-white' : 'bg-white text-gray-500'
    }`}>
      {f.label}
    </button>
  ))}
</div>
```

---

## 5. Extension Popup Spec

### 5.1 Current Architecture

The extension (`apps/extension`) consists of:
- **Content script** (`content.ts`): Runs in MAIN world on x.com, injects `<floors-chip>` shadow elements after cashtag links
- **Bridge script** (`bridge.content.ts`): Runs in isolated world, forwards `window.postMessage` to `chrome.runtime` and syncs localStorage
- **Background** (`background.ts`): Service worker, handles `OPEN_SHEET`, `GET_REGISTRY`, `SYNC_STORAGE`, `SHEET_SIGNED` messages
- **Sheet popup** (`sheet/index.tsx`): Preact app in a popup window (412x680), handles the full buy flow

### 5.2 X.com Cashtag Detection

**How it works**:
1. Content script observes DOM via `MutationObserver` on `document.body` (subtree + childList)
2. Scans for `a[data-testid="cashtag"]` elements (X's DOM attribute for cashtag links)
3. Parses ticker from href: `/search?q=%24ETH&src=cashtag_click` -> `ETH`
4. Validates against `SUPPORTED_TICKERS` set: `{'ETH', 'SOL'}` (in `registry.ts`)
5. Creates `FloorsBuyChip` custom element with closed shadow root
6. Inserts chip after the cashtag anchor
7. `WeakMap` prevents duplicate injection on same anchor

**Chip behavior**: On click, dispatches `window.postMessage({__floors__: true, type: 'OPEN_SHEET', ticker, postId})`. Bridge picks up and forwards to background which opens the sheet popup.

**Detection accuracy**: See `docs/adr/0006-x-detection-accuracy.md`. The `data-testid="cashtag"` selector is reliable on X's current DOM structure. Post ID extraction traverses up to `[data-testid="tweet"]` ancestor, then finds `a[href*="/status/"]`.

**To add new tickers**: Add to `SUPPORTED_TICKERS` in `registry.ts` and the `S4_REGISTRY` in `background.ts`.

### 5.3 Sheet Popup Screens

The sheet popup (`sheet/index.tsx`) runs as a standalone Preact app with inline styles (not Tailwind). Screen flow:

```
[Storage loading] -> LoadingSpinner

[No account] -> OnboardingScreen
  "Create Wallet" button opens web app in new tab

[Multiple passkeys] -> PasskeyPickerScreen
  Lists passkeys with "Use" buttons, purple header

[Single passkey or passkey selected] -> BuyScreen
  Orange header: "Buy $ETH"
  WYSIWYS quote card (Buying, Paying, Quote expires)
  Floor Protection row (OFF/5%/10% + 30d/90d/180d toggles)
  "Confirm with Passkey" button

[After confirm] -> SigningScreen
  Spinner + "Submitting order..."

[SSE: done] -> SuccessScreen
  Green check + "Bought X ETH. Protected." + floor badge
  Order details card
  "View in Portfolio" button (closes popup)

[SSE: partial] -> PartialScreen
  Orange warning + "Partially Completed"
  Swap success row + Floor failure row with reason
  Three CTAs: "Try the floor again" / "Keep without floor" / "Swap back to USDC"

[SSE: failed or error] -> ErrorScreen
  "Order Failed" + error message + "Try Again"
```

### 5.4 Extension Setup & Account Sync

The extension popup cannot access the web app's localStorage (different origins). The sync mechanism:

1. `bridge.content.ts` runs on the web app domain (`localhost:5173`)
2. Reads `floors:*` keys from localStorage
3. Sends `SYNC_STORAGE` message to background
4. Background writes allowed keys to `chrome.storage.local`
5. Sheet popup reads from `chrome.storage.local` on mount

**Synced keys**: `floors:account_id`, `floors:credential_id`, `floors:public_key`, `floors:compressed_key`, `floors:floor_defaults`, `floors:passkeys`

### 5.5 Extension-Driven Onboarding (Requested Feature)

**Current**: If no account exists when the sheet opens, it shows an onboarding screen with "Create Wallet" that opens the web app in a new tab.

**Target**: The entire onboarding flow (create passkey, create account, enable trading, set defaults) should be doable within the extension popup itself, without opening a separate page.

**Implementation approach**:
1. Add onboarding screens to the sheet popup (Preact versions of the web app screens)
2. Reuse the same API endpoints (`POST /v1/accounts`, `POST /v1/relay/enable-trading`)
3. WebAuthn `navigator.credentials.create()` works in the extension popup context
4. After account creation, write to `chrome.storage.local` directly (no bridge needed)
5. Transition to buy screen after onboarding completes

**Screens to add to sheet popup**:
- `create-passkey-popup`: Name input + WebAuthn create (simplified)
- `creating-account-popup`: Polling spinner
- `setup-defaults-popup`: Floor % + duration picker (condensed)
- `enable-trading-popup`: Auto-register with NEAR Intents

---

## 6. Data Requirements

### 6.1 Available API Endpoints

| Endpoint | Method | Status | Returns |
|----------|--------|--------|---------|
| `/v1/accounts` | POST | Working | `{ account_id, created }` |
| `/v1/accounts/:id` | GET | Working | `{ account_id, public_key, status }` |
| `/v1/accounts/:id/positions` | GET | Working | `{ positions[], near_balance, usdc_balance }` |
| `/v1/accounts/:id/deposit-addresses` | GET | Working (fallback) | `{ addresses[] }` |
| `/v1/accounts/:id/enable-trading-request` | POST | Working | `{ wallet_request, challenge }` |
| `/v1/accounts/:id/actions` | POST | Working | `{ wallet_request, challenge }` |
| `/v1/actions` | POST | Working | `{ status_id }` |
| `/v1/quotes/draft` | GET | Working | `{ quote_id, asset, pay_usdc, est_qty, display, floor_price_e6?, fee_usdc? }` |
| `/v1/quotes` | POST | Working | `{ quote, sig }` |
| `/v1/submit` | POST | Working | `{ status_id }` |
| `/v1/status/:id/stream` | GET (SSE) | Working | Events: `{ state, tx_hash, type?, floor_error?, actual_qty?, floor_id? }` |
| `/v1/suggestions` | GET | Working | `{ floor_bps, duration_secs }` |
| `/v1/invites/validate` | POST | Working | `{ valid: true }` |
| `/v1/relay/enable-trading` | POST | Working | `{ tx_hash }` |

### 6.2 Needed API Endpoints (Not Yet Implemented)

| Endpoint | Method | Purpose | Priority |
|----------|--------|---------|----------|
| `/v1/accounts/:id/transactions` | GET | Activity feed data | High |
| `/v1/accounts/:id/portfolio-history` | GET | PnL chart data | Medium |
| `/v1/prices/current` | GET | Live market prices | Medium |
| `/v1/prices/history` | GET | Asset price charts | Low |

#### 6.2.1 Transactions Endpoint Spec

```
GET /v1/accounts/:account_id/transactions?cursor=<string>&limit=20

Response: {
  transactions: Array<{
    id: string;
    type: 'buy' | 'floor_opened' | 'sell_to_floor' | 'close' | 'expire' | 'fund';
    asset: string;
    amount: string;
    usd_value?: string;
    timestamp: string;       // ISO 8601
    status: 'pending' | 'completed' | 'failed';
    tx_hash?: string;
    metadata?: {
      floor_price_usd?: number;
      fee_usdc?: string;
    };
  }>,
  cursor?: string;
  has_more: boolean;
}
```

Data sources to aggregate:
- `api.buy_submissions` table (buy, floor_opened events)
- Contract events: FloorOpened, FloorSold, FloorClosed, FloorExpired (via indexer)
- On-chain `ft_transfer` events (fund events)
- `relayer.swap_intents` table (buy completion)

#### 6.2.2 Portfolio History Endpoint Spec

```
GET /v1/accounts/:account_id/portfolio-history?range=1D|1W|1M|ALL

Response: {
  points: Array<{ timestamp: number; value: number; }>,
  current_value: number;
}
```

Interval by range: 1D=1h, 1W=4h, 1M=1D, ALL=1D.

Requires the indexer to snapshot portfolio values periodically (position qty * market price + USDC balance at each interval).

#### 6.2.3 Prices Endpoint Spec

```
GET /v1/prices/current?assets=ETH,BTC,SOL,NEAR

Response: {
  prices: {
    ETH: { usd: 3241.50, change_24h: 2.34 },
    BTC: { usd: 97500.00, change_24h: -0.12 },
    ...
  }
}
```

Source: Risk service already fetches from CoinGecko/Pyth for quoting. Expose a cached version.

### 6.3 Position Data Gaps

The `Position` type from `client.ts` currently has:
```typescript
interface Position {
  floor_id: string;
  asset: string;
  amount: string;
  floor_price_usd?: number;
  protected_until?: string;
  status: 'active' | 'expired' | 'closed';
}
```

The `PositionCard` component needs additional fields (defined in `ExtendedPosition`):
- `opened_at: string` -- When the floor was opened (already in DB, not returned by API)
- `current_price_usd: number` -- Current market price of the asset (needs prices endpoint)

**Stopgap**: Until API returns these, `PositionCard` handles missing fields gracefully:
- Missing `opened_at`: progress bar hidden
- Missing `current_price_usd`: PnL section hidden, only shows floor price

### 6.4 Client-Side Data Flow

```
AppContext (src/context/AppContext.tsx)
  |
  |-- account: AccountState | null
  |-- positions: Position[]
  |-- balances: { near: string | null; usdc: string | null }
  |-- refreshPositions(): Promise<void>
  |-- isLoadingPositions: boolean
  |
  |-- switchTab(tab: Tab): void
  |-- pushSubScreen(sub: SubScreen, params?): void
  |-- popSubScreen(): void
  |-- signOut(): void
  |
  Consumed by:
    Home.tsx        -- reads positions, balances
    Portfolio.tsx   -- reads positions, balances, handles actions
    Activity.tsx    -- reads positions (derives events)
    Settings.tsx    -- reads account, calls signOut
    PositionDetail  -- reads positions (filters by floorId)
```

---

## 7. Design Tokens

### 7.1 Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `bg-page` | `#FAF9F6` | Page/screen background |
| `text-primary` | `#111111` | Primary text, borders, icons |
| `brand-orange` | `#EF7B28` | Primary CTA, active tab, brand accent |
| `brand-green` | `#29CEB4` | Success, positive PnL, protection, active status |
| `brand-purple` | `#9662FF` | Secondary accent, fund icon, testnet badge |
| `danger-red` | `#EF4444` | Negative PnL, error states, sign-out |
| `text-secondary` | `#6B7280` | gray-500, secondary text |
| `text-tertiary` | `#9CA3AF` | gray-400, timestamps, disabled |
| `text-quaternary` | `#D1D5DB` | gray-300, placeholders |
| `card-bg` | `#FFFFFF` | Card backgrounds |
| `divider` | `#E5E7EB` | gray-200, dividers, progress bar bg |

### 7.2 Typography

| Token | Value | Usage |
|-------|-------|-------|
| `font-family` | `'Plus Jakarta Sans', system-ui, sans-serif` | All text |
| `font-mono` | `ui-monospace, 'SF Mono', monospace` | Account IDs, hashes |
| `text-hero` | 36px / extrabold (800) | Balance amount |
| `text-value` | 30px / extrabold | Chart value |
| `text-heading` | 20px / extrabold | Screen titles |
| `text-subheading` | 16px / extrabold | Section headers |
| `text-body` | 14-15px / bold-extrabold | Card text, labels |
| `text-caption` | 12-13px / semibold-bold | Secondary info |
| `text-tiny` | 10-11px / semibold-extrabold | Badges, timestamps |

### 7.3 Spacing

| Token | Value | Usage |
|-------|-------|-------|
| `page-px` | 24px (px-6) | Page horizontal padding |
| `card-p` | 20px (p-5) | Card internal padding |
| `card-radius` | 18px (rounded-[18px]) | Card border radius |
| `button-radius` | 13px (rounded-[13px]) | Button border radius |
| `badge-radius` | full (rounded-full) | Badge/pill border radius |
| `pill-radius` | 10px (rounded-[10px]) | Toggle/selector radius |
| `gap-cards` | 20px (gap-5) | Between cards in a section |
| `gap-sections` | 20px (gap-5) | Between sections |
| `gap-items` | 8-12px (gap-2/3) | Between items within a card |

### 7.4 Shadows (Neo-Brutalist)

```css
.shadow-neo {
  box-shadow: 0px 4px 0px #111111;
}
.shadow-neo-sm {
  box-shadow: 0px 2.5px 0px #111111;
}
.shadow-neo-active:active {
  transform: translateY(2px);
  box-shadow: 0px 0.5px 0px #111111;
}
```

### 7.5 Borders

| Token | Value | Usage |
|-------|-------|-------|
| `border-primary` | 2px solid #111 | Cards, buttons, inputs |
| `border-badge` | 1px solid #111 | Badges, small elements |
| `border-divider` | 2px solid #111 | List dividers (divide-y-2 divide-[#111]) |
| `border-separator` | 1.5px solid #E5E7EB | Internal card dividers |

### 7.6 Animations

| Token | Value | Usage |
|-------|-------|-------|
| `spin` | `@keyframes spin { to { transform: rotate(360deg) } }` 0.8s linear infinite | Loading spinners |
| `float` | `@keyframes float { 50% { transform: translateY(-6px) } }` 3s ease-in-out infinite | Welcome badge |
| `screen-transition` | 400ms ease-in-out | Screen slide in/out |
| `button-press` | `transform 0.1s ease, box-shadow 0.1s ease` | Active state |
| `chart-opacity` | `transition-opacity duration-300` | Chart range change |

### 7.7 Z-Index Scale

| Layer | Z-Index | Usage |
|-------|---------|-------|
| Base content | 0 | Normal flow |
| Sticky headers | 10 | Sticky top bars |
| Bottom nav | 50 | Fixed bottom navigation |
| Sub-screen overlay | 40 | Sliding sub-screens |
| Toast/snackbar | 60 | Temporary notifications |
| Modal backdrop | 70 | Future modals |

---

## Appendix A: File Map

### Web App (`apps/web/src/`)

```
App.tsx                         -- Root: Phase 1 screen transitions (MODIFY: add Phase 2 tab routing)
main.tsx                        -- Entry point
context/
  AppContext.tsx                 -- Shared state, tab/sub-screen navigation (EXISTS)
api/
  client.ts                     -- API client: all endpoints (EXISTS)
components/
  BottomNav.tsx                 -- 4-tab bottom navigation (EXISTS)
  PnLChart.tsx                  -- Portfolio value chart (EXISTS)
  ActivityFeed.tsx              -- Transaction feed with pull-to-refresh (EXISTS)
  PositionCard.tsx              -- Rich position card (EXISTS)
screens/
  Welcome.tsx                   -- Onboarding: landing (EXISTS)
  SignIn.tsx                    -- Onboarding: passkey auth (EXISTS)
  InviteCode.tsx                -- Onboarding: invite code (EXISTS)
  CreatePasskey.tsx             -- Onboarding: WebAuthn create (EXISTS)
  CreatingAccount.tsx           -- Onboarding: polling spinner (EXISTS)
  AccountReady.tsx              -- Onboarding: address display (EXISTS)
  SetupDefaults.tsx             -- Onboarding: floor defaults (EXISTS)
  EnableTrading.tsx             -- Onboarding: intents registration (EXISTS)
  Fund.tsx                      -- Onboarding/sub-screen: deposit addresses (EXISTS)
  Home.tsx                      -- Tab: dashboard overview (EXISTS)
  Portfolio.tsx                 -- Tab: positions + chart (EXISTS, REFACTOR)
  Activity.tsx                  -- Tab: transaction feed (EXISTS)
  Settings.tsx                  -- Tab: account + prefs (EXISTS)
  PositionDetail.tsx            -- Sub-screen: single position (EXISTS)
```

### Extension (`apps/extension/src/`)

```
entrypoints/
  content.ts                    -- MAIN world: cashtag detection + chip injection (EXISTS)
  bridge.content.ts             -- Isolated world: message forwarding + storage sync (EXISTS)
  background.ts                 -- Service worker: sheet opening, API calls (EXISTS)
  sheet/
    index.tsx                   -- Buy sheet popup: Preact app (EXISTS)
content/
  chip.ts                       -- FloorsBuyChip custom element (EXISTS)
  index.ts                      -- MutationObserver + anchor processing (EXISTS)
  registry.ts                   -- Supported tickers: ETH, SOL (EXISTS)
  messages.ts                   -- Message type schemas (EXISTS)
  adapter.test.ts               -- Content script tests (EXISTS)
lib/
  webauthn.ts                   -- Passkey signing helpers (EXISTS)
```

---

## Appendix B: Implementation Priority

### Phase 1: Wire Existing Components (No New Code)
1. Modify `App.tsx` to support Phase 2 (tab routing via AppContext)
2. Wire `Home.tsx`, `Portfolio.tsx`, `Activity.tsx`, `Settings.tsx` to tab system
3. Wire `BottomNav.tsx` into the Phase 2 layout
4. Wire `PositionCard.tsx` into `Portfolio.tsx`
5. Wire `PnLChart.tsx` into `Portfolio.tsx`
6. Wire `PositionDetail.tsx` as sub-screen via `pushSubScreen`

### Phase 2: Polish & Data
7. Refactor `Portfolio.tsx` to use AppContext instead of local fetch
8. Add fund-account sub-screen (reuse Fund.tsx content)
9. Connect Activity.tsx filters to real position data
10. Add portfolio-history mock data display with "Sample data" label

### Phase 3: API Integration
11. Build `GET /v1/accounts/:id/transactions` endpoint
12. Build `GET /v1/accounts/:id/portfolio-history` endpoint
13. Build `GET /v1/prices/current` endpoint
14. Replace mock data in PnLChart and ActivityFeed with real API calls

### Phase 4: Extension Onboarding
15. Add in-popup onboarding screens to sheet
16. WebAuthn create within extension popup context
17. Direct chrome.storage.local writes (skip bridge for extension-created accounts)
