# UX Implementation Plan: Bottom Nav + Multi-Screen Architecture

> Transforms the linear `SCREEN_ORDER` flow into a tab-based shell with persistent bottom navigation. Onboarding remains linear; post-onboarding uses four tabs: **Home**, **Portfolio**, **Activity**, **Settings**.

---

## 1. New App.tsx Architecture

### Two-phase navigation model

```
Phase 1 — Onboarding (linear, no tabs)
  welcome → sign-in → invite-code → create-passkey → creating-account
  → account-ready → setup-defaults → enable-trading → fund

Phase 2 — Main app (tab-based, bottom nav visible)
  home | portfolio | activity | settings
  Each tab can push sub-screens (e.g. position-detail) on top
```

### Screen type changes

```ts
// Onboarding screens — keep existing linear transition system
export type OnboardingScreen =
  | 'welcome'
  | 'sign-in'
  | 'invite-code'
  | 'create-passkey'
  | 'creating-account'
  | 'account-ready'
  | 'enable-trading'
  | 'setup-defaults'
  | 'fund';

// Tab identifiers for bottom nav
export type Tab = 'home' | 'portfolio' | 'activity' | 'settings';

// Sub-screens that push on top of a tab (each remembers which tab it belongs to)
export type SubScreen = 'position-detail' | 'fund-account';

// Top-level phase discriminator
export type AppPhase =
  | { phase: 'onboarding'; screen: OnboardingScreen }
  | { phase: 'main'; tab: Tab; subScreen?: SubScreen; subScreenParams?: Record<string, string> };
```

### App component structure

```
<App>
  ├── phase === 'onboarding'
  │   └── <OnboardingShell>  ← reuses existing screen-transition CSS
  │       └── renders current onboarding screen with slide animation
  │
  └── phase === 'main'
      └── <MainShell>
          ├── <div class="tab-content">  ← takes full height minus nav
          │   ├── <Home />       (visible when tab === 'home')
          │   ├── <Portfolio />  (visible when tab === 'portfolio')
          │   ├── <Activity />   (visible when tab === 'activity')
          │   ├── <Settings />   (visible when tab === 'settings')
          │   └── <SubScreen />  (slides over tab content when active)
          │
          └── <BottomNav />  ← fixed to bottom, always visible in main phase
```

### Navigation functions exposed to screens

```ts
// Available to all main-phase screens via props or context
interface MainNavigation {
  switchTab: (tab: Tab) => void;
  pushSubScreen: (sub: SubScreen, params?: Record<string, string>) => void;
  popSubScreen: () => void;
  signOut: () => void;              // clears account, returns to onboarding
  navigateToFund: () => void;       // pushes fund-account sub-screen
}
```

### Entry point logic (`getInitialPhase`)

```ts
function getInitialPhase(): AppPhase {
  const accountId = localStorage.getItem('floors:account_id');
  const credentialId = localStorage.getItem('floors:credential_id');
  if (accountId && credentialId) {
    // Returning user — land on Home tab
    return { phase: 'main', tab: 'home' };
  }
  if (accountId) {
    // Has account but no credential — needs to sign in
    return { phase: 'onboarding', screen: 'sign-in' };
  }
  return { phase: 'onboarding', screen: 'welcome' };
}
```

### Onboarding → Main transition

When the `fund` screen's "I've Funded My Account" button is pressed, App transitions from `{ phase: 'onboarding' }` to `{ phase: 'main', tab: 'home' }`. No animation needed — clean cut to the tabbed shell.

---

## 2. BottomNav Component Spec

### File: `apps/web/src/components/BottomNav.tsx`

### Visual design

| Property | Value |
|---|---|
| Height | 64px + safe-area-inset-bottom (env()) |
| Background | #FAF9F6 (warm white) |
| Top border | 2px solid #111 |
| Shadow | `0px -2px 0px #111` (neo-brutalist upward) |
| Position | fixed bottom-0, full width |
| z-index | 50 |

### Tab items

| Tab | Label | Icon | Badge |
|---|---|---|---|
| Home | Home | House/storefront outline | — |
| Portfolio | Portfolio | Wallet/chart outline | Active position count (number badge when > 0) |
| Activity | Activity | Clock/list outline | Pending transaction count (dot badge when > 0) |
| Settings | Settings | Gear outline | — |

