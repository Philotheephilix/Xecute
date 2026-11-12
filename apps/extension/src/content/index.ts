/**
 * Floors X Adapter — content script for x.com / twitter.com
 *
 * Observes DOM mutations to find cashtag links and injects
 * a <floors-chip> shadow-root custom element after each one.
 *
 * Security: all X post content goes through textContent only.
 * Untrusted data (post text, hrefs) is never written to innerHTML.
 */

import { FloorsBuyChip, defineFloorsBuyChip } from './chip.js';
import { parseTickerFromHref, isSupportedTicker } from './registry.js';

const CASHTAG_SELECTOR = 'a[data-testid="cashtag"]';

/**
 * WeakMap tracking which cashtag anchors already have a chip injected.
 * Using WeakMap avoids memory leaks when X removes DOM nodes.
 */
const injectedChips = new WeakMap<Element, FloorsBuyChip>();

/**
 * Extract post ID from X URL if present.
 * e.g. https://x.com/user/status/123456789 → '123456789'
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

/**
 * Process a single cashtag anchor and inject a chip if appropriate.
 */
function processAnchor(anchor: Element): void {
  if (injectedChips.has(anchor)) return;

  const href = anchor.getAttribute('href');
  if (!href) return;

  const ticker = parseTickerFromHref(href);
  if (!ticker || !isSupportedTicker(ticker)) return;

  const postId = extractPostId(anchor);
  const chip = new FloorsBuyChip(ticker, postId);

  injectedChips.set(anchor, chip);

  // Insert chip immediately after the cashtag link
  anchor.after(chip);
}

/**
 * Scan the document (or a subtree) for all cashtag anchors and inject chips.
 */
function scanAndInject(root: Document | Element = document): void {
  const anchors = root.querySelectorAll(CASHTAG_SELECTOR);
  anchors.forEach(processAnchor);
}

/**
 * Handle mutation records: process added nodes and re-inject on re-add.
 */
function handleMutations(mutations: MutationRecord[]): void {
  for (const mutation of mutations) {
    if (mutation.type !== 'childList') continue;

    for (const node of mutation.addedNodes) {
      if (!(node instanceof Element)) continue;

      // Check if this node itself is a cashtag anchor
      if (node.matches(CASHTAG_SELECTOR)) {
        processAnchor(node);
      }

      // Check descendants
      scanAndInject(node);
    }
  }
}

/**
 * Main entry point.
 */
function init(): void {
  defineFloorsBuyChip();

  // Initial scan
  scanAndInject();

  // Observe DOM for dynamic X re-renders
  const observer = new MutationObserver(handleMutations);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
  });
}

// Wait for DOM if needed
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
