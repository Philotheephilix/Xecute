/**
 * Floors X Adapter — content script entrypoint for WXT.
 *
 * Runs in the DEFAULT (isolated) world so chrome.runtime is available
 * and CSP cannot block element creation.
 *
 * Observes DOM mutations to find cashtag links and injects a plain
 * <div data-floors-chip> element with inline styles after each one.
 *
 * Detection uses two strategies in order:
 *   1. Selector-based: matches cashtag <a> tags by data-testid, href params,
 *      or search-path patterns.
 *   2. Text-based: walks tweet articles and finds <span> elements whose
 *      textContent matches $TICKER (e.g. "$ETH"). This catches the current
 *      X.com DOM where cashtags are plain text spans inside links or div
 *      wrappers, without stable data-testid or href attributes.
 *
 * SPA navigation detection (Kollateral patterns):
 *   - History API patching (pushState / replaceState / popstate)
 *   - Polling fallback (setInterval every 1s)
 *   - Title mutation observer
 *
 * Security: all X post content goes through textContent only.
 * Untrusted data (post text, hrefs) is never written to innerHTML.
 */

import { defineContentScript } from 'wxt/utils/define-content-script';
import {
  parseTickerFromHref,
  parseTickerFromText,
  isSupportedTicker,
} from '../content/registry.js';
import type { SupportedTicker } from '../content/registry.js';

/**
 * Selector-based detection (Strategy 1).
 *
 * Primary: data-testid="cashtag" — the legacy X attribute.
 * Fallback 1: href contains "cashtag_click" (the src= param X adds).
 * Fallback 2: href contains "%24" within a "/search" path.
 *
 * These may return 0 results on current X.com (2024+) but are kept for
 * backward compatibility and for E2E fixture tests.
 */
const CASHTAG_SELECTOR =
  'a[data-testid="cashtag"], a[href*="cashtag_click"], a[href^="/search?q=%24"]';

/**
 * WeakSet tracking elements that already have a chip injected.
 * Using WeakSet avoids memory leaks when X removes DOM nodes.
 */
const chippedElements = new WeakSet<Element>();

/**
 * Extract post ID from the closest tweet container.
 */
function extractPostId(el: Element): string | undefined {
  const tweet = el.closest('article[role="article"], [data-testid="tweet"]');
  if (!tweet) return undefined;

  const statusLink = tweet.querySelector('a[href*="/status/"]');
  if (!statusLink) return undefined;

  const href = statusLink.getAttribute('href') ?? '';
  const match = /\/status\/(\d+)/.exec(href);
  return match?.[1];
}

/**
 * Detect whether X.com is in dark mode by checking body background luminance.
 */
function isXDarkMode(): boolean {
  try {
    const bg = getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/\d+/g);
    if (m && m.length >= 3) {
      const lum = 0.2126 * +m[0] + 0.7152 * +m[1] + 0.0722 * +m[2];
      return lum < 128;
    }
  } catch { /* ignore */ }
  return true; // default dark — X's default theme
}

/**
 * Create a plain DOM chip element with inline styles.
 * No custom elements, no shadow DOM — works in isolated world without CSP issues.
 *
 * Design: X-native subtle pill — transparent background, X border color,
 * Floors orange text only. Small inline badge (20px height) that sits
 * right next to the cashtag text without disrupting reading flow.
 */