### States

- **Inactive**: Icon stroke `#111` at 40% opacity, label `text-gray-400`, `font-bold`
- **Active**: Icon fill `#EF7B28`, label `text-[#111]`, `font-extrabold`, dot indicator below icon (4px circle, `bg-[#EF7B28]`)
- **Pressed**: `:active` shifts 1px down (reuses `shadow-neo-active` pattern)

### Badge rendering

- **Number badge** (Portfolio): `min-w-[18px] h-[18px]` circle, `bg-[#EF7B28]` `text-white` `text-[10px] font-extrabold`, `border border-[#111]`, positioned top-right of icon
- **Dot badge** (Activity): `w-2 h-2` circle, `bg-[#EF7B28]` `border border-[#111]`, positioned top-right of icon

### Props

```ts
interface BottomNavProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  positionCount?: number;    // number badge on Portfolio
  pendingTxCount?: number;   // dot badge on Activity
}
```

### Safe area handling

```css
.bottom-nav {
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
```

All tab-content containers get matching bottom padding so content is not hidden behind the nav:

```css
.tab-content {
  padding-bottom: calc(64px + env(safe-area-inset-bottom, 0px));
}
```

---

## 3. Screen Component Structures

### 3a. Home Screen

**File:** `apps/web/src/screens/Home.tsx`

**Purpose:** Market overview, quick-buy entry, featured assets.

```
<Home>
  ├── Header: "Floors" wordmark + avatar (taps → Settings tab)
  │
  ├── Balance summary card
  │   ├── USDC balance (large)
  │   ├── NEAR balance (secondary)
  │   └── Quick action pills: [Fund] [Send*] [Buy*]  (* = coming soon)
  │
  ├── Market section
  │   ├── Section header: "Markets" + filter chips (All / Crypto / ???)
  │   └── Asset list (scrollable)
  │       └── AssetRow: icon, name, price, 24h change, [Buy Floor] button
  │
  └── Featured / CTA card
      └── "Protect your first position" explainer card (shown when 0 positions)
```

**Component breakdown:**
- `BalanceSummaryCard` — extracted from current Portfolio hero; reusable
- `AssetRow` — tappable row, opens buy flow (future sub-screen)
- `QuickActions` — row of 3 action buttons (extracted from current Portfolio)

### 3b. Portfolio Screen (refactored)

**File:** `apps/web/src/screens/Portfolio.tsx` (modified)

**Changes from current:**
- Remove sign-out button (moves to Settings)
- Remove header nav (tab title handled by MainShell or inline)
- Remove cloud SVG hero backdrop (Home gets it instead)
- Keep: balance card, quick actions, position list
- Add: PnL chart placeholder (empty state with "Coming soon")
- Position cards become tappable → push `position-detail` sub-screen
- Pull-to-refresh gesture (optional, stretch goal)

```
<Portfolio>
  ├── Header: "Portfolio" title (centered)
  │
  ├── PnL chart area
  │   └── Placeholder: "Performance chart coming soon"
  │
  ├── Balance card (same as current, extracted to shared component)
  │
  ├── Position list
  │   └── PositionCard (tappable → pushSubScreen('position-detail', { floorId }))
  │       ├── Asset name + amount
  │       ├── Floor price
  │       ├── Status badge
  │       └── Protected until date
  │
  └── Empty state (when no positions)
      └── CTA: "Buy with protection" → navigateToFund or Buy flow
```

### 3c. Activity Screen

**File:** `apps/web/src/screens/Activity.tsx`

**Purpose:** Transaction history, floor events, status tracking.

```
<Activity>
  ├── Header: "Activity" title
  │
  ├── Filter tabs: [All] [Pending] [Completed]
  │
  ├── Transaction list (grouped by date)
  │   └── ActivityItem
  │       ├── Icon (type-specific: buy, sell, close, fund, enable-trading)
  │       ├── Description ("Bought floor on NEAR", "Sold to floor", etc.)
  │       ├── Amount + asset
  │       ├── Status pill (pending spinner / confirmed check / failed X)
  │       └── Timestamp
  │
  └── Empty state
      └── "No activity yet. Buy a floor to get started."
```

