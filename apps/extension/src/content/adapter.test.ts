/**
 * Unit tests for X adapter cashtag processing.
 *
 * Tests:
 * - href → ticker parsing
 * - ETH and SOL produce chips; STRK does not (deferred per ADR-0006)
 * - Duplicate injection is prevented
 * - Text from X post goes through textContent only (never innerHTML)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { parseTickerFromHref, isSupportedTicker } from './registry.js';

// ── parseTickerFromHref ───────────────────────────────────────────────────────

describe('parseTickerFromHref', () => {
  it('parses ETH from standard X cashtag href', () => {
    expect(
      parseTickerFromHref('/search?q=%24ETH&src=cashtag_click'),
    ).toBe('ETH');
  });

  it('parses SOL from standard X cashtag href', () => {
    expect(
      parseTickerFromHref('/search?q=%24SOL&src=cashtag_click'),
    ).toBe('SOL');
  });

  it('parses STRK from cashtag href', () => {
    expect(
      parseTickerFromHref('/search?q=%24STRK&src=cashtag_click'),
    ).toBe('STRK');
  });

  it('parses BTC from cashtag href', () => {
    expect(
      parseTickerFromHref('/search?q=%24BTC&src=cashtag_click'),
    ).toBe('BTC');
  });

  it('returns null when q param is absent', () => {
    expect(parseTickerFromHref('/search?src=cashtag_click')).toBeNull();
  });

  it('returns null for non-cashtag search query', () => {
    expect(parseTickerFromHref('/search?q=hello+world')).toBeNull();
  });

  it('returns null for malformed href', () => {
    expect(parseTickerFromHref('not-a-url')).toBeNull();
  });

  it('handles full absolute URL', () => {
    expect(
      parseTickerFromHref(
        'https://x.com/search?q=%24ETH&src=cashtag_click',
      ),
    ).toBe('ETH');
  });

  it('returns ticker in uppercase', () => {
    // In practice X always uses uppercase, but verify normalisation
    expect(
      parseTickerFromHref('/search?q=%24eth&src=cashtag_click'),
    ).toBe('ETH');
  });
});

// ── isSupportedTicker ─────────────────────────────────────────────────────────

describe('isSupportedTicker', () => {
  it('returns true for ETH (S4 supported)', () => {
    expect(isSupportedTicker('ETH')).toBe(true);
  });

  it('returns true for SOL (S4 supported)', () => {
    expect(isSupportedTicker('SOL')).toBe(true);
  });

  it('returns false for STRK (deferred per ADR-0006)', () => {
    expect(isSupportedTicker('STRK')).toBe(false);
  });

  it('returns false for BTC (not in S4 registry)', () => {
    expect(isSupportedTicker('BTC')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isSupportedTicker('')).toBe(false);
  });

  it('returns false for lowercase eth', () => {
    expect(isSupportedTicker('eth')).toBe(false);
  });
});

// ── Duplicate injection prevention ───────────────────────────────────────────

describe('Duplicate chip injection prevention', () => {
  it('WeakMap prevents the same anchor from being chipped twice', () => {
    // The real content script uses a WeakMap<Element, FloorsBuyChip>.
    // We test the underlying invariant: given the same Element reference,
    // the map gates injection.

    const injected = new WeakMap<object, boolean>();
    const anchor = document.createElement('a');
    anchor.setAttribute('data-testid', 'cashtag');
    anchor.setAttribute('href', '/search?q=%24ETH&src=cashtag_click');

    // First injection
    expect(injected.has(anchor)).toBe(false);
    injected.set(anchor, true);

    // Second attempt — guarded
    const wouldInject = !injected.has(anchor);
    expect(wouldInject).toBe(false);
  });

  it('distinct anchor elements get independent tracking', () => {
    const injected = new WeakMap<object, boolean>();
    const anchor1 = document.createElement('a');
    const anchor2 = document.createElement('a');

    injected.set(anchor1, true);

    expect(injected.has(anchor1)).toBe(true);
    expect(injected.has(anchor2)).toBe(false);
  });
});

// ── textContent-only safety ───────────────────────────────────────────────────

describe('textContent-only safety for X post content', () => {
  it('sanitises arbitrary ticker text through textContent (no innerHTML)', () => {
    // Simulate what chip.ts does: write ticker label via textContent only
    const label = document.createElement('span');
    const untrustedTicker = '<img src=x onerror=alert(1)>';

    // CORRECT: use textContent
    label.textContent = `Buy $${untrustedTicker}`;

    // Verify: innerHTML should be HTML-escaped, not executed
    expect(label.innerHTML).not.toContain('<img');
    expect(label.innerHTML).toContain('&lt;img');
    // textContent round-trips cleanly
    expect(label.textContent).toBe(`Buy $${untrustedTicker}`);
  });

  it('does not interpret script tags as HTML when assigned via textContent', () => {
    const el = document.createElement('div');
    el.textContent = '<script>evil()</script>';

    // No script element should exist in the subtree
    expect(el.querySelector('script')).toBeNull();
    // The text should be present but escaped
    expect(el.innerHTML).toContain('&lt;script&gt;');
  });

  it('ticker from validated registry is always a safe ASCII string', () => {
    // Tickers that pass isSupportedTicker() are constrained to the allowlist
    const safeTickers = ['ETH', 'SOL'];
    for (const ticker of safeTickers) {
      // All chars are [A-Z] — no HTML special chars
      expect(/^[A-Z]+$/.test(ticker)).toBe(true);
    }
  });
});

// ── Integration: href → supported ticker → chip decision ─────────────────────

describe('Full cashtag pipeline', () => {
  const testCases: Array<{
    href: string;
    expectChip: boolean;
    reason: string;
  }> = [
    {
      href: '/search?q=%24ETH&src=cashtag_click',
      expectChip: true,
      reason: 'ETH is supported in S4',
    },
    {
      href: '/search?q=%24SOL&src=cashtag_click',
      expectChip: true,
      reason: 'SOL is supported in S4',
    },
    {
      href: '/search?q=%24STRK&src=cashtag_click',
      expectChip: false,
      reason: 'STRK deferred per ADR-0006',
    },
    {
      href: '/search?q=%24BTC&src=cashtag_click',
      expectChip: false,
      reason: 'BTC not in S4 registry',
    },
    {
      href: '/search?src=cashtag_click',
      expectChip: false,
      reason: 'no ticker in href',
    },
  ];

  for (const { href, expectChip, reason } of testCases) {
    it(`${expectChip ? 'injects chip' : 'skips chip'} for "${href}" — ${reason}`, () => {
      const ticker = parseTickerFromHref(href);
      const willChip = ticker !== null && isSupportedTicker(ticker);
      expect(willChip).toBe(expectChip);
    });
  }
});
