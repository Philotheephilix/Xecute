# Floors

Buy crypto from X posts — with downside protection.

Floors is a browser extension that adds a **Buy** chip to X.com posts mentioning supported tokens. Users hold self-custodial NEAR smart accounts secured by device passkeys. Every buy can optionally be wrapped with a *floor* — a NEAR contract that guarantees a minimum return value, so if the token drops below the strike price the position automatically unwinds to USDC.

---

## Architecture

```
floors/
├── apps/
│   ├── extension/        # Chrome MV3 extension (WXT 0.20)
│   └── web/              # Onboarding web app (Vite + React)
├── contracts/
│   └── floors/           # NEAR smart contract (Rust, near-sdk 5)
├── packages/
│   ├── intents/          # WYSIWYS intent signing helpers
│   ├── money/            # Bigint token math utilities
│   ├── pricing/          # Price feed abstraction (Pyth + CoinGecko)
│   ├── registry-schema/  # Shared token registry types
│   ├── shared-server/    # Fastify base, DB, migrations, config
│   ├── types/            # Cross-package TypeScript types
│   └── wallet/           # NEAR wallet-contract client
└── services/
    ├── api/              # User-facing REST API          :3001
    ├── relayer/          # NEAR transaction relayer      :3002
    ├── risk/             # Quote signing + capacity      :3003
    ├── registry/         # Token metadata registry       :3004
    └── indexer/          # On-chain event indexer        :3005
```

All services are Fastify 5 + TypeScript. Monorepo managed by Turborepo + pnpm workspaces.

---

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | 26 |
| pnpm | 12.18.0 |
| Rust + Cargo | stable (see `rust-toolchain.toml`) |
| Docker | any recent |
| `cargo-near` | latest (`cargo install cargo-near`) |

Install Node deps from the repo root:

```sh
pnpm install
```

---

## Local development

### 1. Start infrastructure

```sh
# Postgres + NEAR sandbox + mock solver
docker compose up -d

# Or postgres only (if you don't need the sandbox/solver)
docker compose up -d postgres
```

| Service | Host | Notes |
|---|---|---|
| Postgres | `localhost:5432` | user/pass/db: `floors` |
| NEAR sandbox | `localhost:3030` | localnet RPC |
| Mock solver | `localhost:4040` | 1Click solver stub |

### 2. Configure environment

Each service reads a `.env.local` file. Defaults work for local development — create the files if they don't exist:

**`services/api/.env.local`**
```env
NODE_ENV=local
PORT=3001
DATABASE_URL=postgres://floors:floors@localhost:5432/floors
RELAYER_URL=http://localhost:3002
RISK_URL=http://localhost:3003
```

**`services/relayer/.env.local`**
```env
NODE_ENV=local
PORT=3002
DATABASE_URL=postgres://floors:floors@localhost:5432/floors
NEAR_NODE_URL=http://localhost:3030
NEAR_NETWORK_ID=sandbox
NEAR_ACCOUNT_ID=alice.test.near
NEAR_PRIVATE_KEY=ed25519:<key>
WALLET_CONTRACT_CODE_HASH=<64-hex-chars>
FLOORS_CONTRACT=floors.floors-dev.testnet
ONE_CLICK_API_URL=https://1click.chaindefuser.com
# Optional — gates bot endpoints. Omit to leave them open in dev.
# INTERNAL_SECRET=<random-secret>
```

**`services/risk/.env.local`**
```env
NODE_ENV=local
PORT=3003
DATABASE_URL=postgres://floors:floors@localhost:5432/floors
RISK_SIGNING_KEY_HEX=<64-hex-chars>   # 32-byte Ed25519 seed, hex-encoded
```

**`services/registry/.env.local`**
```env
NODE_ENV=local
PORT=3004
DATABASE_URL=postgres://floors:floors@localhost:5432/floors
```

**`services/indexer/.env.local`**
```env
NODE_ENV=local
PORT=3005
DATABASE_URL=postgres://floors:floors@localhost:5432/floors
NEAR_NODE_URL=http://localhost:3030
NEAR_NETWORK_ID=sandbox
```

**`apps/extension/.env.local`** (optional — defaults to localhost)
```env
VITE_API_URL=http://localhost:3001
```

### 3. Build packages

Services depend on the shared packages. Build them first:

```sh
pnpm build
```

Or let Turborepo handle dependency order:

```sh
pnpm --filter "@floors/api" build     # builds shared deps first automatically
```

### 4. Run services

