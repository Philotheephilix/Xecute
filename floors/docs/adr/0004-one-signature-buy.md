# ADR-0004: One-Signature Buy Flow

Date: 2026-11-13
Status: Accepted

## Context

The core product promise is: user sees `$ETH` chip in the extension, taps "Buy", authenticates
once with their passkey, and the ETH arrives. We need to determine whether this is achievable
with a **single passkey signature** or whether the protocol forces two separate signatures.

## Research findings

### 1. Full flow map

```
Extension chip (cashtag detected)
  └─► Sheet opens with token + amount
        └─► User taps "Buy" → navigator.credentials.get() [ONE SIGNATURE]
              └─► Intent payload constructed client-side
                    ├─ add_public_key (first-time users only — see note)
                    ├─ token_diff { give: NEAR/USDC, receive: ETH }
                    └─ storage_deposit (if intents.near slot not yet paid)
              └─► Signed payload → Relayer/API
                    └─► publish_intents → solver relay (wss://solver-relay-v2.chaindefuser.com)
                          └─► Solver fills → execute_intents on intents.near
                                └─► ft_withdraw ETH to user's destination address
```

### 2. `execute_intents` multi-intent array

From the llms-full.txt documentation (offset 300 000):

> `execute_intents` accepts **a list of cryptographically signed intent payloads** and executes
> them sequentially on-chain.

The intent payload structure includes:

```json
{
  "signer_id": "0s<hash>",
  "verifying_contract": "intents.near",
  "deadline": "<ISO8601>",
  "nonce": "<32-byte hex>",
  "intents": [
    { "intent": "add_public_key", "public_key": "p256:..." },
    { "intent": "token_diff", ... },
    { "intent": "storage_deposit", ... }
  ]
}
```

The `intents` field is an **array** — multiple action objects can be bundled into a single
signed payload. A single WebAuthn credential.get() call signs the entire array.

The solver relay also supports `publish_intents` (plural) for batch submission with auto-retry.

### 3. First-time user: `add_public_key` in the same payload

`add_public_key` is an intent type like any other — it can appear as the first element in the
`intents` array of the same signed payload that contains the `token_diff`. This means:

- First-time user: one signature covers `[add_public_key, storage_deposit, token_diff]`
- Returning user: one signature covers `[token_diff]`

**There is no protocol-level requirement for two separate transactions.**

### 4. `ft_withdraw` and `storage_deposit` in the same batch

The available intent types (from docs) include:
- `transfer` — move tokens between accounts inside the Verifier
- `token_diff` — declare exchange willingness (matched by market makers)
- `ft_withdraw` — withdraw fungible tokens to external accounts
- `storage_deposit` — pay for NEP-145 storage on token contracts
- `add_public_key` / `remove_public_key` — key management

All can be combined in one `intents` array.

### 5. Opening a "floor" vs. the buy

A "floor" in the Floors product is a price-limit intent (min price the user will accept).
This maps to `token_diff` with specific price constraints. The floor open and the buy intent
are the **same intent type** — the floor IS a buy intent with a floor price. No second
signature is needed to "open a floor" separately from "executing the buy."

If we implement floors as limit orders (resting in the solver relay), a `token_diff` placed
at a specific rate can sit unmatched until price is met — this is a single signed intent, one
signature, and the solver fills it when the price condition is satisfied.

### 6. Limitations

- The signed payload has one `signer_id` and one `nonce` — it cannot be partially executed.
  If any intent in the array fails, behavior depends on Verifier semantics (sequential execution
  means later intents may not run if an earlier one fails; needs confirmation via `simulate_intents`).
- The wallet contract (smart account) request model uses `internal` + `external` flat promises
  (v0.2.0); the signing is over the wallet request, not directly over `Nep413Payload`. Clarify
  whether wallet-contract requests wrap intents or delegate directly to `intents.near`.

## Decision

**Go.**

A single passkey signature can cover `add_public_key + storage_deposit + token_diff` in one
`intents` array. The flow is single-signature for both first-time and returning users.
Opening a floor and buying are the same `token_diff` intent — no second signature needed.

## Consequences

- Client SDK must construct a multi-intent `Nep413Payload` for first-time users.
- Use `simulate_intents` (read-only) before submission to catch failures early.
- The relayer should use `publish_intents` (batch with auto-retry) to the solver relay.
- UX: show "first setup" vs "buy" badge but both require only one biometric touch.
- Error handling: if `add_public_key` in the array fails (e.g., key already registered),
  the entire batch may fail — detect this client-side and submit without `add_public_key`
  for returning users.

## Open items

1. Confirm Verifier sequential-failure semantics: does a failed `add_public_key` (duplicate)
   abort the entire intent array or is it idempotent?
2. Clarify the wallet contract v0.2.0 request signing path vs. direct Nep413Payload signing.
3. Determine gas budget needed for a 3-intent array to avoid out-of-gas failures.
