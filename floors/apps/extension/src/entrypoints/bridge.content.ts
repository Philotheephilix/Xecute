/**
 * Floors content bridge — isolated world entrypoint.
 *
 * Listens for window.postMessage events from the MAIN world content script
 * (content.ts) and forwards them to the extension service worker via
 * chrome.runtime.sendMessage.
 *
 * This split is required because MAIN world content scripts cannot call
 * chrome.runtime — only isolated world scripts have access to extension APIs.
 *
 * On boot (when running on the web-app origin) it also copies the 5 account/
 * credential keys from localStorage into chrome.storage.local via a
 * SYNC_STORAGE message so that the sheet popup (chrome-extension:// origin)
 * can read them.
 */

import { defineContentScript } from 'wxt/utils/define-content-script';

/** Keys written by the web app that the sheet popup needs */
const FLOORS_LS_KEYS = [
  'floors:account_id',
  'floors:credential_id',
  'floors:public_key',
  'floors:compressed_key',
  'floors:floor_defaults',
  'floors:passkeys',
] as const;

export default defineContentScript({
  // Must match the same URLs as content.ts
  matches: ['https://x.com/*', 'https://twitter.com/*', 'http://localhost/*'],
  runAt: 'document_start',
  // ISOLATED world (default) — has access to chrome.runtime
  main() {
    // ── Sync localStorage → chrome.storage.local ───────────────────────────
    // Only run on pages that have the web app's localStorage data.  We guard
    // on document_idle (DOMContentLoaded) so localStorage is accessible.
    function syncStorage() {
      const payload: Record<string, string> = {};
      for (const key of FLOORS_LS_KEYS) {
        try {
          const val = localStorage.getItem(key);
          if (val !== null) payload[key] = val;
        } catch {
          // localStorage may be blocked in some contexts — skip silently
        }
      }
      if (Object.keys(payload).length === 0) return;

      // Tag synced passkeys with source:'web' so the extension sheet knows
      // these were created on the web app (localhost RP ID) and cannot be
      // used for WebAuthn assertions from the chrome-extension:// origin.
      if (payload['floors:passkeys']) {
        try {
          const passkeys = JSON.parse(payload['floors:passkeys']) as Array<Record<string, unknown>>;
          const tagged = passkeys.map((pk) => ({
            ...pk,
            source: pk.source ?? 'web',
          }));
          payload['floors:passkeys'] = JSON.stringify(tagged);
        } catch {
          // Invalid JSON — sync as-is
        }
      }

      chrome.runtime.sendMessage({ type: 'SYNC_STORAGE', payload })
        .catch((err: unknown) => {
          console.warn('[floors-bridge] SYNC_STORAGE failed:', err);
        });
    }

    // Run once at load and again when the web app writes its keys
    // (handles the case where the user registers after the content script boots)
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', syncStorage);
    } else {
      syncStorage();
    }

    // Also re-sync on storage events so newly-written keys are picked up
    window.addEventListener('storage', (ev: StorageEvent) => {
      if (ev.key !== null && (FLOORS_LS_KEYS as readonly string[]).includes(ev.key)) {
        syncStorage();
      }
    });

    // ── Forward postMessage events to service worker ───────────────────────
    window.addEventListener('message', (event: MessageEvent) => {
      // Only handle messages from the same frame (not cross-origin)
      if (event.source !== window) return;

      const data = event.data as Record<string, unknown> | null;
      if (!data || data['__floors__'] !== true) return;

      // Forward to service worker
      const { __floors__: _, ...message } = data;
      chrome.runtime.sendMessage(message)
        .catch((err: unknown) => {
          console.warn('[floors-bridge] Failed to forward message:', err);
        });
    });
  },
});
