# ADR 0001 — Toolchains and Monorepo Structure

**Date:** 2026-11-13
**Status:** Accepted
**Deciders:** philotheephilix

---

## Context

Floors is a cross-chain intent-based DeFi protocol requiring:
- Smart contracts (on-chain logic) written in Rust targeting NEAR / Solana
- Off-chain services (API, relayer, risk engine, registry, indexer) in TypeScript
- Browser extension and web/admin frontends in TypeScript + React
- Shared type definitions and business-logic libraries across all of the above

A monorepo is the natural fit: shared types flow from a single source of truth, CI runs uniformly, and refactors cross boundaries without friction.

---

## Decision

### Language runtimes

| Layer | Runtime | Pin |
|---|---|---|
| Smart contracts | Rust | `stable` (via `rust-toolchain.toml`) |
| Node services & apps | Node.js | `26` (LTS, via `.nvmrc`) |
| Package manager | pnpm | `12.18.0` (no `^`/`~`) |

**Rust stable** was chosen over nightly because protocol contracts must be reproducible and auditable; nightly features introduce churn risk.

**Node 26** is the current LTS at decision time. The `>=26` engine constraint blocks accidental downgrades.

**pnpm 12** over npm/yarn: deterministic installs, content-addressable store, first-class workspace protocol (`workspace:*`).

### Build orchestration

**Turborepo** manages the TypeScript workspace task graph (`build → test → lint → typecheck`). It caches build artifacts locally and in CI, keeping incremental feedback fast.

### Frontend stack

- **WXT (MV3)** for the browser extension — provides a modern Manifest V3 framework with HMR and multi-browser support.
- **Vite + React** for web and admin apps — fast ESM-based dev server, tree-shaking, excellent TypeScript integration.

### Backend stack

- **Fastify** for the API service — low overhead, schema-first (JSON Schema + TypeBox), native async/await.
- **Postgres 16** as the primary data store — JSONB for flexible intent state, strong ACID guarantees for financial data.

### Code quality

- TypeScript: `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` — eliminates entire classes of runtime errors.
- ESLint flat config with `@typescript-eslint/strict-type-checked`; `no-explicit-any` is an **error**.
- Prettier for formatting — enforced in CI via ESLint's prettier integration.
- Rust: `rustfmt` + `clippy -D warnings -W clippy::pedantic` — zero lint tolerance in CI.

### Versioning convention

All commits follow **Conventional Commits** (`feat:`, `fix:`, `chore:`, etc.). This enables automated changelog generation and semantic release tooling in future sprints.

---

## Consequences

- No floating version pins anywhere (`^`, `~`, `latest` banned). Every dep is exact.
- `pnpm-lock.yaml` and `Cargo.lock` are committed; reproducible installs are guaranteed.
- CI enforces the full quality bar on every PR to `main`.
- New packages/services must extend `tsconfig.base.json` and opt in to all strict checks.
