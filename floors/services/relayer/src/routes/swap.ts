import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FloorApiError } from '@floors/shared-server';
import { sha256 } from '@noble/hashes/sha256';
import { ed25519 } from '@noble/curves/ed25519';
import type pino from 'pino';
import type { Sql } from 'postgres';
import type { Account } from 'near-api-js';
import type { RelayerConfig } from '../index.js';

// ---------------------------------------------------------------------------
// Request / response schemas
// ---------------------------------------------------------------------------

const FloorParamsSchema = z.object({
  bps: z.number().int().positive(),
  duration_secs: z.number().int().positive(),
});

const SwapBodySchema = z.object({
  account_id: z.string().min(1),
  ticker: z.string().min(1),
  amount_usdc: z.string().regex(/^\d+$/, 'amount_usdc must be a non-negative integer string'),
  idempotency_key: z.string().uuid(),
  floor: FloorParamsSchema.optional(),
});

// ---------------------------------------------------------------------------
// Token IDs — mainnet (1Click)
// ---------------------------------------------------------------------------

const MAINNET_ASSET_IDS: Record<string, string> = {
  ETH: 'nep141:eth.omft.near',
  SOL: 'nep141:sol.omft.near',
  USDC_IN: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
};

// ---------------------------------------------------------------------------
// Ref Finance testnet pool IDs: ticker → pool_id
// A pool_id of -1 means the pool doesn't exist yet.
// ---------------------------------------------------------------------------

const REF_POOL_IDS: Record<string, number> = {
  ETH: 2980, // usdc.fakes.testnet / eth.fakes.testnet
  SOL: -1,  // SOL pool not yet deployed on testnet Ref Finance
};

const ONE_CLICK_BASE = 'https://1click.chaindefuser.com';
const INTENTS_CONTRACT = 'intents.near';

// ---------------------------------------------------------------------------
// Base58 helpers (no external runtime dependency — inline for robustness)
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  const digits: string[] = [];
  while (n > 0n) {
    digits.push(BASE58_ALPHABET[Number(n % 58n)] as string);
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    digits.push(BASE58_ALPHABET[0] as string);
  }
  return digits.reverse().join('');
}

function base58Decode(str: string): Uint8Array {
  let n = 0n;
  for (const c of str) {
    const idx = BASE58_ALPHABET.indexOf(c);
    if (idx < 0) throw new Error(`Invalid base58 character: ${c}`);
    n = n * 58n + BigInt(idx);
  }
  const hex = n.toString(16);
  const padded = hex.length % 2 ? '0' + hex : hex;
  return new Uint8Array(Buffer.from(padded, 'hex'));
}

// ---------------------------------------------------------------------------
// NEP-413 signing (mainnet 1Click path only)
// ---------------------------------------------------------------------------

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function borshString(s: string): Uint8Array {
  const encoded = new TextEncoder().encode(s);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, encoded.length, true);
  return concat(len, encoded);
}

function borshOption(value: string | undefined): Uint8Array {
  if (value === undefined) return new Uint8Array([0]);
  return concat(new Uint8Array([1]), borshString(value));
}

/**
 * Compute the NEP-413 challenge: sha256(NEP413_TAG || borsh(payload))
 * where NEP413_TAG is 413 encoded as a 32-byte little-endian integer.
 */
function nep413Challenge(
  message: string,
  nonce: Uint8Array,
  recipient: string,
  callbackUrl?: string,
): Uint8Array {
  const tag = new Uint8Array(32);
  let v = 413;
  for (let i = 0; i < 4; i++) {
    tag[i] = v & 0xff;
    v >>>= 8;
  }
  const payload = concat(
    borshString(message),
    nonce,
    borshString(recipient),
    borshOption(callbackUrl),
  );
  return sha256(concat(tag, payload));
}

/**
 * Parse the relayer private key (NEAR ed25519 format) and sign a NEP-413 message.
 * Returns the signature as `ed25519:<base58>`.
 */
function signNep413(
  privateKeyString: string,
  message: string,
  nonce: Uint8Array,
  recipient: string,
  callbackUrl?: string,
): string {
  const keyPart = privateKeyString.startsWith('ed25519:')
    ? privateKeyString.slice('ed25519:'.length)
    : privateKeyString;
  const keyBytes = base58Decode(keyPart);
  const secretKey = keyBytes.slice(0, 32);
  const challenge = nep413Challenge(message, nonce, recipient, callbackUrl);
  const sigBytes = ed25519.sign(challenge, secretKey);
  return `ed25519:${base58Encode(sigBytes)}`;
}

// ---------------------------------------------------------------------------
// 1Click API helpers (mainnet path)
// ---------------------------------------------------------------------------

interface QuoteResponse {
  quote: {
    amountIn: string;
    amountOut: string;
    minAmountOut: string;
    depositAddress: string;
    deadline: string;
  };
}

interface GenerateIntentResponse {
  intent: {
    standard: string;
    payload: {
      message: string;
      nonce: string;   // base64
      recipient: string;
      callbackUrl?: string | null;
    };
  };
  correlationId: string;
}

interface SubmitIntentResponse {
  intentHash: string;
  correlationId: string;
}

