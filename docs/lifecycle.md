# Floors — Full User Lifecycle

Every user-facing operation, what happens at each layer (UI → API → relayer → chain), and how the floor contract fits in.

---

## 1. Account Creation

### What the user sees
`Welcome → Create Passkey (name input + fingerprint) → Creating Account (spinner) → Account Ready (copy address)`

### Flow

1. **Passkey creation** (`apps/web/src/screens/CreatePasskey.tsx`)
   - User enters a passkey name (e.g. "My MacBook").
   - `navigator.credentials.create()` with `rp.id = window.location.hostname`, `pubKeyCredParams = ES256 (-7, P-256)`, `residentKey = required`, `userVerification = required`.
   - Extracts the compressed SEC1 P-256 public key (33 bytes) from the `SubjectPublicKeyInfo` blob via `extractCompressedP256Key()`.
   - Encodes credential ID as base64url.
   - Stores `credentialId`, `publicKey` (base58), `compressedKeyHex` in React state and `localStorage` under `floors:*` keys.
   - Appends `{name, credentialId, createdAt}` to `localStorage['floors:passkeys']` JSON array.

2. **API: create account** `POST /v1/accounts` (`services/api/src/routes/accounts.ts`)
   - Body: `{ public_key_hex: "02ab...", credential_id: "base64url...", invite_code? }`
   - Derives the NEP-616 deterministic address:
     ```
     address = "0s" + hex(keccak256(borsh(StateInit))[12..32])
     ```
     where `StateInit` contains the wallet contract code hash and the Borsh-serialized wallet `State` (signature_enabled, subwallet_id, compressed public key, empty nonces).
   - `@floors/wallet` package: `deriveAddress(compressedKey, codeHashHex)`.
   - Stores `{account_id, public_key_hex, credential_id}` in `api.accounts` table.
   - Calls relayer to create the account on-chain.

3. **Relayer: create NEAR account** `POST /v1/relay/create-account` (`services/relayer/src/routes/relay.ts`)
   - Body: `{ account_id, public_key_hex, idempotency_key }`
   - Builds raw NEAR transaction with `DeterministicStateInit` action (NEP-616, action discriminant 11).
   - Sends via `near-api-js` from the relayer signing account (`floors-dev.testnet`).
   - On-chain: NEAR protocol creates the `0s...` account with the wallet contract code and initial state.

4. **On-chain state**
   - Account created at `0s...` with wallet contract WASM.
   - State: `{signature_enabled: true, subwallet_id: 0, public_key: <compressed P-256>, nonces: empty, extensions: empty}`.

### Error states
- Passkey creation cancelled by user → error card shown.
- Account already exists on NEAR → relayer returns `{status: "exists"}`.
- Global contract not deployed → relayer returns 412 with deploy instructions.

---

## 2. Enable Trading

### What the user sees
`Enable Trading screen → "Registering on NEAR…" spinner → Fund`

### Flow

1. **Web app** (`apps/web/src/screens/EnableTrading.tsx`)
   - Calls `enableTrading(accountId, compressedKeyHex)` from `api/client.ts`.

2. **API client** `POST /v1/relay/enable-trading`
   - Body: `{ account_id, public_key, idempotency_key }`
   - On **mainnet**: relayer calls `intents.near#add_public_key({public_key})` to register the user's passkey with the NEAR Intents protocol.
   - On **testnet**: no intents contract available; returns `{tx_hash: null, status: "success"}` immediately (intents registration deferred).

3. **On-chain (mainnet only)**
   - `intents.near#add_public_key` registers the P-256 compressed key so the user can sign intents.

### Error states
- Relayer unreachable → "Could not reach relayer" error.
- `w_execute_signed` WASM trap on testnet → auto-skips to Fund screen.
- intents.near doesn't exist on testnet → returns success with null tx_hash.

---

## 3. Funding

### What the user sees
`Fund screen → NEAR address + Copy button`

### Flow