**Component breakdown:**
- `ActivityItem` — single transaction row
- `ActivityFilter` — tab bar for All/Pending/Completed
- `DateGroup` — date header + list of items

### 3d. Settings Screen

**File:** `apps/web/src/screens/Settings.tsx`

**Purpose:** Account management, passkey management, sign out.

```
<Settings>
  ├── Header: "Settings" title
  │
  ├── Account section
  │   ├── Avatar + account ID (truncated, tap to copy)
  │   └── Account status badge
  │
  ├── Passkey management card
  │   ├── Current passkey name + credential info
  │   ├── [Add passkey] button (future)
  │   └── [Rename passkey] button (future)
  │
  ├── Preferences card
  │   ├── Default floor %  (from SetupDefaults)
  │   ├── Default duration  (from SetupDefaults)
  │   └── Notification settings (future)
  │
  ├── About section
  │   ├── Version number
  │   └── [Terms] [Privacy] links
  │
  └── Sign out button
      └── Danger zone: red-outlined, clears localStorage, returns to onboarding
```

### 3e. PositionDetail Screen

**File:** `apps/web/src/screens/PositionDetail.tsx`

**Purpose:** Expanded view of a single floor position with full action controls.

```
<PositionDetail>
  ├── Header: back arrow + "Floor Detail" title
  │
  ├── Asset hero
  │   ├── Asset icon (large)
  │   ├── Amount + asset name
  │   └── Current market price (future)
  │
  ├── Floor details card
  │   ├── Floor price (USD)
  │   ├── Protection expiry date
  │   ├── Status badge (active/expired/closed)
  │   └── Floor ID (truncated, tap to copy)
  │
  ├── Price chart placeholder
  │   └── "Price history coming soon"
  │
  ├── Action buttons (only when status === 'active')
  │   ├── [Sell to Floor] — full-width, teal, primary
  │   └── [Close Position] — full-width, white, secondary
  │
  └── Action error display (same pattern as current Portfolio)
```

**Navigation:** Pushed as sub-screen over Portfolio tab. Back arrow calls `popSubScreen()`.

**Params:** `{ floorId: string }` — fetches position data from the already-loaded positions list (passed via context or prop drilling).

---

## 4. API Endpoints Per Screen

### Home

| Endpoint | Method | Purpose | Exists? |
|---|---|---|---|
| `GET /v1/accounts/:id/positions` | GET | Balance + position count | Yes |
| `GET /v1/markets` | GET | Market prices, 24h change | **New — needs backend** |
| `GET /v1/suggestions` | GET | Default floor params for quick-buy | Yes |

### Portfolio

| Endpoint | Method | Purpose | Exists? |
|---|---|---|---|
| `GET /v1/accounts/:id/positions` | GET | Positions + balances | Yes |
| `POST /v1/accounts/:id/actions` | POST | Action challenge (sell/close) | Yes |
| `POST /v1/actions` | POST | Submit signed action | Yes |

### Activity

| Endpoint | Method | Purpose | Exists? |
|---|---|---|---|
| `GET /v1/accounts/:id/transactions` | GET | Transaction history | **New — needs backend** |
| `GET /v1/accounts/:id/actions/:id/status` | GET | Action status polling | **New — needs backend** |

### Settings

| Endpoint | Method | Purpose | Exists? |
|---|---|---|---|
| `GET /v1/accounts/:id` | GET | Account info | Yes |
| `GET /v1/accounts/:id/deposit-addresses` | GET | For "Fund" shortcut | Yes |
| No new endpoints needed — passkey data is local (WebAuthn + localStorage) |

### PositionDetail

| Endpoint | Method | Purpose | Exists? |
|---|---|---|---|
| Same as Portfolio — reuses loaded position data | | | |
| `GET /v1/markets/:asset/price` | GET | Live price for asset | **New — needs backend** |

### New API client functions needed

```ts
// api/client.ts additions
export async function getMarkets(): Promise<Market[]>               // Home
export async function getTransactions(accountId: string): Promise<Transaction[]>  // Activity
export async function getActionStatus(accountId: string, statusId: string): Promise<ActionStatus>  // Activity polling
export async function getAssetPrice(asset: string): Promise<AssetPrice>  // PositionDetail
```

All new endpoints should follow the existing pattern: fetch → parseResponse with Zod schema → fallback on 404/501 returning empty data.

