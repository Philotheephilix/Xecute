<p align="center">
  <img src="brand/xecute-logo.svg" alt="Xecute" width="280" />
</p>

<h3 align="center">Buy crypto from X posts — with a floor.</h3>

<p align="center">
  <a href="https://near.org"><img src="https://img.shields.io/badge/NEAR-Protocol-000?style=for-the-badge&logo=near&logoColor=white" alt="NEAR Protocol" /></a>
  <a href="https://testnet.nearblocks.io/address/floors.floors-dev.testnet"><img src="https://img.shields.io/badge/Testnet-Live-29CEB4?style=for-the-badge" alt="Testnet Live" /></a>
  <img src="https://img.shields.io/badge/Chrome-Extension-EF7B28?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Chrome Extension" />
  <img src="https://img.shields.io/badge/Rust-Smart_Contract-111?style=for-the-badge&logo=rust&logoColor=white" alt="Rust" />
  <img src="https://img.shields.io/badge/WebAuthn-Passkeys-9662FF?style=for-the-badge" alt="WebAuthn Passkeys" />
</p>

<p align="center">
  <strong>NEAR Hackathon Submission</strong> · Track: <em>Markets That Never Close</em>
</p>

---

## The Problem

You bought ETH at $1,900. It dropped to $1,500. **-21%.** No warning. No safety net. No way out.

That's not investing. That's gambling. And right now, buying crypto from social media requires switching to an exchange, managing seed phrases, and accepting unlimited downside risk on every trade.

## The Solution

**Xecute** is a Chrome extension that lets you buy crypto directly from X.com posts — with built-in downside protection called a **floor**.

<table>
<tr>
<td width="33%" align="center">
  <h3>1. See</h3>
  <p>Browse X. Spot a tweet about <code>$ETH</code>. An orange <strong>Buy</strong> chip appears next to the cashtag.</p>
</td>
<td width="33%" align="center">
  <h3>2. Buy</h3>
  <p>Tap the chip. Pick your amount. Set your floor level. Confirm with Face ID or fingerprint.</p>
</td>
<td width="33%" align="center">
  <h3>3. Protected</h3>
  <p>You own the token. If it pumps, you keep every dollar. If it dumps, <strong>your floor catches you</strong>.</p>
</td>
</tr>
</table>

> **Downside: capped. Upside: yours.**

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────────┐
│                           X.com Feed                                │
│                                                                     │
│   @VitalikButerin: "ETH looking strong $ETH 🔥"  [Buy $ETH]       │
│                                                     ▲ Injected chip │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ Click
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       Extension Buy Sheet                           │
│                                                                     │
│   Buy $100 ETH                                                      │
│   Floor: 95%  ·  Strike: $1,791/ETH  ·  Fee: $0.50                │
│   Duration: 30 days                                                 │
│                                                                     │
│                  [ Confirm with Face ID ]                            │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ WebAuthn P-256 signature
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          NEAR Testnet                               │
│                                                                     │
│   ┌──────────┐    ┌──────────┐    ┌───────────────────────┐        │
│   │ Ref      │───▶│ floors   │───▶│ User's 0s... account  │        │
│   │ Finance  │    │ contract │    │ (NEP-616 passkey      │        │
│   │ DEX Swap │    │ escrow + │    │  smart wallet)        │        │
│   └──────────┘    │ reserve  │    └───────────────────────┘        │
│                   └──────────┘                                      │
│                        │                                            │
│               Floor active ✓                                        │
│          Protected for 30 days                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Floor Protection

A **floor** is on-chain price insurance. When you buy ETH with a 95% floor:

- The contract locks your ETH in escrow
- USDC equal to `qty * floor_price` is reserved from the insurance pool (the "sleeve")
- **If ETH drops below your floor price** — sell to floor, receive the guaranteed USDC amount
- **If ETH rises** — close the position, take your ETH back, sell at market for full upside
- **If the floor expires** — ETH is returned to you automatically

---

## Architecture

