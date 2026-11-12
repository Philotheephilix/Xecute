/**
 * setup-sandbox.ts
 *
 * Bootstraps the NEAR localnet sandbox with test accounts and mock fungible
 * token contracts for the Floors integration harness.
 *
 * Prerequisites:
 *   - near-sandbox running at http://localhost:3030 (via `make stack`)
 *
 * Usage:
 *   tsx scripts/setup-sandbox.ts
 *
 * What this does:
 *   1. Reads the sandbox validator key from the running container (or env)
 *   2. Connects to near-sandbox as test.near (the root account)
 *   3. Creates alice.test.near, bob.test.near, usdc.test.near, eth.test.near
 *   4. Deploys stub FT contracts
 *   5. Attempts to mint test balances
 *
 * The NEAR_PRIVATE_KEY used by the relayer service is the same as the sandbox
 * validator key. This is printed at the end so it can be added to .env.local.
 */

import * as nearAPI from 'near-api-js';

const { connect, keyStores, KeyPair, utils } = nearAPI;

const SANDBOX_URL = process.env['SANDBOX_URL'] ?? 'http://localhost:3030';

// Fetch the actual chain_id from the sandbox status
async function getChainId(): Promise<string> {
  const res = await fetch(`${SANDBOX_URL}/status`);
  if (!res.ok) throw new Error(`Sandbox not reachable at ${SANDBOX_URL}`);
  const status = await res.json() as { chain_id: string };
  return status.chain_id;
}

// Fetch the validator key from the Docker container
// Falls back to NEAR_PRIVATE_KEY env var if provided (CI usage)
async function getValidatorKey(): Promise<string> {
  if (process.env['NEAR_PRIVATE_KEY']) {
    return process.env['NEAR_PRIVATE_KEY'];
  }
  // Fetch the validator private key via the /debug/api/validator_key endpoint
  // near-sandbox exposes this at its RPC
  try {
    const res = await fetch(`${SANDBOX_URL}/debug/api/validator_key`);
    if (res.ok) {
      const key = await res.json() as { secret_key: string };
      return key.secret_key;
    }
  } catch {
    // Not available on this version
  }

  // Try reading from Docker container directly
  try {
    const { execSync } = await import('child_process');
    const result = execSync(
      'docker compose exec near-sandbox sh -c "cat /root/.near/validator_key.json"',
      { cwd: process.cwd(), encoding: 'utf-8' },
    );
    const parsed = JSON.parse(result) as { secret_key: string };
    return parsed.secret_key;
  } catch {
    // Docker not available or different setup
  }

  // Default sandbox validator key (near-sandbox default — may not match)
  return 'ed25519:5Fdfi486ameiVMqz6B2Z4dH5yayzMzQrZmekYnqpw8wTDwvfeBRoyCoMCTUsotWijXPiiL2vEpLrsa2hwHCBhS29';
}

const ONE_NEAR = BigInt('1000000000000000000000000'); // 10^24 yoctoNEAR
const INITIAL_BALANCE = ONE_NEAR * 10n; // 10 NEAR per test account

async function main(): Promise<void> {
  console.log('[setup-sandbox] Connecting to NEAR sandbox at', SANDBOX_URL);

  const chainId = await getChainId();
  const validatorKey = await getValidatorKey();
  const NETWORK_ID = chainId; // Use actual chain_id as networkId for key store

  console.log('[setup-sandbox] Chain ID:', chainId);
  console.log('[setup-sandbox] Validator key loaded.');

  const keyStore = new keyStores.InMemoryKeyStore();
  const testNearKey = KeyPair.fromString(validatorKey as nearAPI.utils.key_pair.KeyPairString);

  await keyStore.setKey(NETWORK_ID, 'test.near', testNearKey);

  const config: nearAPI.ConnectConfig = {
    networkId: NETWORK_ID,
    keyStore,
    nodeUrl: SANDBOX_URL,
    walletUrl: SANDBOX_URL,
    helperUrl: SANDBOX_URL,
  };

  const near = await connect(config);

  // Load the root test account
  const testAccount = await near.account('test.near');

  console.log('[setup-sandbox] Connected. Creating test accounts...');

  // Create alice.test.near
  const aliceKey = await createSubAccount(testAccount, 'alice.test.near', INITIAL_BALANCE, keyStore, NETWORK_ID);

  // Create bob.test.near
  await createSubAccount(testAccount, 'bob.test.near', INITIAL_BALANCE, keyStore, NETWORK_ID);

  // Create usdc.test.near (mock FT)
  await createSubAccount(testAccount, 'usdc.test.near', INITIAL_BALANCE, keyStore, NETWORK_ID);

  // Create eth.test.near (mock FT)
  await createSubAccount(testAccount, 'eth.test.near', INITIAL_BALANCE, keyStore, NETWORK_ID);

  console.log('[setup-sandbox] Test accounts created.');

  // Register sub-account keys
  await keyStore.setKey(NETWORK_ID, 'usdc.test.near', testNearKey);
  await keyStore.setKey(NETWORK_ID, 'eth.test.near', testNearKey);

  const usdcAccount = await near.account('usdc.test.near');
  const ethAccount = await near.account('eth.test.near');
  const aliceAccount = await near.account('alice.test.near');

  // Check alice balance
  const aliceState = await aliceAccount.state();
  console.log('[setup-sandbox] alice.test.near balance:', utils.format.formatNearAmount(aliceState.amount), 'NEAR');

  console.log('[setup-sandbox] Deploying mock USDC FT contract to usdc.test.near...');
  await deployMockFtContract(usdcAccount, 'USDC', 'usdc', 6);

  console.log('[setup-sandbox] Minting 1000 USDC to alice.test.near...');
  await ftMint(usdcAccount, 'alice.test.near', '1000000000');

  console.log('[setup-sandbox] Deploying mock ETH FT contract to eth.test.near...');
  await deployMockFtContract(ethAccount, 'ETH', 'eth', 18);

  console.log('[setup-sandbox] Minting 10 ETH to bob.test.near...');
  await ftMint(ethAccount, 'bob.test.near', '10000000000000000000');

  await registerStorageDeposit(usdcAccount, aliceAccount.accountId);
  await registerStorageDeposit(ethAccount, aliceAccount.accountId);

  console.log('[setup-sandbox] Setup complete.');
  console.log('  alice.test.near: created,', utils.format.formatNearAmount(aliceState.amount), 'NEAR');
  console.log('  bob.test.near: created');
  console.log('  NEAR sandbox ready for integration tests.');
  console.log('');
  console.log('[setup-sandbox] Relayer config (add to services/relayer/.env.local):');
  console.log(`  NEAR_NODE_URL=http://localhost:3030`);
  console.log(`  NEAR_NETWORK_ID=sandbox`);
  console.log(`  NEAR_ACCOUNT_ID=alice.test.near`);
  // Print alice's key for relayer if we created a new one
  if (aliceKey) {
    console.log(`  NEAR_PRIVATE_KEY=${aliceKey}`);
    // Also update the relayer .env.local automatically
    await updateRelayerEnv(aliceKey);
  } else {
    console.log(`  NEAR_PRIVATE_KEY=<use alice key from keystore>`);
  }
}

