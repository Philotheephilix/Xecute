/// Sandbox integration test: deploy floors contract and verify get_version returns "V1".
///
/// Requires the floors WASM to be pre-built before running:
///   cargo build -p floors --target wasm32-unknown-unknown --release
use anyhow::Context;
use near_workspaces::types::NearToken;

const FLOORS_WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../target/wasm32-unknown-unknown/release/floors.wasm"
);

#[tokio::test]
async fn test_get_version() -> anyhow::Result<()> {
    // Start sandbox
    let worker = near_workspaces::sandbox()
        .await
        .context("failed to start sandbox")?;

    // Read WASM bytes
    let wasm = std::fs::read(FLOORS_WASM).context(format!(
        "WASM not found at {FLOORS_WASM}; run: cargo build -p floors --target wasm32-unknown-unknown --release"
    ))?;

    // Create named accounts
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

    // Deploy floors
    let contract = root
        .create_subaccount("floors")
        .initial_balance(NearToken::from_near(50))
        .transact()
        .await?
        .into_result()?
        .deploy(&wasm)
        .await?
        .into_result()?;

    // A dummy 32-byte quote signer public key
    let signer_key: Vec<u8> = vec![1u8; 32];

    // Call new()
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

    // Call get_version view
    let version: String = contract
        .call("get_version")
        .view()
        .await?
        .json()
        .context("failed to deserialize get_version result")?;

    assert_eq!(version, "V1", "expected version V1, got {version}");
    Ok(())
}