1. **API: deposit addresses** `GET /v1/accounts/:id/deposit-addresses`
   - Returns the `0s...` NEAR address for USDC deposits.
   - On testnet: single "NEAR" chain option with the account address.
   - On mainnet: would return per-chain deposit addresses from 1Click.

2. **User action**
   - Sends USDC to the `0s...` address from an external wallet or faucet.
   - USDC arrives as an NEP-141 `ft_transfer` on the token contract.

### Token contracts
- **Testnet**: `usdc.fakes.testnet` (6 decimals), `eth.fakes.testnet` (18 decimals)
- **Mainnet**: `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (USDC)

---

## 4. Getting a Quote

### Draft quote (display only)

`GET /v1/quotes/draft?asset=ETH&usd=10` (`services/api/src/routes/quotes.ts`)

- **Mainnet**: calls 1Click API `POST https://1click.chaindefuser.com/v0/quote` with `EXACT_INPUT`, `depositType: INTENTS`, `originAsset: nep141:<usdc>`, `destinationAsset: nep141:eth.omft.near`.
- **Testnet**: calls Ref Finance `get_return` view method on `ref-finance-101.testnet` for pool 365 (`usdc.fakes.testnet ↔ eth.fakes.testnet`).

Response:
```json
{
  "quote_id": "hex...",
  "asset": "ETH",
  "pay_usdc": "10000000",
  "est_qty": "5139239214784295",
  "display": { "you_pay": "10", "est_amount": "0.005139", "expires": "300s" }
}
```

### Floor quote (with protection)

`POST /v1/quotes` (`services/api/src/routes/quotes.ts` → `services/risk/src/routes/quotes.ts`)

- API forwards to risk service `POST /v1/risk/quote` with `{ asset, qty, floor_bps, duration_secs, account_id, valid_until_ns }`.
- Risk service:
  1. Fetches current price from CoinGecko (primary) or Pyth (fallback).
  2. Computes strike price: `strike = spot × (1 - floor_bps/10000)`.
  3. Computes floor_price_e6: `strike × 1_000_000`.
  4. Computes fee: `premium_bps × notional / 10000` (based on duration tier).
  5. Signs the quote with Ed25519 (`FLOORS_QUOTE/V1 || quote_id || owner || asset || qty || floor_price_e6 || fee_usdc || sleeve || expires_at`).

Response includes `{ quote, sig }` where `quote` has `floor_price_e6`, `fee_usdc`, `sleeve`, `expires_at_ns`, `key_id`.

---

## 5. Buying with Floor

### What the user sees
`Buy sheet (WYSIWYS quote card + Floor Protection toggle) → Confirm with Passkey → Submitting… → Success/Partial/Error`

### Flow

1. **Extension sheet** (`apps/extension/src/entrypoints/sheet/index.tsx`)
   - Fetches draft quote → displays WYSIWYS card.
   - User toggles floor protection (OFF / 5% / 10%) and duration (30d / 90d / 180d).
   - On confirm: builds challenge from quote data, calls `signWithPasskey(challenge, credentialId)`.
   - Submits to `POST /v1/submit`.

2. **API: submit** `POST /v1/submit` (`services/api/src/routes/submit.ts`)
   - Body: `{ quote_id, assertion: { signature, credential_id, ticker, amount_usdc, authenticator_data?, client_data_json? } }`
   - Header: `Idempotency-Key: uuid`
   - Validates assertion matches cached draft quote (ticker, amount).
   - Looks up `account_id` and `public_key_hex` from DB by `credential_id`.
   - If `authenticator_data` + `client_data_json` present: verifies WebAuthn P-256 signature.
   - Stores in `api.buy_submissions` → returns `{ status_id }` immediately (202).
   - Fires async relay to `POST /v1/relay/swap`.

