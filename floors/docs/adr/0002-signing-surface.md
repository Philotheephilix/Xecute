# ADR-0002: Signing Surface — WebAuthn as NEAR Intents Signer

Date: 2026-11-13
Status: Accepted

## Context

Floors needs a single passkey signature (P-256 WebAuthn) to authorize NEAR Intent execution.
Before building the extension sign flow we must confirm that `intents.near` (the Defuse Verifier
contract) actually accepts P-256 signatures and that the WebAuthn challenge bytes are
constructible client-side.

## Research findings

### 1. Supported signature schemes on `intents.near`

The Defuse Verifier contract (`intents.near`) validates signatures across multiple standards.
From the llms-full.txt documentation (offset 300 000):

| Standard | Wallets |
|----------|---------|
| NEP-413 | MyNearWallet, Meteor, Sender |
| ERC-191 | MetaMask and EVM wallets |
| **P-256 WebAuthn (Passkey Registry)** | **Passkeys — P-256 and Ed25519** |
| Raw Ed25519 | Solana (Phantom, Solflare) |
| TIP-191 | TRON |
| TonConnect | TON |
| SEP-53 | Stellar |

P-256 WebAuthn is an **explicitly supported first-class scheme**. The Verifier includes
`client_data_json` and `authenticator_data` fields for browser-based verification.

**Public key encoding constraint:** P-256 keys must be supplied in uncompressed form
(raw 64-byte `x || y` coordinates, no prefix). Compressed keys are rejected.

**Signature encoding:** 64 bytes `r || s` (low-S normalized).

Source: `near/intents` crates/signatures/webauthn — the `webauthn` crate is a dedicated
signing-standard implementation inside the intents monorepo.

### 2. `add_public_key` intent

Passkey public keys are registered via the `add_public_key` intent:

```json
{
  "intent": "add_public_key",
  "public_key": "p256:..."
}
```

Named NEAR accounts (including `0s...` smart accounts) must submit this intent before any
further intent execution. Implicit accounts (those whose ID derives from the key itself) skip
this step. For a passkey smart account created per ADR-0003, `add_public_key` is the
first on-chain action.

### 3. WebAuthn challenge format

Signing chain for a NEAR Intents payload over WebAuthn (from the webauthn crate source):

```
signed_bytes = authenticator_data || SHA-256(client_data_json)
```

The **challenge** field inside `client_data_json` carries the NEAR-specific payload.
From `crates/signatures/nep413/src/lib.rs`:

```rust
pub fn prehash(payload: &Nep413Payload) -> [u8; 32] {
    SHA-256( OFFCHAIN_PREFIX_TAG(2147484061 as u32) ++ borsh(payload) )
}
```

So the full construction client-side is:

1. Serialize the `Nep413Payload` (message + nonce + recipient + optional callback_url) with Borsh.
2. Prepend the 4-byte big-endian prefix tag `0x800000DD` (2147484061).
3. SHA-256 hash → 32 bytes.
4. Base64url-encode (no padding) → place into `client_data_json.challenge`.
5. Call `navigator.credentials.get({ challenge: raw32Bytes })`.
6. Submit `(authenticator_data, client_data_json, r||s signature)` to the Verifier.

### 4. `passkeys-registry.near`

The near/intents wallet README references passkeys as a signing extension. The actual
registry contract for passkey key records is managed by the wallet extensions system;
`passkeys-registry.near` is the on-chain store of (account → P-256 public key) mappings.
Its exact ABI was not retrieved in this spike; a follow-up is required to confirm whether
`add_public_key` goes directly to `intents.near` (as an intent) or also requires a separate
call to `passkeys-registry.near`.

The llms-full.txt documentation confirms "Passkeys use the Web Authentication standard,
supporting both P-256 and Ed25519 curves. The system includes `client_data_json` and
`authenticator_data` fields for browser-based verification."

## Decision

**Go.**

P-256 WebAuthn is a supported first-class signing scheme on `intents.near`. The challenge
construction is well-specified (Borsh-serialized Nep413Payload → SHA-256 → base64url).
The extension can use `navigator.credentials.get()` and pass the resulting `authenticator_data`
+ `client_data_json` + `(r, s)` to the Verifier.

## Consequences

- Extension must construct the WebAuthn challenge as: `base64url(SHA-256(0x800000DD ++ borsh(Nep413Payload)))`.
- P-256 public keys must be stored as uncompressed 64-byte `x||y`; prefix `p256:` + base58.
- First-time users need one `add_public_key` intent before any buy flow (see ADR-0004 re: batching).
- The wallet extension contracts in `near/intents` contain the reference implementation for the client_data_json verification path.

## Open items

1. Confirm whether `add_public_key` (as an intent to `intents.near`) is sufficient or whether
   a separate call to `passkeys-registry.near` is also required.
2. Obtain the exact `origin` value required in `client_data_json` for the Chrome extension context
   (`chrome-extension://<id>` vs relying-party override).
3. Validate the OFFCHAIN_PREFIX_TAG value (2147484061) against the deployed contract ABI.