interface StatusResponse {
  status: string;
  updatedAt?: string;
  swapDetails?: {
    nearTxHashes?: string[];
    originChainTxHashes?: string[];
    destinationChainTxHashes?: string[];
  };
}

async function oneClickRequest<T>(url: string, body?: unknown): Promise<T> {
  const init: RequestInit =
    body !== undefined
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { method: 'GET' };

  const resp = await fetch(url, init);

  const data = await resp.json() as Record<string, unknown>;

  if (!resp.ok) {
    const msg = typeof data['message'] === 'string' ? data['message'] : `HTTP ${resp.status}`;
    throw new Error(`1Click API error (${resp.status}): ${msg}`);
  }

  return data as T;
}

// ---------------------------------------------------------------------------
// Ref Finance testnet swap (custodial relay)
// ---------------------------------------------------------------------------

/**
 * Execute a USDC → token swap on Ref Finance testnet.
 *
 * Flow:
 * 1. Ensure recipient has storage deposit on the output token
 * 2. Relayer calls ft_transfer_call on USDC token → Ref Finance with swap msg
 * 3. Ref executes swap atomically, output tokens land on relayer account
 * 4. Relayer calls ft_transfer on output token → recipient
 *
 * Returns the swap tx hash.
 */
async function refFinanceSwap(
  signingAccount: Account,
  config: RelayerConfig,
  ticker: string,
  amountUsdc: string,
  recipientId: string,
  logger: pino.Logger,
): Promise<{ txHash: string; amountOut: string }> {
  // Resolve output token contract per ticker
  const TESTNET_TOKENS: Record<string, string> = {
    ETH: config.ETH_TOKEN,
    SOL: config.SOL_TOKEN,
  };
  const tokenOut = TESTNET_TOKENS[ticker.toUpperCase()] ?? config.ETH_TOKEN;
  const poolId = REF_POOL_IDS[ticker.toUpperCase()];
  if (poolId === undefined) {
    throw new Error(`No Ref Finance pool for ticker: ${ticker}`);
  }

  // 1. Ensure recipient has storage deposit on output token (ignore if already registered)
  logger.info({ recipientId, tokenOut, event: 'ref_storage_deposit' }, 'Ensuring storage deposit on output token');
  try {
    await signingAccount.functionCall({
      contractId: tokenOut,
      methodName: 'storage_deposit',
      args: { account_id: recipientId },
      gas: 30_000_000_000_000n,
      attachedDeposit: 1_250_000_000_000_000_000_000n, // 0.00125 NEAR (standard NEP-145)
    });
  } catch {
    // Ignore — already registered or will fail at transfer time
  }

  // Also ensure relayer has storage deposit on output token (for receiving swap output)
  try {
    await signingAccount.functionCall({
      contractId: tokenOut,
      methodName: 'storage_deposit',
      args: { account_id: config.NEAR_ACCOUNT_ID },
      gas: 30_000_000_000_000n,
      attachedDeposit: 1_250_000_000_000_000_000_000n,
    });
  } catch {
    // Ignore — already registered
  }

  // SECURITY (H1): Get expected output via get_return for slippage protection.
  // Set min_amount_out to 95% of expected (5% slippage tolerance).
  let expectedOut = '0';
  try {
    expectedOut = await signingAccount.viewFunction({
      contractId: config.REF_FINANCE_CONTRACT,
      methodName: 'get_return',
      args: {
        pool_id: poolId,
        token_in: config.USDC_TOKEN,
        amount_in: amountUsdc,
        token_out: tokenOut,
      },
    }) as string;
  } catch {
    logger.warn({ event: 'ref_get_return_failed' }, 'Failed to get expected output — proceeding with zero slippage protection');
  }
  const minAmountOut = expectedOut !== '0'
    ? (BigInt(expectedOut) * 95n / 100n).toString() // 5% slippage tolerance
    : '1'; // Absolute minimum: at least 1 unit (never accept zero)

  // 2. Swap USDC → token via ft_transfer_call to Ref Finance
  const swapMsg = JSON.stringify({
    actions: [{
      pool_id: poolId,
      token_in: config.USDC_TOKEN,
      token_out: tokenOut,
      amount_in: amountUsdc,
      min_amount_out: minAmountOut,
    }],
  });

  logger.info(
    { poolId, amountUsdc, tokenOut, expectedOut, minAmountOut, event: 'ref_swap_start' },
    'Submitting ft_transfer_call to Ref Finance',
  );

  // SECURITY (H2): Read balance BEFORE swap to compute proceeds (not total balance).
  let balanceBefore = '0';
  try {
    balanceBefore = await signingAccount.viewFunction({
      contractId: tokenOut,
      methodName: 'ft_balance_of',
      args: { account_id: config.NEAR_ACCOUNT_ID },
    }) as string;
  } catch {
    logger.warn({ event: 'ref_balance_before_failed' }, 'Failed to query output token balance before swap');
  }

  const swapOutcome = await signingAccount.functionCall({
    contractId: config.USDC_TOKEN,
    methodName: 'ft_transfer_call',
    args: {
      receiver_id: config.REF_FINANCE_CONTRACT,
      amount: amountUsdc,
      msg: swapMsg,
    },
    gas: 100_000_000_000_000n, // 100 TGas
    attachedDeposit: 1n,
  });

  const swapTxHash = swapOutcome.transaction_outcome.id;

  // SECURITY (H2): Read balance AFTER swap, transfer only the difference (swap proceeds).
  // This prevents accumulated tokens from prior failed transfers being sent to the next user.
  let amountOut = '0';
  try {
    const balanceAfter = await signingAccount.viewFunction({
      contractId: tokenOut,
      methodName: 'ft_balance_of',
      args: { account_id: config.NEAR_ACCOUNT_ID },
    }) as string;
    // Transfer only the difference (proceeds from this swap)
    const proceeds = BigInt(balanceAfter) - BigInt(balanceBefore);
    amountOut = proceeds > 0n ? proceeds.toString() : '0';
  } catch {
    logger.warn({ event: 'ref_balance_query_failed' }, 'Failed to query output token balance after swap');
  }

  if (amountOut === '0' || amountOut === '') {
    logger.warn({ swapTxHash, event: 'ref_swap_zero_output' }, 'Swap produced zero output');
    return { txHash: swapTxHash, amountOut: '0' };
  }

  // 3. Transfer output tokens to recipient
  logger.info(
    { amountOut, recipientId, tokenOut, event: 'ref_transfer_start' },
    'Transferring swap output to recipient',
  );

  try {
    await signingAccount.functionCall({
      contractId: tokenOut,
      methodName: 'ft_transfer',
      args: {
        receiver_id: recipientId,
        amount: amountOut,
      },
      gas: 30_000_000_000_000n,
      attachedDeposit: 1n,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, amountOut, recipientId, event: 'ref_transfer_error' }, 'Failed to transfer output to recipient');
    throw new Error(`Swap succeeded but transfer to recipient failed: ${msg}`);
  }

  logger.info(
    { swapTxHash, amountOut, recipientId, event: 'ref_swap_complete' },
    'Ref Finance swap and transfer complete',
  );

  return { txHash: swapTxHash, amountOut };
}

