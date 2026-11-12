# ADR-0003: Smart Account Creation — Wallet Contract Version

Date: 2026-11-13
Status: Needs-follow-up

## Context

Floors creates a NEAR smart account (wallet contract) for each new user, keyed to their
passkey. We need to pin: which wallet contract version to deploy, its code hash, and the
exact top-up (NEAR) required for a freshly created passkey account to execute intents.

## Research findings

### 1. Wallet contract repository

Source: `near/intents` — `contracts/wallet/` directory.

The wallet contract is a minimalist account-abstraction contract supporting:
- Extensions (2FA, social recovery, session keys)
- Passkeys (P-256 **and** Ed25519)
- Non-sequential nonces (concurrent requests without head-of-line blocking)
- Deterministic addresses (no factory needed)
- NEP-448 zero-balance accounts (≤ 770 bytes footprint)

The README carries an **unaudited** security warning.

### 2. Latest releases

From the GitHub Releases page (`near/intents/releases`):

| Tag | Date | Type | Commit |
|-----|------|------|--------|
| `wallet-contracts-v0.2.0` | 2024-06-30 | **Pre-release** | `930902e` |
| `defuse/v0.4.2` | 2025-02-16 | Release | — |
| `global-deployer/v0.1.0` | 2025-03-04 | Release | — |
| `global-deployer/v0.2.0` | 2025-03-09 | Latest release | — |

**v0.2.0 breaking changes from v0.1.x:**
- Hash algorithm: SHA-256 → **SHA3-256** for request signing
- `created_at` encoding: seconds (u32) → nanoseconds (u64)
- Domain string: `NEAR_WALLET_CONTRACT/V1` (unchanged)
- Request format: `ops`/`out` DAG → `internal`/`external` flat promises
- Promise chains removed (flat concurrent execution only)
- Nonce timestamp encoding changed → affects NEP-616 account ID derivation

The **on-chain code hash** for v0.2.0 is not published in the releases page metadata;
binary artifacts had loading errors. This is an open item.

### 3. NEP-616 address derivation

NEP-616 specifies deterministic account IDs:

```
account_id = "0s" ++ hex(keccak256(state_init)[12..32])
```

The `StateInit` contains:
- Code reference (global contract hash or account ID)
- Key-value pairs for initial storage (includes the passkey public key and nonce timestamp)

For v0.2.0, the nonce timestamp uses nanoseconds; any StateInit produced against v0.1.x
must be regenerated.

This means the passkey `(x, y)` coordinates and a creation timestamp (nanoseconds) are the
entropy sources for the deterministic account ID — clients can reconstruct the same address
given the same inputs without contacting the chain.

### 4. NEAR top-up required

Costs for a fresh passkey wallet account to be operational:

| Item | Approx. cost | Source |
|------|-------------|--------|
| Account creation (770-byte footprint, NEP-448) | ~0.007 NEAR | NEAR storage staking: 1E19 yN/byte × 770 = 0.0077 NEAR |
| `intents.near` storage deposit (user slot, ~100 bytes) | ~0.001 NEAR | 1E19 yN/byte × 100 |
| Gas for `add_public_key` intent | ~0.0005 NEAR | estimate; confirmation needed |
| `passkeys-registry.near` storage (if separate) | ~0.001 NEAR | TBD (open item) |
| 1-yocto for `execute_intents` call | negligible | standard NEAR pattern |

**Conservative top-up estimate: 0.01 NEAR** covers creation + first intent registration.

NEAR storage staking rate: **10^19 yoctoNEAR per byte** = 0.00001 NEAR/byte.

### 5. Does `intents.near` accept `add_public_key` from a `0s...` smart account?

The documentation states that **named accounts require explicit key registration** via the
`add_public_key` intent. A `0s...` account is a named account (it has a human-readable ID
derived deterministically). Therefore yes: the first action for a `0s...` passkey wallet
must be submitting `add_public_key` to `intents.near`.

The Verifier does not have special restrictions on the shape of the calling account ID
for `add_public_key`; it accepts any named account.

## Decision

**Conditional-Go.**

Pin to `wallet-contracts-v0.2.0` (commit `930902e`). The contract supports P-256 passkeys,
NEP-448 zero-balance layout, and deterministic NEP-616 addresses. However, the on-chain
code hash is not yet confirmed, and the contract is still pre-release / unaudited.

Conditions:
1. Retrieve the compiled WASM code hash from the release artifacts or by compiling locally.
2. Use the NEAR testnet to deploy and measure actual storage requirements before hardcoding
   the 0.01 NEAR top-up figure.
3. Evaluate audit status before mainnet launch; the README explicitly warns against
   storing significant funds.

## Consequences

- Client SDK must generate StateInit with SHA3-256 request signing and nanosecond timestamps.
- Account ID for a user derives from `"0s" ++ hex(keccak256(state_init)[12..32])`.
- Top-up flow: relayer sends ≥ 0.01 NEAR to the derived `0s...` address before the user's
  first transaction lands.
- Switching wallet contract versions later requires a migration plan (StateInits are version-dependent).

## Open items

1. Download the v0.2.0 release WASM artifact and record its SHA-256/Blake2 code hash.
2. Deploy to `floors-contract.floors-dev.testnet` and measure exact storage costs empirically.
3. Confirm `passkeys-registry.near` ABI — is a separate registry call needed alongside
   `add_public_key` on `intents.near`?
4. Monitor the near/intents repo for a stable audited release before mainnet.
