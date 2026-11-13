/**
 * Floors service worker (background entrypoint for WXT).
 *
 * WXT evaluates entrypoint modules at build time to find metadata.
 * All runtime logic must live inside defineBackground() → main().
 */

import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { z } from 'zod';
import { MessageSchema } from '../content/messages.js';

const API_URL = (import.meta as ImportMeta & { env: Record<string, string> }).env['VITE_API_URL'] ?? 'http://localhost:3001';

export default defineBackground(() => {

  // ── Registry types ──────────────────────────────────────────────────────
  const TokenSchema = z.object({
    ticker: z.string(),
    name: z.string(),
    chainId: z.string(),
    address: z.string().optional(),
    decimals: z.number().int().gte(0),
    logoUrl: z.string().url().optional(),
  });

  const RegistrySchema = z.array(TokenSchema);
  type Registry = typeof RegistrySchema._type;

  const CachedRegistrySchema = z.object({
    data: RegistrySchema,
    cachedAt: z.number(),
  });

  // ── Hardcoded S4 registry ──────────────────────────────────────────────
  const S4_REGISTRY: Registry = [
    {
      ticker: 'ETH',
      name: 'Ethereum',
      chainId: 'eip155:1',
      address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      decimals: 18,
      logoUrl: 'https://assets.floors.xyz/eth.png',
    },
    {
      ticker: 'SOL',
      name: 'Solana',
      chainId: 'solana:mainnet',
      decimals: 9,
      logoUrl: 'https://assets.floors.xyz/sol.png',
    },
  ];

  const REGISTRY_CACHE_KEY = 'registry_cache';
  const REGISTRY_TTL_MS = 5 * 60 * 1000;

  async function getCachedRegistry(): Promise<Registry> {
    const result = await browser.storage.local.get(REGISTRY_CACHE_KEY);
    const raw = (result as Record<string, unknown>)[REGISTRY_CACHE_KEY];

    if (!raw) return refreshRegistry();

    const parsed = CachedRegistrySchema.safeParse(raw);
    if (!parsed.success) return refreshRegistry();

    const age = Date.now() - parsed.data.cachedAt;
    if (age > REGISTRY_TTL_MS) return refreshRegistry();

    return parsed.data.data;
  }

  async function refreshRegistry(): Promise<Registry> {
    const cached = { data: S4_REGISTRY, cachedAt: Date.now() };
    await browser.storage.local.set({ [REGISTRY_CACHE_KEY]: cached });
    return S4_REGISTRY;
  }

  async function openSheet(ticker: string, postId?: string): Promise<void> {
    const params = new URLSearchParams({ ticker });
    if (postId !== undefined) params.set('postId', postId);

    await browser.windows.create({
      url: browser.runtime.getURL(`sheet.html?${params.toString()}`),
      type: 'popup',
      width: 412,
      height: 680,
      focused: true,
    });
  }

  // ── API call ──────────────────────────────────────────────────────────────
  interface BuyApiResponse {
    request_id: string;
    tx_hash: string;
    status: string;
  }

  async function postBuy(
    ticker: string,
    amount: string,
    signature: string,
    credentialId: string,
    floorProtection: boolean,
    quoteId: string,
    idempotencyKey: string,
  ): Promise<BuyApiResponse> {
    const amountUsdc = Math.round(parseFloat(amount) * 1_000_000).toString();

    const signedIntent = {
      ticker,
      amount_usdc: amountUsdc,
      floor_protection: floorProtection,
      signature,
      credential_id: credentialId,
    };

    const res = await fetch(`${API_URL}/v1/buy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        signed_intent: signedIntent,
        quote_id: quoteId,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API /v1/buy returned ${res.status.toString()}: ${body}`);
    }

    return res.json() as Promise<BuyApiResponse>;
  }

  // ── Extended SHEET_SIGNED schema (includes extra fields from sheet) ───────
  const SheetSignedExtendedSchema = z.object({
    type: z.literal('SHEET_SIGNED'),
    ticker: z.string(),
    amount: z.string(),
    signature: z.string(),
    publicKey: z.string(),
    credentialId: z.string(),
    floorProtection: z.boolean(),
    quoteId: z.string(),
  });

  // ── Message handler ──────────────────────────────────────────────────────
  type MessageResponse =
    | { status: 'ok' }
    | { status: 'ok'; request_id: string; tx_hash: string }
    | { registry: Registry }
    | { error: string };

  browser.runtime.onMessage.addListener(
    (
      rawMessage: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: MessageResponse) => void,
    ): boolean => {
      const parsed = MessageSchema.safeParse(rawMessage);

      if (!parsed.success) {
        sendResponse({ error: 'Invalid message schema' });
        return false;
      }

      const message = parsed.data;

      switch (message.type) {
        case 'PING': {
          sendResponse({ status: 'ok' });
          return false;
        }

        case 'OPEN_SHEET': {
          openSheet(message.ticker, message.postId)
            .then(() => sendResponse({ status: 'ok' }))
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              sendResponse({ error: msg });
            });
          return true;
        }

        case 'GET_REGISTRY': {
          getCachedRegistry()
            .then((registry) => sendResponse({ registry }))
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              sendResponse({ error: msg });
            });
          return true;
        }

        case 'SHEET_SIGNED': {
          // Parse the extended message (quoteId, amount, credentialId, floorProtection)
          const extended = SheetSignedExtendedSchema.safeParse(rawMessage);
          if (!extended.success) {
            console.error('[floors] SHEET_SIGNED missing required fields:', extended.error);
            sendResponse({ error: 'SHEET_SIGNED missing required fields' });
            return false;
          }

          const { ticker, amount, signature, credentialId, floorProtection, quoteId } = extended.data;
          const idempotencyKey = crypto.randomUUID();

          console.info('[floors] Posting buy to API:', { ticker, quoteId });

          postBuy(ticker, amount, signature, credentialId, floorProtection, quoteId, idempotencyKey)
            .then((apiResponse) => {
              console.info('[floors] Buy submitted:', apiResponse);
              sendResponse({
                status: 'ok',
                request_id: apiResponse.request_id,
                tx_hash: apiResponse.tx_hash,
              });
            })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              console.error('[floors] Buy API error:', msg);
              sendResponse({ error: msg });
            });

          return true;
        }

        default: {
          const _exhaustive: never = message;
          sendResponse({
            error: `Unknown message type: ${String(_exhaustive)}`,
          });
          return false;
        }
      }
    },
  );

  browser.runtime.onInstalled.addListener(() => {
    refreshRegistry().catch((err) => {
      console.error('[floors] Registry refresh failed:', err);
    });
  });
});