```sh
# All 5 services in one command (uses Makefile)
make stack-services

# Or individually
pnpm --filter "@floors/api" dev
pnpm --filter "@floors/relayer" dev
pnpm --filter "@floors/risk" dev
pnpm --filter "@floors/registry" dev
pnpm --filter "@floors/indexer" dev
```

Migrations run automatically on startup. To run them manually:

```sh
pnpm --filter "@floors/api" migrate
```

### 5. Run the web app

```sh
pnpm --filter "@floors/web" dev
# → http://localhost:5173
```

### 6. Build the extension

```sh
pnpm --filter "@floors/extension" build
# → apps/extension/.output/chrome-mv3/
```

Load the unpacked extension in Chrome:
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `apps/extension/.output/chrome-mv3/`

For live reload during development:

```sh
pnpm --filter "@floors/extension" dev
```

---

## Database migrations

Migrations are plain SQL files applied in filename order at service startup. They live alongside each service:

```
services/api/migrations/
  001_initial.sql
  002_buy_submissions.sql
  003_invite_codes.sql
  004_positions_text_pk.sql

services/relayer/migrations/
  001_initial.sql
  002_swap_intents.sql
  003_smart_accounts.sql
  004_nonce_table.sql
```

Both services share the same Postgres instance. `api` migrations create the `api` schema; `relayer` migrations create the `relayer` schema.

---

## NEAR smart contract

### Build

```sh
cd contracts
cargo build --target wasm32-unknown-unknown --release
```

Or with `cargo-near`:

```sh
cargo near build
```

Output: `contracts/target/wasm32-unknown-unknown/release/floors.wasm`

### Test

```sh
# Unit tests (no network)
cd contracts/floors && cargo test

# Or via Makefile
make test-contracts
```

### Deploy to testnet

```sh
# Deploy to an existing account
near deploy floors.YOUR_ACCOUNT.testnet \
  contracts/target/wasm32-unknown-unknown/release/floors.wasm

# Initialize (first deploy only)
near call floors.YOUR_ACCOUNT.testnet new \
  '{"owner_id": "YOUR_ACCOUNT.testnet", "params": {...}}' \
  --accountId YOUR_ACCOUNT.testnet
```

The deployed testnet contract is `floors.floors-dev.testnet`.

---

## Testing

### Unit tests (all packages + contract)

```sh
make test
# or
pnpm test           # TypeScript packages via Turborepo
make test-contracts # Rust contract unit tests
```

### End-to-end tests (web app)