3. **Relayer: swap** `POST /v1/relay/swap` (`services/relayer/src/routes/swap.ts`)

   **Mainnet (1Click)**:
   1. `POST https://1click.chaindefuser.com/v0/quote` → gets deposit address + estimated output.
   2. `POST .../v0/generate-intent` → gets NEAR Intents payload.
   3. Signs intent with relayer key (NEP-413).
   4. `POST .../v0/submit-intent` → submits to solver network.
   5. Polls `GET .../v0/status?depositAddress=...` for up to 10s.
   6. Persists `{intent_hash, tx_hash, status}` in `relayer.swap_intents`.

   **Testnet (Ref Finance)**:
   1. Storage deposit on output token for recipient (if needed).
   2. `ft_transfer_call` on `usdc.fakes.testnet` to `ref-finance-101.testnet` with swap message: `{actions: [{pool_id: 365, token_in, token_out, amount_in, min_amount_out: "0"}]}`.
   3. Ref Finance executes the swap atomically.
   4. Relayer reads its output token balance.
   5. `ft_transfer` output tokens to user's `0s...` account.
   6. Returns `{intent_hash, tx_hash, status: "completed", amount_out}`.

4. **SSE status stream** `GET /v1/status/:status_id/stream`
   - Polls `api.buy_submissions` every 500ms.
   - Emits `event: status\ndata: {state, tx_hash, ...}`.
   - Client transitions: `submitted → tracking → done` (success) or `failed` (error).
   - Partial outcome: `{type: "partial", swap_done: true, floor_error: "..."}` when swap succeeds but floor opening fails.

5. **Floor opening** (mainnet with intents.near)
   - After swap, if floor protection requested:
     - Relayer calls `mt_on_transfer` on `floors.floors-dev.testnet` via `intents.near` (NEP-245 multi-token transfer).
     - Transfers both the asset tokens AND the USDC fee to the floors contract.
     - `msg`: `{op: "open_floor", quote: {id, owner, asset, qty, floor_price_e6, fee_usdc, sleeve, expires_at_ns, floor_bps, duration_secs, key_id, pyth_feed}, sig: "base64"}`
     - Contract verifies: predecessor is intents.near, quote signature valid (Ed25519), amounts match, quote not expired, not already used, sleeve has capacity.
     - Cross-contract call to Pyth oracle to validate current price.
     - On success: creates `Floor` record in contract state, emits `FloorOpened` event.

### On-chain state after buy with floor
```
Floor {
  owner: "0s...",
  asset: "nep141:eth.omft.near",
  qty: 14620000000000000,    // ETH amount
  floor_price_e6: 3070890000, // $3070.89
  reserved_usdc: 3070890000,  // USDC locked as guarantee
  sleeve: "majors_sleeve_v1",
  fee_usdc: 494000,           // $0.494 fee
  opened_ns: 1763017251000000000,
  expires_ns: 1763103651000000000,
  status: Active
}
```

---

## 6. Portfolio View

### What the user sees
`Portfolio screen: USDC balance card + Floor positions list + Fund/Send/Buy buttons`

### Flow

1. **API: positions + balance** `GET /v1/accounts/:id/positions`
   - Reads floor positions from `api.positions` table (if populated by indexer).
   - RPC call to NEAR: `ft_balance_of({account_id})` on the configured USDC token contract → returns `usdc_balance` as human-readable string (e.g. `"20.00"`).
   - Response: `{ positions: [...], usdc_balance: "20.00" }`.

2. **Portfolio screen** (`apps/web/src/screens/Portfolio.tsx`)
   - Displays `$XX.XX USDC` balance prominently.
   - Lists active floor positions with: asset, qty, floor price, expiry, status.
   - Active positions show "Sell to Floor" and "Close" buttons.

---

## 7. Sell to Floor

Triggers the floor guarantee — user receives USDC at the floor price, giving up the asset.

### Flow

1. **API: action challenge** `POST /v1/accounts/:id/actions` (`services/api/src/routes/actions.ts`)
   - Body: `{ action: "sell_to_floor", floor_id }`
   - Returns `{ wallet_request, challenge }` for passkey signing.

