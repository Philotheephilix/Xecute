import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FloorApiError } from '@floors/shared-server';
import { sha256 } from '@noble/hashes/sha256';
import { ed25519 } from '@noble/curves/ed25519';
import type pino from 'pino';
import type { Sql } from 'postgres';
import type { RelayerConfig } from '../index.js';

// ---------------------------------------------------------------------------
// Request / response schemas
// ---------------------------------------------------------------------------

const SwapBodySchema = z.object({
  account_id: z.string().min(1),
  ticker: z.string().min(1),
  amount_usdc: z.string().regex(/^\d+$/, 'amount_usdc must be a non-negative integer string'),
  idempotency_key: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Token IDs (confirmed from live /v0/tokens endpoint)
// ---------------------------------------------------------------------------

const ASSET_IDS: Record<string, string> = {
  ETH: 'nep141:eth.omft.near',
  USDC_IN: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
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
// NEP-413 signing
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
// 1Click API helpers
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
// Route registration
// ---------------------------------------------------------------------------

export function registerSwapRoutes(
  app: FastifyInstance,
  logger: pino.Logger,
  db: Sql,
  config: RelayerConfig,
): void {
  /**
   * POST /v1/relay/swap
   *
   * Accepts a buy request (ticker, amount_usdc, account_id) and:
   * 1. Gets a 1Click quote for USDC → ticker swap
   * 2. Generates the NEAR Intents payload via 1Click /generate-intent
   * 3. Signs with the relayer's floors-dev key (NEP-413)
   * 4. Submits to 1Click /submit-intent
   * 5. Polls for status (max 10s)
   * 6. Persists in Postgres and returns the result
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

    const { account_id, ticker, amount_usdc, idempotency_key } = bodyResult.data;

    // Resolve destination asset
    const destinationAsset = ASSET_IDS[ticker.toUpperCase()];
    if (destinationAsset === undefined) {
      throw new FloorApiError(
        'VALIDATION_ERROR',
        `Unsupported ticker: ${ticker}. Supported: ${Object.keys(ASSET_IDS).filter(k => k !== 'USDC_IN').join(', ')}`,
        false,
        400,
      );
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
        originAsset: ASSET_IDS['USDC_IN'],
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
   * Look up a swap intent by its 1Click intent hash.
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