---

## 5. State Management

### Shared state (lifted to App or context)

| State | Type | Used by | Notes |
|---|---|---|---|
| `account` | `AccountState \| null` | All screens | Already exists in App. No change. |
| `positions` | `Position[]` | Home (count), Portfolio (list), PositionDetail | Fetch once, share via context |
| `balances` | `{ near: string, usdc: string }` | Home, Portfolio | Fetched with positions |
| `activeTab` | `Tab` | App, BottomNav | Controls which tab is rendered |
| `subScreen` | `SubScreen \| null` | App, MainShell | Controls pushed sub-screens |

### Context provider

```ts
// New file: apps/web/src/context/AppContext.tsx

interface AppContextValue {
  account: AccountState;
  positions: Position[];
  balances: { near: string | null; usdc: string | null };
  refreshPositions: () => Promise<void>;
  isLoadingPositions: boolean;

  // Navigation
  switchTab: (tab: Tab) => void;
  pushSubScreen: (sub: SubScreen, params?: Record<string, string>) => void;
  popSubScreen: () => void;
  signOut: () => void;
}
```

### Per-tab state (local to each screen)

| Screen | Local state |
|---|---|
| Home | `markets`, `loadingMarkets`, selected asset filter |
| Portfolio | `actionLoading`, `actionError` (for sell/close) |
| Activity | `transactions`, `loadingTx`, `filter` (all/pending/completed) |
| Settings | `copyToast`, form state for preferences |
| PositionDetail | `selectedPosition` (derived from floorId param), `actionLoading`, `actionError` |

### Data flow

```
App
 └── AppProvider (context)
      ├── positions + balances fetched on mount and refreshPositions()
      ├── account from existing useState
      └── navigation state (activeTab, subScreen)
           │
           ├── Home reads positions.length, balances from context
           ├── Portfolio reads positions, balances from context
           ├── Activity fetches own transactions (not shared — only this tab needs it)
           ├── Settings reads account from context
           └── PositionDetail reads single position from context by floorId
```

### Why not a state library?

The app has zero external state dependencies (no Redux, Zustand, etc.) and only three dependencies total (react, react-dom, zod). A React context + `useReducer` keeps the bundle minimal and matches the existing pattern of prop-drilling through `account`/`setAccount`. If state grows, Zustand is the natural next step — but not needed now.

---

## 6. File Changes

### New files

| File | Purpose |
|---|---|
| `apps/web/src/components/BottomNav.tsx` | Tab bar component |
| `apps/web/src/components/BalanceSummaryCard.tsx` | Extracted balance card (shared by Home + Portfolio) |
| `apps/web/src/components/QuickActions.tsx` | Extracted action buttons row (shared by Home + Portfolio) |
| `apps/web/src/components/PositionCard.tsx` | Extracted position card (tappable, used in Portfolio) |
| `apps/web/src/context/AppContext.tsx` | Shared state provider |
| `apps/web/src/screens/Home.tsx` | Market overview + quick buy |
| `apps/web/src/screens/Activity.tsx` | Transaction history |
| `apps/web/src/screens/Settings.tsx` | Account settings + sign out |
| `apps/web/src/screens/PositionDetail.tsx` | Single floor expanded view |
| `apps/web/src/layouts/MainShell.tsx` | Tab content container + BottomNav wrapper |
| `apps/web/src/layouts/OnboardingShell.tsx` | Wraps existing linear screen transition |

### Modified files

| File | Changes |
|---|---|
| `apps/web/src/App.tsx` | Replace `SCREEN_ORDER` with two-phase system. Add `AppPhase` type. Split render into OnboardingShell vs MainShell. Move `AccountState` to context file. |
| `apps/web/src/screens/Portfolio.tsx` | Remove sign-out button, cloud SVG hero, header. Extract balance card + quick actions + position card to shared components. Make position cards tappable. Remove `navigate` prop (use context). |
| `apps/web/src/screens/Fund.tsx` | Update back-button to use `popSubScreen()` instead of `navigate('enable-trading')`. Can be used as both onboarding step and main-phase sub-screen. |
| `apps/web/src/index.css` | Add `.bottom-nav`, `.tab-content`, `.sub-screen-enter`, `.sub-screen-exit` transition classes. Add safe-area padding utilities. |
| `apps/web/src/api/client.ts` | Add `getMarkets()`, `getTransactions()`, `getActionStatus()`, `getAssetPrice()` stubs with fallback behavior for unimplemented endpoints. Add corresponding Zod schemas and types. |