2. **Passkey signing** — user signs the challenge with their device passkey.

3. **API: submit action** `POST /v1/actions`
   - Body: `{ action, floor_id, account_id, signature, credential_id, wallet_request }`
   - Forwards to relayer.

4. **Relayer: floor action** `POST /v1/relay/floor-action`
   - Calls `w_execute_signed(msg, proof)` on the user's wallet contract.
   - Wallet contract calls `floors.floors-dev.testnet#on_auth(signer_id, msg)`.

5. **Contract: on_auth → on_auth_sell** (`contracts/floors/src/receivers_auth.rs`)
   - Verifies: predecessor is intents.near, signer owns the floor, floor is Active, not paused, not expired.
   - Computes `payout_usdc = floor(qty × floor_price_e6 / 10^decimals)`.
   - Transitions floor to `PayoutPending`.
   - Updates totals: `reserved -= reserved_usdc`, `pending += payout_usdc`.
   - Cross-contract: `intents.near#mt_transfer(owner, usdc, payout_usdc)`.
   - Callback `on_sell_payout`: on success → floor status = `Sold`, releases asset from escrow. On failure → restores state.

### On-chain state change
```
Floor.status: Active → PayoutPending → Sold
User receives: payout_usdc via mt_transfer
Contract releases: asset qty from escrow
```

---

## 8. Close Position

User reclaims their asset tokens and gives up the floor guarantee.

### Flow

1. Same challenge/sign/submit pattern as sell_to_floor.
2. Action: `{ action: "close", floor_id }`.

3. **Contract: close** (`contracts/floors/src/floors.rs`)
   - Verifies ownership, Active status, not paused.
   - Transitions to `ClosePending`.
   - Reduces `totals.reserved` and `totals.escrow`.
   - Cross-contract: `intents.near#mt_transfer(owner, asset, qty)` — returns tokens to user.
   - Callback `on_close_transfer`:
     - Success: floor status = `Closed`, releases reserved USDC back to sleeve free capacity.
     - Failure: reverses all state changes (restores reserved, escrow, sleeve).

### On-chain state change
```
Floor.status: Active → ClosePending → Closed
User receives: asset tokens back
Sleeve: reserved_usdc released to free_usdc
```

---

## 9. Expire + Auto-Protect

### Expire (bot-triggered)

`POST /v1/relay/expire-floor` or `POST /v1/relay/expire-floors-batch` → relayer calls `floors.floors-dev.testnet#expire(ids: Vec<u64>)`

- **Contract: expire** (`contracts/floors/src/floors.rs`)
  - For each floor: verifies Active, block_timestamp >= expires_ns.
  - Transitions to `Expired`.
  - Releases reserved USDC: `sleeve.reserved -= reserved_usdc`, `sleeve.free += reserved_usdc`.
  - Transfers asset back to owner via `intents.near#mt_transfer`.
  - Callback `on_expire_transfer`: on success → reduces `totals.held`, `totals.escrow`.

### Auto-Protect (bot-triggered)

`POST /v1/relay/auto-protect` → relayer calls `floors.floors-dev.testnet#auto_protect(floor_id)`

- **Contract: auto_protect** (`contracts/floors/src/bot_methods.rs`)
  - Bot-only (caller must be `roles.auto_protect_bot`).
  - Checks floor is Active and within the auto-protect window (default 900s before expiry).
  - Cross-contract call to Pyth oracle for current price.
  - Callback `on_auto_protect`: if current price ≤ floor_price → triggers `sell_to_floor` internally (same payout logic). If price > floor → no action.

---

## 10. Extension Flow

### Chip injection

1. **Content script** (`apps/extension/src/entrypoints/content.ts`)
   - Runs on `https://x.com/*` and `https://twitter.com/*` at `document_idle` in `MAIN` world.
   - Defines `<floors-chip>` custom element (shadow DOM).
   - MutationObserver watches for `a[data-testid="cashtag"]` elements (e.g. `$ETH`, `$SOL`).
   - Injects a `<floors-chip ticker="ETH">` after each cashtag link.
   - Click on chip: `window.postMessage({__floors__: true, type: "OPEN_SHEET", ticker, postId})`.