```
┌────────────────┐     ┌──────────────────────────────────────────────┐
│  Chrome MV3    │     │               Backend Services               │
│  Extension     │     │                                              │
│  ┌───────────┐ │     │  ┌─────┐  ┌─────────┐  ┌──────┐  ┌───────┐ │
│  │ Content   │─┼────▶│  │ API │─▶│ Relayer │─▶│ NEAR │  │ Risk  │ │
│  │ Script    │ │     │  │:3001│  │ :3002   │  │ RPC  │  │ :3003 │ │
│  └───────────┘ │     │  └──┬──┘  └─────────┘  └──────┘  └───────┘ │
│  ┌───────────┐ │     │     │                                        │
│  │ Buy Sheet │ │     │  ┌──┴──┐  ┌──────────┐  ┌───────┐          │
│  │ (Preact)  │ │     │  │ DB  │  │ Registry │  │Indexer│          │
│  └───────────┘ │     │  │Pg   │  │ :3004    │  │:3005  │          │
└────────────────┘     │  └─────┘  └──────────┘  └───────┘          │
                       └──────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         NEAR Testnet                                 │
│                                                                      │
│  floors.floors-dev.testnet  ·  Rust  ·  near-sdk 5.24               │
│  Wallet: NEP-616 deterministic (WebAuthn P-256 passkeys)            │
│  DEX: Ref Finance (testnet pool 2980)                               │
│  Oracle: Pyth (mock on testnet)                                     │
│  Quotes: Ed25519 signed floor quotes from risk service              │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Component | Technology | Description |
|-----------|-----------|-------------|
| **Smart Contract** | Rust + near-sdk 5.24 | Floor lifecycle: open, sell, close, expire, auto-protect |
| **Extension** | WXT 0.20 + Chrome MV3 | Content script injects buy chips on X.com cashtag links |
| **Buy Sheet** | Preact + inline styles | Popup window (412x680) for the full purchase flow |
| **Web App** | React + Vite + Tailwind | Onboarding, portfolio dashboard, position management |
| **API** | Fastify 5 + TypeScript | REST endpoints, quote cache, submission tracking |
| **Relayer** | Fastify 5 + near-api-js | NEAR transaction signing, Ref Finance swaps, floor bot |
| **Risk** | Fastify 5 + Ed25519 | Floor quote pricing, capacity management, quote signing |
| **Wallet** | NEP-616 + WebAuthn P-256 | Deterministic smart accounts — no seed phrases |
| **DEX** | Ref Finance (testnet) | AMM swap via `ft_transfer_call` to pool 2980 |
| **Oracle** | Pyth Network | On-chain price verification for floor opening |
| **Intents** | NEAR Intents + 1Click | Cross-chain settlement (mainnet), solver network |
| **Database** | PostgreSQL | Shared DB for API + relayer schemas |
| **Monorepo** | Turborepo + pnpm | Shared packages, parallel builds |

---

## Hackathon Track Fit

### Track 1: Markets That Never Close

Xecute is built for this track:

- **Non-custodial trading from social media** — no exchange account, no KYC, no app switching. Buy crypto from an X.com post with a passkey.
- **Floor protection = decentralized put options** — the `floors` smart contract provides downside insurance backed by an on-chain USDC reserve pool, eliminating the need for centralized options desks.
- **Settles on NEAR** — all swaps execute through Ref Finance on testnet, NEAR Intents + 1Click solver network on mainnet. Deep liquidity, no custodian.
- **Can't be shut down** — the contract is on-chain, the extension runs locally, wallets are self-custodial. No single entity to switch it off.
- **Chain Signatures ready** — NEP-616 deterministic wallets use WebAuthn P-256 passkeys. The same key derivation path extends to cross-chain signing.

### Track 4: Open Innovation

Buying crypto from a social media post with built-in downside protection is a new primitive. It combines social commerce, browser extension UX, passkey wallets, and on-chain derivatives into something that doesn't fit existing categories.

---

## Features

- [x] Chrome extension with X.com cashtag detection (`$ETH`, `$SOL`)
- [x] Buy ETH with floor price protection (5% / 10% configurable)
- [x] WebAuthn passkeys — Face ID / fingerprint, no seed phrases
- [x] NEP-616 deterministic wallet addresses (`0s...`)
- [x] Ref Finance DEX integration (testnet pool 2980)
- [x] Full floor lifecycle: open, sell to floor, close, expire
- [x] Auto-protect bot (sells at floor before expiry if price drops)
- [x] Real-time PnL tracking with portfolio chart
- [x] Portfolio dashboard with positions and activity feed
- [x] Ed25519 signed floor quotes from risk service
- [x] Pyth oracle price verification on-chain
- [x] WYSIWYS — What You See Is What You Sign (tamper-proof quote display)
- [x] 4-tab navigation: Home, Portfolio, Activity, Settings
- [x] Multiple passkey support per account
- [x] SSE real-time order tracking (submitted → tracking → done)
- [x] Partial outcome handling (swap succeeds, floor fails → user chooses next step)
- [x] SOL/BTC graceful "coming soon" handling
- [x] Invite code gating (optional)
- [x] Neo-brutalist design system (thick borders, hard shadows, bold typography)

---

## Live on Testnet

All transactions are verifiable on [NEAR Testnet Explorer](https://testnet.nearblocks.io).

| Resource | Address |
|----------|---------|
| **Floors Contract** | [`floors.floors-dev.testnet`](https://testnet.nearblocks.io/address/floors.floors-dev.testnet) |
| **USDC Token** | `usdc.fakes.testnet` |
| **ETH Token** | `eth.fakes.testnet` |
| **Ref Finance** | Pool 2980 on `ref-finance-101.testnet` |

### Verified Transaction Hashes

| Operation | TX Hash | Status |
|-----------|---------|--------|
| Floor Open | [`8cA7Km...`](https://testnet.nearblocks.io/txns/8cA7Km7cqh5dvb9KZ1dpcNsnESTu3exY6QB96mS2K6Ta) | ✅ Success |
| Sell to Floor | [`GtTCtU...`](https://testnet.nearblocks.io/txns/GtTCtURjWfBEyyYNfPz4apxLSf2wMizYteMTH7PtQqtz) | ✅ Success |
| Close Position | [`G53rf5...`](https://testnet.nearblocks.io/txns/G53rf5VsUhA91HdqpdcXDyeWXx2xKeBbQGZbQVehuAE6) | ✅ Success |
| Expire Floor | [`C8rLZv...`](https://testnet.nearblocks.io/txns/C8rLZvEBpyhfTS61qjaCCfDdeapcsc4zQ6a3opHfSzLo) | ✅ Success |
| Ref Finance Swap | [`7zcT5y...`](https://testnet.nearblocks.io/txns/7zcT5ySuXByd7958DCdrBbMYbTL3Ngi8UR2qaSUHUZMU) | ✅ Success |

---

## How to Test

### Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 26+ |
| pnpm | 12+ |
| Docker | any recent |
| Rust + Cargo | stable (for contract tests) |

### Step-by-step

```bash
# 1. Clone the repo
git clone https://github.com/Philotheephilix/Xecute.git
cd Xecute/floors