// ---------------------------------------------------------------------------
// Risk service quote response
// ---------------------------------------------------------------------------

interface RiskQuoteResponse {
  quote_id: string;
  floor_price_e6: string;
  fee_usdc: string;
  sig: string;
  sleeve: string;
  expires_at: number;
  asset: string;
  qty: string;
  owner: string;
  pyth_feed?: string;
  key_id: number;
}

// ---------------------------------------------------------------------------
// Floor opening after swap
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Testnet token decimals (used for fair-value qty calculation)
// ---------------------------------------------------------------------------

const TESTNET_DECIMALS: Record<string, number> = {
  ETH: 18,
  SOL: 9,
};

/**
 * Open a floor after a successful swap.
 *
 * 1. Call risk service for a signed FloorQuote
 * 2. Set fresh Pyth price on mock oracle (testnet)
 * 3. Call mt_on_transfer on floors contract
 *
 * On testnet, the Ref Finance pool returns absurdly small token amounts
 * (e.g. 275551 raw units for $10 USDC, when 1 ETH = 10^18 units). This makes
 * floor_usdc = ceil(qty * floor_price / 10^decimals) far below min_floor_usdc.
 *
 * Fix: when the swap output is too small to open a viable floor, compute the
 * fair-value qty from the USDC amount and current price, mint testnet fakes
 * tokens to the floors contract, and use that qty for the floor. This is safe
 * because:
 *   - Testnet fakes tokens have an open `mint()` method
 *   - The floors contract trusts the intents predecessor (= relayer on testnet)
 *   - Minting keeps token balances solvent for on-chain accounting
 *
 * Returns { floorTxHash, floorId } on success.
 */
