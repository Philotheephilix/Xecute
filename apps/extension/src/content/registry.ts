/**
 * Supported tickers for S4.
 * STRK is deferred per ADR-0006.
 */
export const SUPPORTED_TICKERS = new Set(['ETH', 'SOL', 'BTC'] as const);
export type SupportedTicker = 'ETH' | 'SOL' | 'BTC';

export function isSupportedTicker(ticker: string): ticker is SupportedTicker {
  return SUPPORTED_TICKERS.has(ticker as SupportedTicker);
}

/**
 * Parse ticker from X cashtag href.
 * e.g. /search?q=%24ETH&src=cashtag_click → 'ETH'
 */
export function parseTickerFromHref(href: string): string | null {
  try {
    // Use URL parsing to safely extract query param
    const fullUrl = href.startsWith('/') ? `https://x.com${href}` : href;
    const url = new URL(fullUrl);
    const q = url.searchParams.get('q');
    if (!q) return null;
    // q is like $ETH or %24ETH (already decoded by URL)
    if (q.startsWith('$')) {
      return q.slice(1).toUpperCase();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Regex matching cashtag text: "$ETH", "$Sol", "$btc", etc.
 * 2–6 letter tickers, case-insensitive. The $ must be the first char.
 */
const CASHTAG_TEXT_RE = /^\$([A-Za-z]{2,6})$/;

/**
 * Parse ticker from element textContent.
 * e.g. "$ETH" → "ETH", "$sol" → "SOL", "hello" → null
 *
 * Safe: only reads textContent, never innerHTML.
 */
export function parseTickerFromText(text: string): string | null {
  const trimmed = text.trim();
  const match = CASHTAG_TEXT_RE.exec(trimmed);
  if (!match) return null;
  return match[1].toUpperCase();
}
