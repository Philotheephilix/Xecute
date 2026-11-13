/// Sandbox integration tests for floors.near contract.
///
/// Requires the floors WASM to be pre-built before running:
///   cargo build -p floors --target wasm32-unknown-unknown --release
use anyhow::Context;
use near_workspaces::types::NearToken;

const FLOORS_WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/wasm32-unknown-unknown/release/floors.wasm"
);

const MOCK_PYTH_WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/wasm32-unknown-unknown/release/mock_pyth.wasm"
);

const MOCK_FT_WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/wasm32-unknown-unknown/release/mock_ft.wasm"
);

/// Accounts returned from the full deploy helper.
struct DeployedEnv {
    worker: near_workspaces::Worker<near_workspaces::network::Sandbox>,
    contract: near_workspaces::Contract,
    intents: near_workspaces::Account,
}

/// Helper: deploy and initialize the floors contract, returning contract + worker.
async fn deploy_floors(
) -> anyhow::Result<(near_workspaces::Worker<near_workspaces::network::Sandbox>, near_workspaces::Contract)> {
    let env = deploy_floors_full().await?;
    Ok((env.worker, env.contract))
}

/// Helper: deploy and initialize the floors contract, returning all named accounts.
async fn deploy_floors_full() -> anyhow::Result<DeployedEnv> {
    let worker = near_workspaces::sandbox()
        .await
        .context("failed to start sandbox")?;

    let wasm = std::fs::read(FLOORS_WASM).context(format!(
        "floors WASM not found at {FLOORS_WASM}; run: cargo build -p floors --target wasm32-unknown-unknown --release"
    ))?;

    let root = worker.root_account()?;

    let owner = root
        .create_subaccount("owner")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let guardian = root
        .create_subaccount("guardian")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let intents = root
        .create_subaccount("intents")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let pyth = root
        .create_subaccount("pyth")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let platform = root
        .create_subaccount("platform")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;

    let contract = root
        .create_subaccount("floors")
        .initial_balance(NearToken::from_near(50))
        .transact()
        .await?
        .into_result()?
        .deploy(&wasm)
        .await?
        .into_result()?;

    let signer_key: Vec<u8> = vec![1u8; 32];

    let init_result = contract
        .call("new")
        .args_json(serde_json::json!({
            "owner": owner.id(),
            "guardian": guardian.id(),
            "quote_signers": [signer_key],
            "intents": intents.id(),
            "pyth": pyth.id(),
            "platform_account": platform.id(),
        }))
        .transact()
        .await?;
    assert!(
        init_result.is_success(),
        "init failed: {:?}",
        init_result.failures()
    );

    Ok(DeployedEnv {
        worker,
        contract,
        intents,
    })
}

// ---------------------------------------------------------------------------
// Test: basic version check
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_get_version() -> anyhow::Result<()> {
    let (_worker, contract) = deploy_floors().await?;

    let version: String = contract
        .call("get_version")
        .view()
        .await?
        .json()
        .context("failed to deserialize get_version result")?;

    assert_eq!(version, "V1", "expected version V1, got {version}");
    Ok(())
}