### No files deleted

All existing screen files are kept. Onboarding screens remain unchanged — they still receive `navigate` and `account` props through the OnboardingShell wrapper.

---

## 7. Implementation Sequence

Execute in this order to keep the app working at every step:

| Step | What | Risk |
|---|---|---|
| 1 | Create `AppContext.tsx` — lift `account`, `positions`, `balances` into context | Low — additive |
| 2 | Create `OnboardingShell.tsx` — extract existing linear transition logic from App | Medium — refactor |
| 3 | Create `BottomNav.tsx` | Low — new component, no dependencies |
| 4 | Create `MainShell.tsx` — tab container + sub-screen push/pop | Medium — new layout |
| 5 | Rewrite `App.tsx` — two-phase routing, use OnboardingShell + MainShell | High — integration point |
| 6 | Create `Home.tsx` with balance card and placeholder market list | Low — new screen |
| 7 | Refactor `Portfolio.tsx` — extract shared components, remove redundant UI | Medium — refactor |
| 8 | Create `Activity.tsx` with empty/placeholder state | Low — new screen |
| 9 | Create `Settings.tsx` with sign-out and account info | Low — new screen |
| 10 | Create `PositionDetail.tsx` with actions | Low — new screen |
| 11 | Update `index.css` with nav + transition styles | Low — additive |
| 12 | Update `api/client.ts` with new endpoint stubs | Low — additive |
| 13 | Update `Fund.tsx` for dual-use (onboarding + sub-screen) | Low — conditional logic |

### Definition of done

- Onboarding flow works identically to current (no regressions)
- After onboarding, user lands on Home tab
- All 4 tabs switch via bottom nav without page reload
- Position cards in Portfolio tab open PositionDetail sub-screen
- Sign out in Settings clears state and returns to onboarding welcome screen
- Sell-to-floor and close actions work from both Portfolio and PositionDetail
- Bottom nav respects safe-area-inset-bottom on notched devices
- All existing API calls work unchanged; new endpoints degrade gracefully on 404

---

## 8. CSS Additions

```css
/* Bottom nav bar */
.bottom-nav {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: 64px;
  padding-bottom: env(safe-area-inset-bottom, 0px);
  background-color: #FAF9F6;
  border-top: 2px solid #111;
  box-shadow: 0px -2px 0px #111;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: space-around;
}

/* Content area above bottom nav */
.tab-content {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding-bottom: calc(64px + env(safe-area-inset-bottom, 0px));
  background-color: #FAF9F6;
}

/* Sub-screen slide-in from right */
.sub-screen-enter {
  transform: translateX(100%);
  opacity: 1;
}
.sub-screen-active {
  transform: translateX(0%);
  opacity: 1;
  z-index: 20;
  transition: transform 0.35s cubic-bezier(0.22, 1, 0.36, 1);
}
.sub-screen-exit {
  transform: translateX(100%);
  opacity: 1;
  transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1);
}
```

---

## 9. Open Questions / Decisions Needed

1. **Tab persistence**: Should each tab preserve scroll position when switching away? Recommendation: yes — render all 4 tabs, show/hide with `display: none` vs `display: block` instead of mount/unmount. Costs a bit of memory but feels native.

2. **Markets data**: The Home screen needs a `/v1/markets` endpoint. Until the backend ships this, Home can show only the balance card + quick actions + a "Markets coming soon" placeholder. This is the main backend dependency.

3. **Activity data**: Similarly needs `/v1/accounts/:id/transactions`. Can ship Activity tab with empty state initially.

4. **Fund screen dual-use**: During onboarding, Fund is step 9. In the main app, it is a sub-screen accessible from Home/Portfolio. The component needs a `mode` prop or context check to determine whether to show "I've Funded" (onboarding) vs a back arrow (sub-screen).

5. **Deep linking**: No URL-based routing currently. Adding `react-router` would enable bookmark-able tabs (`/home`, `/portfolio`, etc.) but adds a dependency. Recommendation: skip for now, add later if needed.