async function openFloorAfterSwap(
  signingAccount: Account,
  config: RelayerConfig,
  accountId: string,
  ticker: string,
  amountOut: string,
  floorBps: number,
  durationSecs: number,
  logger: pino.Logger,
  amountUsdc?: string,
): Promise<{ floorTxHash: string; floorId: number | undefined }> {
  const riskUrl = config.RISK_SERVICE_URL;
  const floorsContract = config.FLOORS_CONTRACT;
  const pythContract = config.PYTH_CONTRACT;
  const usdcToken = config.USDC_TOKEN;
  const isTestnet = config.NEAR_NETWORK_ID !== 'mainnet';

  // Resolve asset NEP-141 ID
  const TESTNET_TOKENS: Record<string, string> = {
    ETH: config.ETH_TOKEN,
    SOL: config.SOL_TOKEN,
  };
  const tokenOut = TESTNET_TOKENS[ticker.toUpperCase()] ?? config.ETH_TOKEN;

  // 1. Get signed quote from risk service
  //    On testnet, if the swap output is too small, we first get a quote with
  //    the swap output to learn the price, then recompute a viable qty and
  //    re-request the quote with the proper amount.
  const validUntilNs = String(BigInt(Date.now() + 60_000) * 1_000_000n);

  let effectiveQty = amountOut;

  // Pre-flight: check if swap output is viable for a floor
  if (isTestnet && amountUsdc) {
    const decimals = TESTNET_DECIMALS[ticker.toUpperCase()] ?? 18;
    const decimalsPow = 10n ** BigInt(decimals);

    // Get a preliminary quote to learn the floor price
    const preflightResp = await fetch(`${riskUrl}/v1/risk/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asset: ticker.toUpperCase(),
        qty: amountOut,
        floor_bps: floorBps,
        duration_secs: durationSecs,
        owner: accountId,
        valid_until_ns: validUntilNs,
      }),
    });

    if (preflightResp.ok) {
      const preQuote = await preflightResp.json() as RiskQuoteResponse;
      const floorPriceE6 = BigInt(preQuote.floor_price_e6);

      // Compute floor_usdc that the contract would calculate: ceil(qty * floor_price_e6 / 10^decimals)
      const qtyBig = BigInt(amountOut);
      const numerator = qtyBig * floorPriceE6;
      const floorUsdc = (numerator + decimalsPow - 1n) / decimalsPow;

      // The on-chain min_floor_usdc is $1 = 1_000_000. Use a safe threshold.
      const MIN_FLOOR_USDC = 1_000_000n;

      if (floorUsdc < MIN_FLOOR_USDC) {
        // Swap output is too small. Compute fair-value qty from USDC amount.
        // spotE6 ≈ floorPriceE6 * 10000 / (10000 - floorBps)
        const spotE6 = floorPriceE6 * 10000n / BigInt(10000 - floorBps);
        // fairQty = amountUsdc * 10^decimals / spotE6  (how much token the USDC should buy)
        const fairQty = BigInt(amountUsdc) * decimalsPow / spotE6;

        logger.info(
          {
            swapQty: amountOut,
            fairQty: fairQty.toString(),
            floorUsdc: floorUsdc.toString(),
            spotE6: spotE6.toString(),
            event: 'testnet_qty_boost',
          },
          'Swap output too small for floor — minting fair-value tokens (testnet)',
        );

        // Mint fair-value tokens to the floors contract
        try {
          await signingAccount.functionCall({
            contractId: tokenOut,
            methodName: 'mint',
            args: { account_id: floorsContract, amount: fairQty.toString() },
            gas: 30_000_000_000_000n,
            attachedDeposit: 0n,
          });
          logger.info(
            { amount: fairQty.toString(), recipient: floorsContract, event: 'testnet_mint_done' },
            'Minted testnet tokens to floors contract',
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ err: msg, event: 'testnet_mint_error' }, 'Failed to mint testnet tokens');
          throw new Error(`Testnet mint failed: ${msg}`);
        }

        // Also mint USDC fee tokens to the floors contract (so accounting stays solvent)
        const feeUsdc = preQuote.fee_usdc;
        try {
          await signingAccount.functionCall({
            contractId: usdcToken,
            methodName: 'mint',
            args: { account_id: floorsContract, amount: feeUsdc },
            gas: 30_000_000_000_000n,
            attachedDeposit: 0n,
          });
          logger.info(
            { amount: feeUsdc, recipient: floorsContract, event: 'testnet_usdc_mint_done' },
            'Minted testnet USDC fee to floors contract',
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ err: msg, event: 'testnet_usdc_mint_error' }, 'Failed to mint testnet USDC (non-fatal)');
        }

        effectiveQty = fairQty.toString();
      }
    }
  }

  logger.info(
    { accountId, ticker, amountOut: effectiveQty, floorBps, durationSecs, event: 'floor_risk_quote_start' },
    'Requesting risk quote for floor opening',
  );

  const riskResp = await fetch(`${riskUrl}/v1/risk/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asset: ticker.toUpperCase(),
      qty: effectiveQty,
      floor_bps: floorBps,
      duration_secs: durationSecs,
      owner: accountId,
      valid_until_ns: validUntilNs,
    }),
  });

  if (!riskResp.ok) {
    const body = await riskResp.text().catch(() => '');
    throw new Error(`Risk service quote failed (${riskResp.status}): ${body}`);
  }

  const riskQuote = await riskResp.json() as RiskQuoteResponse;
  logger.info(
    {
      quoteId: riskQuote.quote_id,
      floorPrice: riskQuote.floor_price_e6,
      feeUsdc: riskQuote.fee_usdc,
      event: 'floor_risk_quote_done',
    },
    'Risk quote obtained',
  );

  // 2. Set fresh Pyth price (testnet mock oracle)
  // Fetch current ETH price from risk quote context — derive from floor_price_e6 and bps
  // spot_e6 = floor_price_e6 / (1 - bps/10000) ≈ floor_price_e6 * 10000 / (10000 - bps)
  const floorPriceE6 = BigInt(riskQuote.floor_price_e6);
  const spotE6 = floorPriceE6 * 10000n / BigInt(10000 - floorBps);
  // Pyth price uses expo=-8, so price = spot_usd * 10^8
  // spotE6 is in e6, so: pyth_price = spotE6 * 10^2 = spotE6 * 100
  const pythPrice = Number(spotE6) * 100;

  const pythFeedId = riskQuote.pyth_feed ?? 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace';

  logger.info(
    { pythContract, pythPrice, pythFeedId, event: 'pyth_set_price_start' },
    'Setting mock Pyth price',
  );

  // The mock Pyth contract admin is the pyth account itself.
  // If a PYTH_PRIVATE_KEY is configured, create a separate signing account for it.
  // Otherwise fall back to the main signing account (will fail if admin != relayer).
  try {
    let pythSigner = signingAccount;
    if (config.PYTH_PRIVATE_KEY) {
      const { connect: nearConnect, keyStores: nearKeyStores, KeyPair: nearKeyPair } = await import('near-api-js');
      const pythKs = new nearKeyStores.InMemoryKeyStore();
      const pythKp = nearKeyPair.fromString(config.PYTH_PRIVATE_KEY as Parameters<typeof nearKeyPair.fromString>[0]);
      await pythKs.setKey(config.NEAR_NETWORK_ID, pythContract, pythKp);
      const pythNear = await nearConnect({ networkId: config.NEAR_NETWORK_ID, nodeUrl: config.NEAR_NODE_URL, keyStore: pythKs });
      pythSigner = await pythNear.account(pythContract);
    }
    await pythSigner.functionCall({
      contractId: pythContract,
      methodName: 'set_price',
      args: {
        feed_id: pythFeedId,
        price: Math.round(pythPrice),
        expo: -8,
        publish_time_ns: Date.now() * 1_000_000,
      },
      gas: 30_000_000_000_000n,
    });
    logger.info({ event: 'pyth_set_price_done' }, 'Mock Pyth price set');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg, event: 'pyth_set_price_error' }, 'Failed to set Pyth price (may already be fresh)');
    // Continue — the price may already be fresh enough
  }

  // 3. Build mt_on_transfer args and call floors contract
  const assetNep141 = riskQuote.asset; // e.g. 'nep141:eth.fakes.testnet'
  const usdcNep141 = `nep141:${usdcToken}`;

  // Build the FloorQuote object matching contract expectations
  const expiresAtNs = String(BigInt(riskQuote.expires_at) * 1_000_000_000n);
  const floorQuote = {
    v: 1,
    id: riskQuote.quote_id,
    owner: accountId,
    asset: assetNep141,
    qty: effectiveQty,
    floor_bps: floorBps,
    duration_secs: durationSecs,
    floor_price_e6: riskQuote.floor_price_e6,
    fee_usdc: riskQuote.fee_usdc,
    sleeve: riskQuote.sleeve,
    pyth_feed: pythFeedId,
    expires_at_ns: expiresAtNs,
    key_id: riskQuote.key_id,
  };

  const innerMsg = JSON.stringify({
    op: 'open_floor',
    quote: floorQuote,
    sig: riskQuote.sig,
  });

  const mtArgs = {
    sender_id: accountId,
    previous_owner_ids: [accountId, accountId],
    token_ids: [assetNep141, usdcNep141],
    amounts: [effectiveQty, riskQuote.fee_usdc],
    msg: innerMsg,
  };

  logger.info(
    { floorsContract, quoteId: riskQuote.quote_id, event: 'floor_mt_on_transfer_start' },
    'Calling mt_on_transfer to open floor',
  );

  // The relayer signs as the floors contract (which IS the intents contract on testnet)
  // mt_on_transfer expects predecessor == params.intents
  const mtOutcome = await signingAccount.functionCall({
    contractId: floorsContract,
    methodName: 'mt_on_transfer',
    args: mtArgs,
    gas: 200_000_000_000_000n, // 200 TGas (Pyth cross-contract call + callback)
    attachedDeposit: 0n,
  });

  const floorTxHash = mtOutcome.transaction_outcome.id;

  // Parse the return value to check if floor was accepted.
  // mt_on_transfer returns Vec<U128>:
  //   [U128(0), U128(0)]  = accepted (tokens consumed)
  //   [qty, fee]          = rejected (tokens returned to sender)
  //
  // The final return value is in the last receipt's SuccessValue.
  let floorAccepted = false;
  let floorId: number | undefined;
  try {
    const receipts = (mtOutcome as unknown as Record<string, unknown>)['receipts_outcome'] as
      Array<Record<string, unknown>> | undefined;
    if (receipts) {
      for (const receipt of receipts) {
        const outcome = receipt['outcome'] as Record<string, unknown> | undefined;
        if (!outcome) continue;

        // Check logs for floor_opened event
        const logs = outcome['logs'] as string[] | undefined;
        if (logs) {
          for (const log of logs) {
            if (log.includes('floor_opened')) {
              floorAccepted = true;
              const match = log.match(/"floor_id"\s*:\s*(\d+)/);
              if (match?.[1]) {
                floorId = parseInt(match[1], 10);
              }
            }
          }
        }

        // Check return value — if SuccessValue decodes to ["0","0"] it means accepted
        const status = outcome['status'] as Record<string, string> | undefined;
        if (status?.['SuccessValue']) {
          try {
            const decoded = Buffer.from(status['SuccessValue'], 'base64').toString();
            const parsed = JSON.parse(decoded) as string[];
            if (Array.isArray(parsed) && parsed.length === 2 &&
                parsed[0] === '0' && parsed[1] === '0') {
              floorAccepted = true;
            }
          } catch {
            // Not a JSON return value
          }
        }
      }
    }
  } catch {
    // Best-effort parsing
  }

  if (!floorAccepted) {
    logger.warn(
      { floorTxHash, quoteId: riskQuote.quote_id, event: 'floor_rejected' },
      'Floor rejected by contract (tokens returned)',
    );
    throw new Error(`Floor rejected by contract (tx: ${floorTxHash})`);
  }

  logger.info(
    { floorTxHash, floorId, quoteId: riskQuote.quote_id, event: 'floor_opened' },
    'Floor opened successfully',
  );

  return { floorTxHash, floorId };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerSwapRoutes(
  app: FastifyInstance,
  logger: pino.Logger,
  db: Sql,
  config: RelayerConfig,
): void {
  const isMainnet = config.NEAR_NETWORK_ID === 'mainnet';

  /**
   * POST /v1/relay/swap
   *
   * Accepts a buy request (ticker, amount_usdc, account_id).
   *
   * Mainnet: 1Click intent-based swap (non-custodial).
   * Testnet/sandbox: Ref Finance custodial swap via relayer account.
   */
  app.post('/v1/relay/swap', async (request, reply) => {
    const bodyResult = SwapBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        'Invalid swap request',
        false,
        400,
        { issues: bodyResult.error.issues },
      );
    }

    const { account_id, ticker, amount_usdc, idempotency_key, floor } = bodyResult.data;

    // Validate ticker is supported
    const tickerUpper = ticker.toUpperCase();
    if (isMainnet) {
      if (MAINNET_ASSET_IDS[tickerUpper] === undefined) {
        throw new FloorApiError(
          'VALIDATION_ERROR',
          `Unsupported ticker: ${ticker}. Supported: ${Object.keys(MAINNET_ASSET_IDS).filter(k => k !== 'USDC_IN').join(', ')}`,
          false,
          400,
        );
      }
    } else {
      if (REF_POOL_IDS[tickerUpper] === undefined) {
        throw new FloorApiError(
          'VALIDATION_ERROR',
          `Unsupported ticker: ${ticker}. Supported: ${Object.keys(REF_POOL_IDS).join(', ')}`,
          false,
          400,
        );
      }
      if (REF_POOL_IDS[tickerUpper] === -1) {
        throw new FloorApiError(
          'VALIDATION_ERROR',
          `${tickerUpper} trading coming soon — testnet pool not yet deployed`,
          false,
          400,
        );
      }
    }

    // --- Idempotency check ---
    const existing = await db<Array<{ intent_hash: string | null; tx_hash: string | null; status: string }>>`
      SELECT intent_hash, tx_hash, status FROM relayer.swap_intents
      WHERE idempotency_key = ${idempotency_key}
    `;
    if (existing.length > 0 && existing[0] !== undefined) {
      return reply.status(200).send({
        intent_hash: existing[0].intent_hash,
        tx_hash: existing[0].tx_hash,
        status: existing[0].status,
      });
    }

    // -----------------------------------------------------------------------
    // Testnet / sandbox path: Ref Finance custodial swap
    // -----------------------------------------------------------------------
    if (!isMainnet) {
      logger.info(
        { account_id, ticker, amount_usdc, event: 'swap_start_ref' },
        'Starting Ref Finance testnet swap',
      );

      // Lazy-import createSigningAccount to avoid circular dep
      const { createSigningAccount } = await import('./relay.js');
      const signingAccount = await createSigningAccount(config);

      // --- Transfer USDC from user wallet to relayer via w_execute_extension ---
      // The relayer (floors-dev.testnet) is a registered extension on user wallets,
      // so it can call w_execute_extension to move tokens from the user's account.
      // NOTE: Global contract mutable calls require NEAR protocol >= 89.
      // On testnet v88, this fails with "unreachable" trap. When it fails, we
      // fall back to recording the debit in the database (the on-chain transfer
      // will start working automatically when the protocol upgrades).
      let usdcTransferredOnChain = false;
      try {
        const ftTransferArgs = JSON.stringify({
          receiver_id: config.NEAR_ACCOUNT_ID,
          amount: amount_usdc,
          memo: 'Xecute swap',
        });
        const ftTransferArgsBase64 = Buffer.from(ftTransferArgs).toString('base64');

        const extensionResult = await signingAccount.functionCall({
          contractId: account_id,
          methodName: 'w_execute_extension',
          args: {
            request: {
              external: [{
                receiver_id: config.USDC_TOKEN,
                actions: [{
                  action: 'function_call',
                  payload: {
                    function_name: 'ft_transfer',
                    args: ftTransferArgsBase64,
                    deposit: '1',              // 1 yoctoNEAR for ft_transfer
                    gas: '10000000000000',      // 10 TGas
                  },
                }],
              }],
            },
          },
          gas: BigInt('50000000000000'),    // 50 TGas
          attachedDeposit: BigInt('1'),     // 1 yoctoNEAR (w_execute_extension requires non-zero)
        });

        const transferTxHash = typeof extensionResult.transaction?.hash === 'string'
          ? extensionResult.transaction.hash
          : typeof extensionResult.transaction_outcome?.id === 'string'
            ? extensionResult.transaction_outcome.id
            : 'unknown';

        usdcTransferredOnChain = true;
        logger.info(
          { account_id, amount_usdc, tx_hash: transferTxHash, event: 'usdc_transfer_from_user' },
          'Transferred USDC from user wallet to relayer via w_execute_extension',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Global contract mutable calls fail on protocol < 89 (unreachable trap).
        // Record the debit in the database instead.
        logger.warn(
          { err: msg, account_id, amount_usdc, event: 'usdc_transfer_fallback' },
          'On-chain USDC transfer failed (protocol < 89), recording debit in database',
        );
      }

      // Always record the USDC debit in the database — this is the source of truth
      // for the user's effective balance until on-chain transfers work at protocol >= 89.
      await db`
        INSERT INTO relayer.usdc_debits (account_id, amount, reason, idempotency_key)
        VALUES (${account_id}, ${amount_usdc}, 'swap', ${idempotency_key})
        ON CONFLICT (idempotency_key) DO NOTHING
      `;

      let txHash: string;
      let amountOut: string;
      try {
        const result = await refFinanceSwap(signingAccount, config, ticker, amount_usdc, account_id, logger);
        txHash = result.txHash;
        amountOut = result.amountOut;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, event: 'ref_swap_error' }, 'Ref Finance swap failed');
        throw new FloorApiError('RELAYER_ERROR', `Ref Finance swap failed: ${msg}`, true, 502);
      }

      // --- Floor opening (if requested and swap produced output) ---
      let floorTxHash: string | null = null;
      let floorId: number | null = null;
      let floorStatus: string = 'none';

      if (floor && amountOut !== '0') {
        try {
          const floorResult = await openFloorAfterSwap(
            signingAccount,
            config,
            account_id,
            ticker,
            amountOut,
            floor.bps,
            floor.duration_secs,
            logger,
            amount_usdc, // pass USDC amount for testnet fair-value calculation
          );
          floorTxHash = floorResult.floorTxHash;
          floorId = floorResult.floorId ?? null;
          floorStatus = 'opened';
          logger.info(
            { floorTxHash, floorId, event: 'floor_open_success' },
            'Floor opened after swap',
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ err: msg, event: 'floor_open_error' }, 'Floor opening failed after swap');
          floorStatus = 'failed';
          // Swap succeeded — don't fail the whole request, report floor failure
        }
      }

      // Persist to Postgres (intent_hash = tx_hash for testnet since no intents protocol)
      await db`
        INSERT INTO relayer.swap_intents
          (idempotency_key, account_id, intent_hash, tx_hash, status, amount_usdc, ticker,
           floor_tx_hash, floor_id, floor_status)
        VALUES
          (${idempotency_key}, ${account_id}, ${txHash}, ${txHash}, 'completed', ${amount_usdc}, ${ticker},
           ${floorTxHash}, ${floorId}, ${floorStatus})
        ON CONFLICT (idempotency_key) DO NOTHING
      `;

      logger.info(
        { txHash, amountOut, floorTxHash, floorStatus, account_id, event: 'swap_committed_ref' },
        'Ref Finance swap committed to DB',
      );

      return reply.status(202).send({
        intent_hash: txHash,
        tx_hash: txHash,
        status: 'completed',
        amount_out: amountOut,
        floor_tx_hash: floorTxHash,
        floor_id: floorId,
        floor_status: floorStatus,
      });
    }

    // -----------------------------------------------------------------------
    // Mainnet path: 1Click intent-based swap
    // -----------------------------------------------------------------------
    const destinationAsset = MAINNET_ASSET_IDS[tickerUpper]!;

    logger.info(
      { account_id, ticker, amount_usdc, event: 'swap_start' },
      'Starting 1Click swap intent',
    );

    // --- Step 1: Get 1Click quote ---
    const quoteDeadline = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    let quote: QuoteResponse['quote'];
    try {
      const quoteResp = await oneClickRequest<QuoteResponse>(`${ONE_CLICK_BASE}/v0/quote`, {
        dry: false,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100, // 1%
        originAsset: MAINNET_ASSET_IDS['USDC_IN'],
        depositType: 'INTENTS',
        destinationAsset,
        amount: amount_usdc,
        refundTo: config.NEAR_ACCOUNT_ID,
        refundType: 'INTENTS',
        recipient: account_id,
        recipientType: 'INTENTS',
        deadline: quoteDeadline,
      });
      quote = quoteResp.quote;
      logger.info(
        { depositAddress: quote.depositAddress, amountOut: quote.amountOut, event: 'swap_quoted' },
        '1Click quote obtained',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, event: 'quote_error' }, '1Click quote failed');
      throw new FloorApiError('RELAYER_ERROR', `1Click quote failed: ${msg}`, true, 502);
    }

    // --- Step 2: Generate NEAR Intents payload ---
    let generatedIntent: GenerateIntentResponse['intent'];
    try {
      const genResp = await oneClickRequest<GenerateIntentResponse>(`${ONE_CLICK_BASE}/v0/generate-intent`, {
        type: 'swap_transfer',
        standard: 'nep413',
        signerId: config.NEAR_ACCOUNT_ID,
        depositAddress: quote.depositAddress,
      });
      generatedIntent = genResp.intent;
      logger.info({ event: 'intent_generated' }, 'Intent payload generated by 1Click');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, event: 'generate_intent_error' }, '1Click generate-intent failed');
      throw new FloorApiError('RELAYER_ERROR', `1Click generate-intent failed: ${msg}`, true, 502);
    }

    // --- Step 3: Sign the intent with relayer key ---
    const nonceBytes = Buffer.from(generatedIntent.payload.nonce, 'base64');
    let signature: string;
    try {
      signature = signNep413(
        config.NEAR_PRIVATE_KEY,
        generatedIntent.payload.message,
        nonceBytes,
        generatedIntent.payload.recipient,
        generatedIntent.payload.callbackUrl ?? undefined,
      );
      logger.info({ event: 'intent_signed' }, 'Intent signed with relayer key');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, event: 'sign_error' }, 'Intent signing failed');
      throw new FloorApiError('RELAYER_ERROR', `Signing failed: ${msg}`, false, 500);
    }

    // Derive public key from private key
    const keyPart = config.NEAR_PRIVATE_KEY.startsWith('ed25519:')
      ? config.NEAR_PRIVATE_KEY.slice('ed25519:'.length)
      : config.NEAR_PRIVATE_KEY;
    const keyBytes = base58Decode(keyPart);
    const secretKey = keyBytes.slice(0, 32);
    const pubKeyBytes = ed25519.getPublicKey(secretKey);
    const publicKey = `ed25519:${base58Encode(pubKeyBytes)}`;

    // --- Step 4: Submit signed intent to 1Click ---
    let intentHash: string;
    try {
      const submitResp = await oneClickRequest<SubmitIntentResponse>(`${ONE_CLICK_BASE}/v0/submit-intent`, {
        type: 'swap_transfer',
        signedData: {
          standard: 'nep413',
          payload: {
            message: generatedIntent.payload.message,
            nonce: generatedIntent.payload.nonce,
            recipient: generatedIntent.payload.recipient,
          },
          public_key: publicKey,
          signature,
        },
      });
      intentHash = submitResp.intentHash;
      logger.info({ intentHash, event: 'intent_submitted' }, 'Intent submitted to 1Click');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, event: 'submit_error' }, '1Click submit-intent failed');
      throw new FloorApiError('RELAYER_ERROR', `1Click submit failed: ${msg}`, true, 502);
    }

    // --- Step 5: Poll for status (max 10s, 500ms intervals) ---
    let finalStatus = 'pending';
    let txHash: string | null = null;

    const statusUrl = `${ONE_CLICK_BASE}/v0/status?depositAddress=${quote.depositAddress}`;
    const pollStart = Date.now();

    while (Date.now() - pollStart < 10_000) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      try {
        const statusResp = await fetch(statusUrl);
        if (!statusResp.ok) break;

        const statusData = await statusResp.json() as StatusResponse;
        const apiStatus = statusData.status?.toUpperCase();

        if (apiStatus === 'COMPLETED') {
          finalStatus = 'completed';
          const hashes = statusData.swapDetails?.nearTxHashes ?? [];
          txHash = hashes[0] ?? null;
          logger.info({ intentHash, txHash, event: 'swap_completed' }, 'Swap completed');
          break;
        } else if (apiStatus === 'FAILED' || apiStatus === 'EXPIRED' || apiStatus === 'REFUNDED') {
          finalStatus = apiStatus.toLowerCase();
          logger.info({ intentHash, status: finalStatus, event: 'swap_failed' }, 'Swap not completed');
          break;
        }
        // Still PENDING / PROCESSING — keep polling
      } catch {
        // transient poll error — keep trying
      }
    }

    // --- Step 6: Persist to Postgres ---
    await db`
      INSERT INTO relayer.swap_intents
        (idempotency_key, account_id, intent_hash, tx_hash, status, amount_usdc, ticker)
      VALUES
        (${idempotency_key}, ${account_id}, ${intentHash}, ${txHash}, ${finalStatus}, ${amount_usdc}, ${ticker})
      ON CONFLICT (idempotency_key) DO NOTHING
    `;

    logger.info(
      { intentHash, txHash, status: finalStatus, account_id, event: 'swap_committed' },
      'Swap intent committed to DB',
    );

    return reply.status(202).send({ intent_hash: intentHash, tx_hash: txHash, status: finalStatus });
  });

  /**
   * GET /v1/relay/swap/:intent_hash
   * Look up a swap intent by its 1Click intent hash (or Ref tx hash on testnet).
   */
  app.get('/v1/relay/swap/:intent_hash', async (request, reply) => {
    const { intent_hash } = request.params as { intent_hash: string };

    const rows = await db<Array<{ intent_hash: string; tx_hash: string | null; status: string }>>`
      SELECT intent_hash, tx_hash, status FROM relayer.swap_intents
      WHERE intent_hash = ${intent_hash}
    `;

    if (rows.length === 0) {
      throw new FloorApiError('NOT_FOUND', `Swap intent ${intent_hash} not found`, false, 404);
    }

    return reply.status(200).send(rows[0]);
  });
}

/** NEP-413 contract ID for NEAR Intents protocol */
export { INTENTS_CONTRACT };