2. **Bridge script** (`apps/extension/src/entrypoints/bridge.content.ts`)
   - Runs at `document_start` in the default (isolated) world.
   - Listens for `window.postMessage` with `__floors__: true`.
   - Forwards to background via `chrome.runtime.sendMessage`.
   - Also syncs `floors:*` localStorage keys to `chrome.storage.local` (for the extension popup).

3. **Background** (`apps/extension/src/entrypoints/background.ts`)
   - On `OPEN_SHEET` message: `chrome.windows.create({url: "sheet.html?ticker=ETH&postId=...", type: "popup", width: 412, height: 680})`.
   - On `SYNC_STORAGE` message: writes allowlisted keys to `chrome.storage.local`.

4. **Sheet popup** (`apps/extension/src/entrypoints/sheet/index.tsx`)
   - Reads `floors:account_id`, `floors:credential_id`, `floors:passkeys`, `floors:floor_defaults` from `chrome.storage.local`.
   - If no account → shows onboarding screen with "Create Wallet" button (opens web app).
   - If multiple passkeys → shows passkey picker.
   - Fetches draft quote from `GET /v1/quotes/draft?asset=ETH&usd=10`.
   - Shows WYSIWYS card with floor protection toggle.
   - On confirm: signs with passkey → submits to `POST /v1/submit` → tracks via SSE.
   - Success/partial/error screens.

### Toolbar icon
- `action.default_popup: "sheet.html"` — clicking the extension icon opens the sheet directly.
- Icons: PNG at 16/32/48/128px (Chrome MV3 requires PNG, not SVG).

---

## Service Ports

| Service | Port | Role |
|---------|------|------|
| API | 3001 | User-facing REST, DB, quote cache |
| Relayer | 3002 | NEAR tx signing, 1Click/Ref swap, floor bot |
| Risk | 3003 | Floor quote pricing + Ed25519 signing |
| Registry | 3004 | Token metadata |
| Indexer | 3005 | On-chain event indexer |
| Web app | 5173 | Onboarding UI (Vite dev) |
| Postgres | 5432 | Shared DB |

---

## Key Token IDs

| Token | Testnet | Mainnet |
|-------|---------|---------|
| USDC | `usdc.fakes.testnet` | `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` |
| ETH | `eth.fakes.testnet` | `nep141:eth.omft.near` |
| SOL | `sol.fakes.testnet` | `nep141:sol.omft.near` |

---

## Contract Methods Summary

| Method | Caller | Purpose |
|--------|--------|---------|
| `new` | Owner | Initialize contract with roles + params |
| `init_params` | Owner | Replace all params |
| `mt_on_transfer` | intents.near | Open a floor (NEP-245 multi-token) |
| `on_open_price` | Self (callback) | Validate Pyth price after mt_on_transfer |
| `on_auth` | intents.near | User-signed actions (sell, close, withdraw) |
| `sell_to_floor` | Floor owner | Trigger floor payout (direct call) |
| `close` | Floor owner | Close floor, reclaim asset |
| `expire` | Anyone | Expire floors past expiry |
| `auto_protect` | Bot | Sell at floor if price drops before expiry |
| `reconcile` | Bot | Reconcile on-chain balances with totals |
| `unwind_start` | Bot | Begin unwinding excess asset exposure |
| `unwind_settle` | Bot | Complete unwind after swap |
| `get_floor` | View | Read single floor |
| `list_floors` | View | List floors by owner |
| `get_params` | View | Read contract params |
| `get_roles` | View | Read roles |
| `get_sleeve` | View | Read sleeve state |
| `get_totals` | View | Read asset totals |
| `get_capacity` | View | Read available sleeve capacity |
