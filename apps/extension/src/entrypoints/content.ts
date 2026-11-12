/**
 * Floors X Adapter — content script entrypoint for WXT.
 *
 * Observes DOM mutations to find cashtag links and injects
 * a <floors-chip> shadow-root custom element after each one.
 *
 * Security: all X post content goes through textContent only.
 * Untrusted data (post text, hrefs) is never written to innerHTML.
 */

import { defineContentScript } from 'wxt/utils/define-content-script';
import { FloorsBuyChip, defineFloorsBuyChip } from '../content/chip.js';
import { parseTickerFromHref, isSupportedTicker } from '../content/registry.js';

const CASHTAG_SELECTOR = 'a[data-testid="cashtag"]';

/**
 * WeakMap tracking which cashtag anchors already have a chip injected.
 */
const injectedChips = new WeakMap<Element, FloorsBuyChip>();

/**
 * Extract post ID from the closest tweet container.
 */
function extractPostId(anchor: Element): string | undefined {
  const closestStatus = anchor.closest('[data-testid="tweet"]');
  if (!closestStatus) return undefined;

  const statusLink = closestStatus.querySelector('a[href*="/status/"]');
  if (!statusLink) return undefined;

  const href = statusLink.getAttribute('href') ?? '';
  const match = /\/status\/(\d+)/.exec(href);
  return match?.[1];
}

function processAnchor(anchor: Element): void {
  if (injectedChips.has(anchor)) return;

  const href = anchor.getAttribute('href');
  if (!href) return;

  const ticker = parseTickerFromHref(href);
  if (!ticker || !isSupportedTicker(ticker)) return;

  const postId = extractPostId(anchor);
  const chip = new FloorsBuyChip(ticker, postId);

  injectedChips.set(anchor, chip);
  anchor.after(chip);
}

function scanAndInject(root: Document | Element = document): void {
  const anchors = root.querySelectorAll(CASHTAG_SELECTOR);
  anchors.forEach(processAnchor);
}

function handleMutations(mutations: MutationRecord[]): void {
  for (const mutation of mutations) {
    if (mutation.type !== 'childList') continue;

    for (const node of mutation.addedNodes) {
      if (!(node instanceof Element)) continue;

      if (node.matches(CASHTAG_SELECTOR)) {
        processAnchor(node);
      }

      scanAndInject(node);
    }
  }
}

// MAIN world content script: defines the custom element and injects chips.
// chrome.runtime is NOT available in MAIN world — use window.postMessage to
// communicate with the isolated-world bridge (content-bridge.ts).
export default defineContentScript({
  // http://localhost:* is included for E2E smoke tests (fixture file server).
  matches: ['https://x.com/*', 'https://twitter.com/*', 'http://localhost/*'],
  runAt: 'document_idle',
  world: 'MAIN',
  main() {
    defineFloorsBuyChip();
    scanAndInject();

    const observer = new MutationObserver(handleMutations);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
    });
  },
});