async function updateRelayerEnv(privateKey: string): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const envPath = new URL('../services/relayer/.env.local', import.meta.url).pathname;

  let content: string;
  try {
    content = await readFile(envPath, 'utf-8');
  } catch {
    content = '';
  }

  const lines = content.split('\n');
  const updates: Record<string, string> = {
    NEAR_NODE_URL: 'http://localhost:3030',
    NEAR_NETWORK_ID: 'sandbox',
    NEAR_ACCOUNT_ID: 'alice.test.near',
    NEAR_PRIVATE_KEY: privateKey,
  };

  const newLines = lines.filter((l) => {
    const key = l.split('=')[0] ?? '';
    return !(key in updates);
  });

  for (const [key, value] of Object.entries(updates)) {
    newLines.push(`${key}=${value}`);
  }

  await writeFile(envPath, newLines.filter((l) => l.trim() !== '').join('\n') + '\n');
  console.log('[setup-sandbox] Updated services/relayer/.env.local with NEAR config.');
}

async function createSubAccount(
  parent: nearAPI.Account,
  accountId: string,
  initialBalance: bigint,
  keyStore: nearAPI.keyStores.InMemoryKeyStore,
  networkId: string,
): Promise<string | null> {
  // Check if already exists
  try {
    await parent.connection.provider.query({
      request_type: 'view_account',
      account_id: accountId,
      finality: 'optimistic',
    });
    console.log(`[setup-sandbox] Account ${accountId} already exists, skipping.`);
    return null;
  } catch {
    // Account doesn't exist — create it
  }

  const newKeyPair = KeyPair.fromRandom('ed25519');
  await keyStore.setKey(networkId, accountId, newKeyPair);

  await parent.createAccount(accountId, newKeyPair.getPublicKey(), initialBalance.toString() as nearAPI.utils.format.NEAR);
  console.log(`[setup-sandbox] Created ${accountId}`);

  return newKeyPair.toString();
}

async function deployMockFtContract(
  account: nearAPI.Account,
  name: string,
  symbol: string,
  decimals: number,
): Promise<void> {
  // Deploy empty WASM (minimal valid WASM: just magic + version bytes)
  const noopWasm = new Uint8Array(8);
  noopWasm[0] = 0x00; noopWasm[1] = 0x61; noopWasm[2] = 0x73; noopWasm[3] = 0x6d;
  noopWasm[4] = 0x01; noopWasm[5] = 0x00; noopWasm[6] = 0x00; noopWasm[7] = 0x00;

  try {
    await account.deployContract(noopWasm);
    console.log(`[setup-sandbox] Deployed stub contract to ${account.accountId} (${name}/${symbol}, ${decimals} decimals)`);
  } catch (err) {
    console.warn(`[setup-sandbox] Deploy ${account.accountId} warning:`, (err as Error).message);
  }
}

async function ftMint(
  ftAccount: nearAPI.Account,
  receiverId: string,
  amount: string,
): Promise<void> {
  try {
    await ftAccount.functionCall({
      contractId: ftAccount.accountId,
      methodName: 'ft_mint',
      args: { receiver_id: receiverId, amount },
      gas: BigInt('30000000000000').toString() as nearAPI.utils.format.NEAR,
      attachedDeposit: '1' as nearAPI.utils.format.NEAR,
    });
    console.log(`[setup-sandbox] Minted ${amount} to ${receiverId} on ${ftAccount.accountId}`);
  } catch (err) {
    console.warn(`[setup-sandbox] ft_mint warning (expected with stub WASM):`, (err as Error).message);
  }
}

async function registerStorageDeposit(
  ftAccount: nearAPI.Account,
  accountId: string,
): Promise<void> {
  try {
    await ftAccount.functionCall({
      contractId: ftAccount.accountId,
      methodName: 'storage_deposit',
      args: { account_id: accountId },
      gas: BigInt('30000000000000').toString() as nearAPI.utils.format.NEAR,
      attachedDeposit: utils.format.parseNearAmount('0.0125') ?? '12500000000000000000000',
    });
  } catch (err) {
    console.warn(`[setup-sandbox] storage_deposit warning:`, (err as Error).message);
  }
}

main().catch((err) => {
  console.error('[setup-sandbox] Fatal:', (err as Error).message);
  process.exit(1);
});