Services and Postgres must be running (see [Local development](#local-development) above).

```sh
cd apps/web
PW_DISABLE_TS_ESM=1 pnpm exec playwright test
```

Test files:
- `e2e/onboarding.spec.ts` — full onboarding flow (welcome → fund)
- `e2e/floors-p2.spec.ts` — floor open, expire, unwind
- `e2e/floors-p3.spec.ts` — bot methods (reconcile, auto-protect, views)

All tests use a CDP virtual WebAuthn authenticator — real browser API, no mocks.

### End-to-end tests (extension)

```sh
pnpm --filter "@floors/extension" build
PW_DISABLE_TS_ESM=1 pnpm --filter "@floors/extension" e2e
```

Test files:
- `e2e/smoke-buy.spec.ts`
- `e2e/chip-injection.spec.ts`
- `e2e/multi-user-buy.spec.ts`

### Type checking

```sh
pnpm typecheck
```

### Linting

```sh
pnpm lint
```

---

## Key concepts

### Passkeys

User accounts are controlled by device passkeys (P-256 / ES256). No seed phrases. The passkey credential ID and compressed public key are stored in `localStorage` and registered on the NEAR wallet contract at account creation.

### Floors (downside protection)

A *floor* is an on-chain position on the `floors` contract. When a user buys a token with a floor, the relayer opens a floor that locks a USDC reserve. If the token price falls below the strike, the contract automatically sells the position back to USDC. The user is guaranteed to recover at least the floor value.

### NEAR Intents / 1Click

Swaps route through NEAR Intents (`intents.near`) via the 1Click solver API (`https://1click.chaindefuser.com`). The relayer submits signed solver quotes on behalf of users.

### WYSIWYS

Before any WebAuthn signature, the extension displays a human-readable summary of the exact on-chain action being signed (What You See Is What You Sign). This is enforced by `@floors/intents::verifyAgainstSheet`.

---

## Brand

```
brand/
  xecute-logo.svg   # Full wordmark — 192×60, for README headers, marketing, og:image
  xecute-icon.svg   # Icon only — 56×60, for favicons, extension icon, app shortcuts
```

Colors: orange `#EF7B28` · teal `#29CEB4` · purple `#9662FF` · dark `#111111` · warm bg `#FAF9F6`

Typeface: [Plus Jakarta Sans](https://fonts.google.com/specimen/Plus+Jakarta+Sans) weight 900 for wordmark, 800 for headings.

Use the full wordmark for external contexts (docs, GitHub, marketing). Use the icon-only variant for favicons, browser extension icons, and app shortcuts.

---

## Service ports

| Service | Port | Purpose |
|---|---|---|
| api | 3001 | User-facing REST API |
| relayer | 3002 | NEAR transaction relay, floor bot |
| risk | 3003 | Quote signing, capacity management |
| registry | 3004 | Token metadata |
| indexer | 3005 | On-chain event indexer |
| Web app | 5173 | Onboarding UI (dev only) |
| Postgres | 5432 | Shared database |
| NEAR sandbox | 3030 | Local NEAR RPC |
| Mock solver | 4040 | 1Click solver stub |

---

## Environment variables reference

### All services (base)

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | yes | — | `local` \| `testnet` \| `canary` \| `production` |
| `PORT` | yes | — | HTTP listen port |
| `DATABASE_URL` | yes | — | Postgres connection URL |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | — | OpenTelemetry collector URL |

### api (additional)

| Variable | Default | Description |
|---|---|---|
| `RELAYER_URL` | `http://localhost:3002` | Relayer service URL |
| `RISK_URL` | `http://localhost:3003` | Risk service URL |

### relayer (additional)

| Variable | Default | Description |
|---|---|---|
| `NEAR_NODE_URL` | `http://localhost:3030` | NEAR RPC URL |
| `NEAR_NETWORK_ID` | `sandbox` | `sandbox` \| `testnet` \| `mainnet` |
| `NEAR_ACCOUNT_ID` | — | Relayer signing account |
| `NEAR_PRIVATE_KEY` | — | `ed25519:<base58-key>` |
| `WALLET_CONTRACT_CODE_HASH` | — | SHA-256 of wallet WASM (64 hex chars) |
| `FLOORS_CONTRACT` | `floors.floors-dev.testnet` | Floors contract account |
| `ONE_CLICK_API_URL` | `https://1click.chaindefuser.com` | 1Click solver endpoint |
| `INTERNAL_SECRET` | — | Bearer secret for bot endpoints (omit to leave open in dev) |

### risk (additional)

| Variable | Description |
|---|---|
| `RISK_SIGNING_KEY_HEX` | 32-byte Ed25519 seed hex (64 chars) — signs floor quotes |

### Extension / web app

| Variable | Default | Description |
|---|---|---|
| `VITE_API_URL` | `http://localhost:3001` | API base URL |
| `VITE_REQUIRE_INVITE` | `false` | Set `true` to require invite codes at signup |

---

## Makefile targets

```sh
make test           # pnpm test + cargo test
make test-contracts # cargo test only
make lint           # pnpm lint
make typecheck      # pnpm typecheck
make build          # pnpm build
make stack          # docker compose up -d (all services)
make stack-down     # docker compose down
make stack-services # postgres only + all 5 Node services in background
make e2e            # build extension + run playwright
```

---

## Project structure (detailed)

```
apps/extension/
  src/
    background/       # Service worker
    content/          # Content script — chip injection into X posts
    entrypoints/
      sheet/          # Buy sheet side-panel (React)
apps/web/
  src/
    api/              # API client
    lib/              # passkey.ts, utils
    screens/          # One file per onboarding screen
  e2e/                # Playwright specs

services/api/
  src/
    routes/           # accounts, quotes, actions, submit, buy
    migrations/       # SQL migration files

services/relayer/
  src/
    routes/           # relay.ts (NEAR tx relay + floor bot endpoints)
  migrations/

contracts/floors/
  src/
    floors.rs         # Core floor lifecycle (open, close, sell_to_floor)
    bot_methods.rs    # Auto-protect, reconcile, unwind
    receivers.rs      # ft_on_transfer, on_open_price, on_sell_payout
    receivers_auth.rs # on_auth (user-signed actions: close, sell, withdraw)
    state.rs          # All storage structs
    views.rs          # Read-only view methods
  tests/              # Integration tests (near-workspaces)
```

---

## Contributing

PRs require review from `@philotheephilix`. Contract changes under `contracts/` require two approvals.

**No mocks.** Tests run against real infrastructure — CDP virtual WebAuthn for passkeys, real Postgres, real NEAR sandbox or testnet. `page.route()`, `vi.mock()`, and stubbed responses are not allowed.
