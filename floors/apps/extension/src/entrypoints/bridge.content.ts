/**
 * Floors content bridge — isolated world entrypoint.
 *
 * Listens for window.postMessage events from the MAIN world content script
 * (content.ts) and forwards them to the extension service worker via
 * chrome.runtime.sendMessage.
 *
 * This split is required because MAIN world content scripts cannot call
 * chrome.runtime — only isolated world scripts have access to extension APIs.
 */

import { defineContentScript } from 'wxt/utils/define-content-script';

export default defineContentScript({
  // Must match the same URLs as content.ts
  matches: ['https://x.com/*', 'https://twitter.com/*', 'http://localhost/*'],
  runAt: 'document_start',
  // ISOLATED world (default) — has access to chrome.runtime
  main() {
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
