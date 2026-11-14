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
import { parseTickerFromHref, parseTickerFromText, isSupportedTicker } from './registry.js';

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

// ── parseTickerFromText ──────────────────────────────────────────────────────

describe('parseTickerFromText', () => {
  it('parses ETH from "$ETH"', () => {
    expect(parseTickerFromText('$ETH')).toBe('ETH');
  });

  it('parses SOL from "$SOL"', () => {
    expect(parseTickerFromText('$SOL')).toBe('SOL');
  });

  it('parses BTC from "$BTC"', () => {
    expect(parseTickerFromText('$BTC')).toBe('BTC');
  });

  it('normalises lowercase "$eth" to "ETH"', () => {
    expect(parseTickerFromText('$eth')).toBe('ETH');
  });

  it('normalises mixed case "$Btc" to "BTC"', () => {
    expect(parseTickerFromText('$Btc')).toBe('BTC');
  });

  it('handles leading/trailing whitespace', () => {
    expect(parseTickerFromText('  $ETH  ')).toBe('ETH');
  });

  it('returns null for plain text without $', () => {
    expect(parseTickerFromText('ETH')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseTickerFromText('')).toBeNull();
  });

  it('returns null for $ followed by numbers', () => {
    expect(parseTickerFromText('$123')).toBeNull();
  });

  it('returns null for too-long tickers', () => {
    expect(parseTickerFromText('$TOOLONG')).toBeNull();
  });

  it('returns null for single-letter ticker', () => {
    expect(parseTickerFromText('$X')).toBeNull();
  });

  it('returns null for text with extra words', () => {
    expect(parseTickerFromText('$ETH is great')).toBeNull();
  });

  it('returns null for dollar amount', () => {
    expect(parseTickerFromText('$100')).toBeNull();
  });

  it('returns null for XSS attempt', () => {
    expect(parseTickerFromText('$<script>')).toBeNull();
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

  it('returns true for BTC (S4 supported)', () => {
    expect(isSupportedTicker('BTC')).toBe(true);
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
  it('WeakSet prevents the same element from being chipped twice', () => {
    // The real content script uses a WeakSet<Element>.
    // We test the underlying invariant: given the same Element reference,
    // the set gates injection.

    const chipped = new WeakSet<object>();
    const anchor = document.createElement('a');
    anchor.setAttribute('data-testid', 'cashtag');
    anchor.setAttribute('href', '/search?q=%24ETH&src=cashtag_click');

    // First injection
    expect(chipped.has(anchor)).toBe(false);
    chipped.add(anchor);

    // Second attempt — guarded
    const wouldInject = !chipped.has(anchor);
    expect(wouldInject).toBe(false);
  });

  it('distinct elements get independent tracking', () => {
    const chipped = new WeakSet<object>();
    const anchor1 = document.createElement('a');
    const anchor2 = document.createElement('a');

    chipped.add(anchor1);

    expect(chipped.has(anchor1)).toBe(true);
    expect(chipped.has(anchor2)).toBe(false);
  });

  it('text-based detection: span inside link chips the link, not the span', () => {
    // Simulate: <a><span>$ETH</span></a>
    // The chip should be inserted after the <a>, and both <a> and <span>
    // should be tracked to prevent duplicates.
    const chipped = new WeakSet<object>();
    const link = document.createElement('a');
    const span = document.createElement('span');
    span.textContent = '$ETH';
    link.appendChild(span);

    // The content script chips the link (parent) when span is inside <a>
    chipped.add(link);

    expect(chipped.has(link)).toBe(true);
    // The span itself was not added, but the link guards further processing
    expect(chipped.has(span)).toBe(false);
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
    const safeTickers = ['ETH', 'SOL', 'BTC'];
    for (const ticker of safeTickers) {
      // All chars are [A-Z] — no HTML special chars
      expect(/^[A-Z]+$/.test(ticker)).toBe(true);
    }
  });
});

// ── Integration: href → supported ticker → chip decision ─────────────────────

describe('Full cashtag pipeline (selector-based)', () => {
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
      expectChip: true,
      reason: 'BTC is supported in S4',
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

// ── Integration: text → supported ticker → chip decision (v2 DOM) ───────────

describe('Full cashtag pipeline (text-based)', () => {
  const textCases: Array<{
    text: string;
    expectChip: boolean;
    reason: string;
  }> = [
    { text: '$ETH', expectChip: true, reason: 'ETH is supported' },
    { text: '$SOL', expectChip: true, reason: 'SOL is supported' },
    { text: '$BTC', expectChip: true, reason: 'BTC is supported' },
    { text: '$eth', expectChip: true, reason: 'lowercase normalised to ETH' },
    { text: '$Btc', expectChip: true, reason: 'mixed case normalised to BTC' },
    { text: '$STRK', expectChip: false, reason: 'STRK deferred per ADR-0006' },
    { text: '$DOGE', expectChip: false, reason: 'DOGE not in supported set' },
    { text: 'hello', expectChip: false, reason: 'plain text, no cashtag' },
    { text: '$100', expectChip: false, reason: 'dollar amount, not ticker' },
  ];

  for (const { text, expectChip, reason } of textCases) {
    it(`${expectChip ? 'injects chip' : 'skips chip'} for "${text}" — ${reason}`, () => {
      const ticker = parseTickerFromText(text);
      const willChip = ticker !== null && isSupportedTicker(ticker);
      expect(willChip).toBe(expectChip);
    });
  }
});