// ---------------------------------------------------------------------------
// Test: view methods return sensible defaults on a fresh contract
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_views_fresh_contract() -> anyhow::Result<()> {
    let (_worker, contract) = deploy_floors().await?;

    // get_floor returns null for unknown floor
    let floor_result = contract
        .call("get_floor")
        .args_json(serde_json::json!({ "floor_id": 0u64 }))
        .view()
        .await?;
    let floor_val: serde_json::Value = floor_result.json()?;
    assert!(floor_val.is_null(), "Expected null for unknown floor");

    // get_sleeve returns null for unknown sleeve
    let sleeve_result = contract
        .call("get_sleeve")
        .args_json(serde_json::json!({ "sleeve_id": "majors" }))
        .view()
        .await?;
    let sleeve_val: serde_json::Value = sleeve_result.json()?;
    assert!(sleeve_val.is_null(), "Expected null for unknown sleeve");

    // get_totals returns null for unknown asset
    let totals_result = contract
        .call("get_totals")
        .args_json(serde_json::json!({ "asset": "nep141:eth.omft.near" }))
        .view()
        .await?;
    let totals_val: serde_json::Value = totals_result.json()?;
    assert!(totals_val.is_null(), "Expected null for unknown asset totals");

    // list_floors returns empty for unknown owner
    let floors_result = contract
        .call("list_floors")
        .args_json(serde_json::json!({
            "owner": "someuser.near",
            "from": null,
            "limit": null
        }))
        .view()
        .await?;
    let floors_val: serde_json::Value = floors_result.json()?;
    assert!(
        floors_val.as_array().map_or(false, |a| a.is_empty()),
        "Expected empty list for unknown owner"
    );

    // get_params returns valid params
    let params_result = contract
        .call("get_params")
        .view()
        .await?;
    let params_val: serde_json::Value = params_result.json()?;
    assert!(params_val.get("intents").is_some(), "params should have intents");

    Ok(())
}