function createChipElement(ticker: SupportedTicker, postId?: string): HTMLDivElement {
  const dark = isXDarkMode();
  const borderColor = dark ? 'rgb(83, 100, 113)' : 'rgb(207, 217, 222)';
  const hoverBg = 'rgba(239, 123, 40, 0.1)';

  const chip = document.createElement('div');
  chip.setAttribute('data-floors-chip', ticker);
  chip.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 6px;
    margin-left: 4px;
    max-height: 20px;
    background: transparent;
    border: 1px solid ${borderColor};
    border-radius: 9999px;
    cursor: pointer;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 11px;
    font-weight: 700;
    color: #EF7B28;
    line-height: 1;
    white-space: nowrap;
    user-select: none;
    vertical-align: middle;
    transition: background-color 0.2s;
  `;

  const label = document.createElement('span');
  // Safe: ticker is validated against a fixed allowlist before chip creation
  label.textContent = 'Buy ↗';

  chip.appendChild(label);

  chip.addEventListener('click', (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
    // In isolated world, chrome.runtime IS available
    chrome.runtime.sendMessage({
      type: 'OPEN_SHEET',
      ticker: ticker,
      ...(postId ? { postId } : {}),
    });
  });

  // Hover/active effects — subtle background tint on hover
  chip.addEventListener('mouseenter', () => { chip.style.backgroundColor = hoverBg; });
  chip.addEventListener('mouseleave', () => { chip.style.backgroundColor = 'transparent'; });
  chip.addEventListener('mousedown', () => {
    chip.style.transform = 'translateY(0.5px)';
  });
  chip.addEventListener('mouseup', () => {
    chip.style.transform = '';
  });

  return chip;
}

/**
 * Inject a chip after the given element for the given ticker.
 * Returns true if a chip was injected, false if already chipped or invalid.
 */
function injectChip(el: Element, ticker: SupportedTicker): boolean {
  if (chippedElements.has(el)) return false;

  const postId = extractPostId(el);
  const chip = createChipElement(ticker, postId);

  chippedElements.add(el);
  el.after(chip);
  return true;
}

// ── Strategy 1: Selector-based ──────────────────────────────────────────────

function processAnchor(anchor: Element): void {
  if (chippedElements.has(anchor)) return;

  // Skip elements already inside a chip (dedup guard)
  if (anchor.closest('[data-floors-chip]')) return;

  const href = anchor.getAttribute('href');
  if (!href) return;

  const ticker = parseTickerFromHref(href);
  if (!ticker || !isSupportedTicker(ticker)) return;

  injectChip(anchor, ticker);
}

function selectorScan(root: Document | Element = document): void {
  // Only scan inside tweet articles — not the header, tabs, sidebar, etc.
  const tweets = root.querySelectorAll('article[role="article"], [data-testid="tweet"]');
  const containers: Element[] = Array.from(tweets);

  // If root itself is a tweet, include it
  if ((root as Element).matches?.('article[role="article"], [data-testid="tweet"]')) {
    containers.push(root as Element);
  }

  for (const tweet of containers) {
    const anchors = tweet.querySelectorAll(CASHTAG_SELECTOR);
    anchors.forEach(processAnchor);
  }
}

// ── Strategy 2: Text-based ──────────────────────────────────────────────────

/**
 * Walk an element subtree looking for spans/links whose textContent is a
 * cashtag like "$ETH". This catches X.com's current rendering where cashtags
 * are <span> elements (sometimes inside <a> wrappers) without stable
 * data-testid or href attributes.
 *
 * The chip is injected after the cashtag element (the <a> parent if the span
 * is inside a link, otherwise after the span itself).
 */
function textScan(root: Document | Element = document): void {
  // ONLY scan inside tweet articles — not the header, tabs, sidebar, etc.
  // This prevents injecting chips in the search bar, tab nav, trending, etc.
  const tweets = root.querySelectorAll('article[role="article"], [data-testid="tweet"]');
  const containers: Element[] = Array.from(tweets);

  // If root itself is a tweet, include it
  if ((root as Element).matches?.('article[role="article"], [data-testid="tweet"]')) {
    containers.push(root as Element);
  }

  // No tweet containers found — nothing to scan
  if (containers.length === 0) return;

  for (const tweet of containers) {
    // Find all spans and anchor elements within this tweet only
    const candidates = tweet.querySelectorAll('span, a');

    for (const el of candidates) {
      if (chippedElements.has(el)) continue;

      // Skip elements already inside a chip (dedup guard)
      if (el.closest('[data-floors-chip]')) continue;

      const text = el.textContent?.trim();
      if (!text) continue;

      const ticker = parseTickerFromText(text);
      if (!ticker || !isSupportedTicker(ticker)) continue;

      // Avoid chipping deeply nested containers — only act on leaf-ish elements
      // whose textContent is EXACTLY the cashtag (no extra text around it).
      // This prevents chipping a parent <div> that contains "$ETH is great".
      // Compare case-insensitively since X.com renders "$ETH", "$eth", "$Eth" etc.
      if (text.toUpperCase() !== `$${ticker}`) continue;

      // If this span is inside an <a>, chip after the <a> instead
      const parent = el.parentElement;
      const chipTarget =
        el.tagName === 'SPAN' && parent?.tagName === 'A' ? parent : el;

      // Skip if the chip target was already processed or is inside a chip
      if (chippedElements.has(chipTarget)) continue;
      if (chipTarget.closest('[data-floors-chip]')) continue;

      injectChip(chipTarget, ticker);
    }
  }
}

// ── Combined scan ───────────────────────────────────────────────────────────

function scanAndInject(root: Document | Element = document): void {
  selectorScan(root);
  textScan(root);
}

function handleMutations(mutations: MutationRecord[]): void {
  for (const mutation of mutations) {
    if (mutation.type !== 'childList') continue;

    for (const node of mutation.addedNodes) {
      if (!(node instanceof Element)) continue;

      // Strategy 1: selector match on the node itself — only if inside a tweet
      if (
        node.matches?.(CASHTAG_SELECTOR) &&
        node.closest('article[role="article"], [data-testid="tweet"]')
      ) {
        processAnchor(node);
      }

      // Both strategies on the subtree (already scoped to tweet containers)
      scanAndInject(node);
    }
  }
}

// ── SPA navigation detection (Kollateral patterns) ─────────────────────────

/**
 * Patch History API to fire a custom event on pushState/replaceState.
 * X.com is an SPA and navigates without full page reloads.
 */
function patchHistoryAPI(): void {
  const fire = () => window.dispatchEvent(new Event('floors:locationchange'));

  const wrapMethod = (name: 'pushState' | 'replaceState') => {
    const orig = history[name].bind(history);
    history[name] = function (...args: Parameters<typeof history.pushState>) {
      const ret = orig(...args);
      fire();
      return ret;
    };
  };

  wrapMethod('pushState');
  wrapMethod('replaceState');
  window.addEventListener('popstate', fire);
}

/**
 * Observe <title> mutations — X updates the title on SPA navigations.
 * When the title changes, re-scan for cashtags.
 */
function observeTitleChanges(): void {
  const titleEl = document.querySelector('title');
  if (!titleEl) return;

  const titleObserver = new MutationObserver(() => {
    scanAndInject();
  });

  titleObserver.observe(titleEl, {
    subtree: true,
    characterData: true,
    childList: true,
  });
}

// Isolated world content script: uses plain DOM chips and chrome.runtime directly.
export default defineContentScript({
  // http://localhost:* is included for E2E smoke tests (fixture file server).
  matches: ['https://x.com/*', 'https://twitter.com/*', 'http://localhost/*'],
  runAt: 'document_idle',
  main() {
    console.log('[floors] Content script loaded (isolated world), scanning for cashtags...');

    // Initial scan
    scanAndInject();

    // DOM mutation observer for dynamic X re-renders
    const observer = new MutationObserver(handleMutations);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
    });

    // SPA navigation detection — History API patching
    patchHistoryAPI();
    window.addEventListener('floors:locationchange', () => {
      setTimeout(() => scanAndInject(), 150);
    });

    // SPA navigation detection — title mutation observer
    observeTitleChanges();

    // SPA navigation detection — polling fallback (catches edge cases)
    setInterval(() => scanAndInject(), 1000);
  },
});