# 2. Install dependencies
pnpm install

# 3. Start Postgres
docker compose up -d postgres

# 4. Create environment files
# services/api/.env.local
cat > services/api/.env.local << 'EOF'
NODE_ENV=local
PORT=3001
DATABASE_URL=postgres://floors:floors@localhost:5432/floors
RELAYER_URL=http://localhost:3002
RISK_URL=http://localhost:3003
EOF

# services/relayer/.env.local
cat > services/relayer/.env.local << 'EOF'
NODE_ENV=local
PORT=3002
DATABASE_URL=postgres://floors:floors@localhost:5432/floors
NEAR_NODE_URL=https://rpc.testnet.near.org
NEAR_NETWORK_ID=testnet
NEAR_ACCOUNT_ID=<your-testnet-account>
NEAR_PRIVATE_KEY=ed25519:<your-key>
WALLET_CONTRACT_CODE_HASH=<64-hex-chars>
FLOORS_CONTRACT=floors.floors-dev.testnet
EOF

# services/risk/.env.local
cat > services/risk/.env.local << 'EOF'
NODE_ENV=local
PORT=3003
DATABASE_URL=postgres://floors:floors@localhost:5432/floors
RISK_SIGNING_KEY_HEX=<64-hex-ed25519-seed>
EOF

# 5. Build shared packages
pnpm build

# 6. Start all services
make stack-services
# Or individually:
# pnpm --filter "@floors/api" dev
# pnpm --filter "@floors/relayer" dev
# pnpm --filter "@floors/risk" dev