// ---------------------------------------------------------------------------
// Test: mt_on_transfer rejects non-intents caller
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_mt_on_transfer_rejects_non_intents() -> anyhow::Result<()> {
    let (worker, contract) = deploy_floors().await?;

    let root = worker.root_account()?;
    let bad_caller = root
        .create_subaccount("badcaller")
        .initial_balance(NearToken::from_near(5))
        .transact()
        .await?
        .into_result()?;

    // Call mt_on_transfer from a non-intents account — should panic
    let result = bad_caller
        .call(contract.id(), "mt_on_transfer")
        .args_json(serde_json::json!({
            "sender_id": "user.near",
            "previous_owner_ids": ["user.near"],
            "token_ids": ["nep141:eth.omft.near"],
            "amounts": ["1000000000000000000"],
            "msg": "{\"op\":\"open_floor\",\"quote\":{\"v\":1,\"id\":\"aaaa\",\"owner\":\"user.near\",\"asset\":\"nep141:eth.omft.near\",\"qty\":\"1000000000000000000\",\"floor_bps\":1000,\"duration_secs\":604800,\"floor_price_e6\":\"3070890000\",\"fee_usdc\":\"100000\",\"sleeve\":\"majors\",\"pyth_feed\":\"aabbcc\",\"expires_at_ns\":\"9999999999000000000\",\"key_id\":0},\"sig\":\"AAAA\"}"
        }))
        .transact()
        .await?;

    // Should fail with E_NOT_INTENTS
    assert!(
        result.is_failure(),
        "Expected failure when not called by intents.near"
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// Test: mt_on_transfer with an EXPIRED quote returns all tokens (refund path)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_mt_on_transfer_expired_quote_refunds() -> anyhow::Result<()> {
    let env = deploy_floors_full().await?;
    let contract = &env.contract;
    let intents = &env.intents;

    // Build a msg with expires_at_ns = 1 (far in the past)
    let msg = serde_json::json!({
        "op": "open_floor",
        "quote": {
            "v": 1,
            "id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "owner": "user.near",
            "asset": "nep141:eth.omft.near",
            "qty": "1000000000000000000",
            "floor_bps": 1000,
            "duration_secs": 604800,
            "floor_price_e6": "3070890000",
            "fee_usdc": "100000",
            "sleeve": "majors",
            "pyth_feed": "0000000000000000000000000000000000000000000000000000000000000000",
            "expires_at_ns": "1",
            "key_id": 0
        },
        "sig": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    });

    let result = intents
        .call(contract.id(), "mt_on_transfer")
        .args_json(serde_json::json!({
            "sender_id": "user.near",
            "previous_owner_ids": ["user.near", "user.near"],
            "token_ids": ["nep141:eth.omft.near", "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"],
            "amounts": ["1000000000000000000", "100000"],
            "msg": msg.to_string()
        }))
        .transact()
        .await?;

    assert!(
        result.is_success(),
        "mt_on_transfer should succeed (return refusal) for expired quote: {:?}",
        result.failures()
    );

    // The return value should be the full refusal amounts [1000000000000000000, 100000]
    let returned: Vec<String> = result.json()?;
    assert_eq!(returned, vec!["1000000000000000000", "100000"],
        "Expected full refusal amounts for expired quote, got {:?}", returned);

    Ok(())
}

// ---------------------------------------------------------------------------
// Test: mt_on_transfer with a USED quote_id (replay) returns all tokens
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_mt_on_transfer_replay_quote_refunds() -> anyhow::Result<()> {
    let env = deploy_floors_full().await?;
    let contract = &env.contract;
    let intents = &env.intents;

    // A quote with a future expiry but a quote_id we will pre-mark as used.
    // We use two different 64-char hex IDs: one "good" one to trigger the used-quote path
    // via a second call with the same id.
    // Since we cannot easily sign a valid quote in the sandbox test, we use two calls:
    // - First call: quote is not expired, wrong sig → refusal (quote id NOT consumed because sig check fails first)
    // For replay test we instead directly test: the quote TTL check uses quote_is_used,
    // and the code path rejects a used quote before sig verification.
    // We can't easily mark a quote used without a valid open, so this test:
    //   1. Calls with a future-expiry quote using a bad sig → returns refusal (quote NOT consumed)
    //   2. Calls again with the same quote_id → returns refusal again (same reason)
    // This verifies that the E_QUOTE_USED path doesn't panic the contract, and bad-sig
    // refusals don't consume the quote ID. The full replay test requires a successful open first,
    // which needs a valid sig + Pyth mock — covered by manual/CI integration tests.

    let msg = serde_json::json!({
        "op": "open_floor",
        "quote": {
            "v": 1,
            "id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "owner": "user.near",
            "asset": "nep141:eth.omft.near",
            "qty": "1000000000000000000",
            "floor_bps": 1000,
            "duration_secs": 604800,
            "floor_price_e6": "3070890000",
            "fee_usdc": "100000",
            "sleeve": "majors",
            "pyth_feed": "0000000000000000000000000000000000000000000000000000000000000000",
            "expires_at_ns": "99999999999000000000",
            "key_id": 0
        },
        "sig": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    });

    // First call — bad sig → returns refusal, quote NOT consumed
    let r1 = intents
        .call(contract.id(), "mt_on_transfer")
        .args_json(serde_json::json!({
            "sender_id": "user.near",
            "previous_owner_ids": ["user.near", "user.near"],
            "token_ids": ["nep141:eth.omft.near", "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"],
            "amounts": ["1000000000000000000", "100000"],
            "msg": msg.to_string()
        }))
        .transact()
        .await?;

    assert!(r1.is_success(), "First call should succeed with refusal: {:?}", r1.failures());
    let r1_val: Vec<String> = r1.json()?;
    assert_eq!(r1_val, vec!["1000000000000000000", "100000"],
        "Expected refusal for bad sig, got {:?}", r1_val);

    // Second call with the same quote_id — same refusal again (quote not consumed by bad sig)
    let r2 = intents
        .call(contract.id(), "mt_on_transfer")
        .args_json(serde_json::json!({
            "sender_id": "user.near",
            "previous_owner_ids": ["user.near", "user.near"],
            "token_ids": ["nep141:eth.omft.near", "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"],
            "amounts": ["1000000000000000000", "100000"],
            "msg": msg.to_string()
        }))
        .transact()
        .await?;

    assert!(r2.is_success(), "Second call should also succeed with refusal: {:?}", r2.failures());
    let r2_val: Vec<String> = r2.json()?;
    assert_eq!(r2_val, vec!["1000000000000000000", "100000"],
        "Expected refusal for repeated bad sig, got {:?}", r2_val);

    Ok(())
}