# 7. Start the web app
pnpm --filter "@floors/web" dev
# → http://localhost:5173

# 8. Build the Chrome extension
pnpm --filter "@floors/extension" build
# → apps/extension/.output/chrome-mv3/
```

### Load the extension

1. Open `chrome://extensions` (or `brave://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `apps/extension/.output/chrome-mv3/`

### Try it

1. Visit [x.com](https://x.com) and search for `$ETH`
2. Orange **Buy** chips appear next to cashtag mentions
3. Click a chip or the extension toolbar icon
4. Create a wallet (passkey — Face ID / fingerprint)
5. Fund your account with testnet USDC (send to your `0s...` address)
6. Buy ETH with floor protection
7. Check your portfolio — positions, PnL, activity feed

### Run tests

```bash
# TypeScript unit tests
pnpm test

# Rust contract tests
cd contracts/floors && cargo test

# E2E tests (web app) — requires services running
cd apps/web && PW_DISABLE_TS_ESM=1 pnpm exec playwright test

# E2E tests (extension)
pnpm --filter "@floors/extension" build
PW_DISABLE_TS_ESM=1 pnpm --filter "@floors/extension" e2e
```

---

## Project Structure

```
floors/
├── apps/
│   ├── extension/          # Chrome MV3 extension (WXT 0.20)
│   │   ├── src/entrypoints/
│   │   │   ├── content.ts          # Cashtag detection + chip injection
│   │   │   ├── bridge.content.ts   # Message forwarding + storage sync
│   │   │   ├── background.ts       # Service worker
│   │   │   └── sheet/              # Buy sheet popup (Preact)
│   │   └── e2e/                    # Playwright extension tests
│   └── web/                # Onboarding + portfolio app (React + Vite)
│       ├── src/screens/            # Welcome → Fund → Home → Portfolio
│       └── e2e/                    # Playwright web tests
├── contracts/
│   └── floors/             # NEAR smart contract (Rust, near-sdk 5.24)
│       ├── src/
│       │   ├── lib.rs              # Contract entry, initialization
│       │   ├── floors.rs           # Core lifecycle: open, close, sell, expire
│       │   ├── sleeves.rs          # Insurance pool management
│       │   ├── bot_methods.rs      # Auto-protect, reconcile, unwind
│       │   ├── receivers.rs        # ft_on_transfer, mt_on_transfer
│       │   └── receivers_auth.rs   # on_auth (user-signed actions)
│       └── tests/                  # Integration tests
├── packages/
│   ├── intents/            # WYSIWYS intent signing helpers
│   ├── money/              # Bigint token math
│   ├── pricing/            # Price feeds (Pyth + CoinGecko)
│   ├── registry-schema/    # Shared token registry types
│   ├── shared-server/      # Fastify base, DB, migrations
│   ├── types/              # Cross-package TypeScript types
│   └── wallet/             # NEP-616 address derivation
└── services/
    ├── api/                # REST API (Fastify 5)            :3001
    ├── relayer/            # NEAR tx relay + floor bot       :3002
    ├── risk/               # Quote pricing + Ed25519 signing :3003
    ├── registry/           # Token metadata                  :3004
    └── indexer/            # On-chain event indexer          :3005
```

---

## What's Next

- **Mainnet deployment** with real NEAR Intents and 1Click solver network
- **Cross-chain settlement** — buy ETH on Ethereum, SOL on Solana, all settling through NEAR
- **More assets** — SOL and BTC pools with dedicated sleeves
- **Mobile app** — same passkey, same floor protection, native experience
- **Auto-protect bot** — automatically sells at floor price before expiry if the market drops
- **Trading agents** — AI-powered buy signals that execute with floor protection
- **Limit floors** — set a floor that activates only if price reaches a target first

---

## Team

Built by [philotheephilix](https://github.com/Philotheephilix)

---

## License

MIT

---

<p align="center">
  <strong>Stop gambling. Start trading with a floor.</strong>
</p>

<p align="center">
  <a href="https://github.com/Philotheephilix/Xecute">GitHub</a> · <a href="https://testnet.nearblocks.io/address/floors.floors-dev.testnet">Contract on Testnet</a>
</p>
