# ADR-0006: X Cashtag Detection Accuracy

Date: 2026-11-13
Status: Accepted

## Context

The Floors extension must detect `$ETH`, `$SOL`, and `$STRK` mentions in X (Twitter) posts
and surface a "Buy" chip next to them. We need to know: how reliably can we detect these
cashtags, what DOM pattern to target, what are the false-positive risks, and whether X's
React rendering causes detection loss.

## Research findings

### 1. X cashtag DOM structure

X (formerly Twitter) renders cashtags as anchor elements (`<a>`) within tweet text.
The known attributes (from browser extension community research and X's consistent behavior
since at least 2022):

```html
<a
  href="/search?q=%24ETH&src=cashtag_click"
  data-testid="cashtag"
  role="link"
>
  $ETH
</a>
```

Key attributes:

| Attribute | Value pattern |
|-----------|--------------|
| `href` | `/search?q=%24{TICKER}&src=cashtag_click` |
| `data-testid` | `"cashtag"` |
| `role` | `"link"` |

This differs from hashtags (`data-testid="hashtag"`, `href="/hashtag/{TAG}`) and user
mentions (`data-testid="UserAvatar"` / `href="/{username}"`).

**CSS selector:** `a[data-testid="cashtag"]`

This selector is stable across X's React updates because `data-testid` attributes are
intentionally preserved for testing infrastructure and tend to be more stable than class names.

### 2. Selector stability and React re-rendering

X's frontend is a React SPA. Content is hydrated and tweets load dynamically as the user
scrolls. Key implications for the extension:

- **Static DOM queries at page-load miss all dynamically rendered tweets.** A
  `document.querySelector` on load will find 0 cashtag elements.
- **`MutationObserver` on `document.body` with `{ childList: true, subtree: true }` is required.**
  Each batch of new tweet DOM nodes triggers the observer callback.
- **React reconciliation re-uses DOM nodes** during scroll virtualization; anchor elements
  may be mutated in-place (text/href changed) rather than replaced. The observer's
  `addedNodes` may not include re-used nodes. Mitigation: observe `characterData` changes
  in addition to `childList`, or re-scan the visible tweet container on each mutation.
- **Recommended pattern:**
  ```ts
  const observer = new MutationObserver(() => {
    document.querySelectorAll('a[data-testid="cashtag"]')
      .forEach(processCashtag);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  ```
  This re-scans all current cashtag nodes on every DOM mutation — slightly redundant but
  robust against reconciliation re-use.

### 3. False positive risk: crypto vs. stock tickers

X uses the same `data-testid="cashtag"` and `href="/search?q=%24{TICKER}&src=cashtag_click"`
for **all** cashtags, whether crypto or traditional equities. Examples of collision risk:

| Ticker | Crypto | Equity |
|--------|--------|--------|
| `$ETH` | Ethereum | (no major equity collision) |
| `$SOL` | Solana | (no major equity collision) |
| `$STRK` | StarkNet | STRK (Strike Inc.) — **collision** |

`$ETH` and `$SOL` have negligible false-positive risk (no major stock uses those tickers).
`$STRK` collides with Strike, Inc. (NASDAQ: STRK). False positive rate for `$STRK` is
non-negligible in financial/trading contexts.

**Mitigation strategies:**
1. **Allowlist only**: only inject the chip for `$ETH`, `$SOL`, `$STRK` — do not expand to
   arbitrary cashtags. This limits surface area.
2. **Context heuristic**: check if the containing tweet text or account mentions crypto
   keywords (NEAR, DeFi, L2, Starknet, etc.) to disambiguate `$STRK`.
3. **User-controllable**: let users disable per-ticker injection in extension settings.
4. **Default off for `$STRK`**: ship `$ETH` and `$SOL` injection first; add `$STRK` in
   a follow-up after implementing the context heuristic.

### 4. Detection loss scenarios

| Scenario | Risk | Mitigation |
|----------|------|-----------|
| React scroll virtualization re-uses nodes | Medium | Re-scan on every mutation (not just addedNodes) |
| X ships DOM attribute rename | Low | `data-testid` is historically stable; monitor in CI |
| Tweet loaded in a modal/dialog | Medium | Observer is on `document.body` (subtree: true) — covers modals |
| Quoted tweets inside tweets | Low | `querySelectorAll` finds nested elements |
| Notifications / DM panes | Low | Same observer covers all panes |
| Rapid scroll (100+ tweets/sec) | Low | Observer batches; querySelectorAll is O(n) but fast |

### 5. Existing art

The `x-feed-filter` extension (TypeScript, MutationObserver, keyword matching) demonstrates
the pattern works reliably for keyword detection on X. The `TradingWizard Anti-FOMO`
extension injects `[Plan]` buttons next to `$TICKER` cashtags, confirming the
`data-testid="cashtag"` selector is actively used in production extensions.

## Decision

**Go — with `$STRK` deferred.**

Detection via `a[data-testid="cashtag"]` is reliable for `$ETH` and `$SOL`. Ship
those two in P1. Defer `$STRK` to P1.1 with a context-heuristic disambiguation layer
to handle the Strike Inc. collision.

MutationObserver with `document.body` subtree scanning is the correct pattern; React
re-rendering is manageable with a full re-scan on each mutation callback.

## Consequences

- Content script uses `MutationObserver({ childList: true, subtree: true })` on `document.body`.
- Selector: `a[data-testid="cashtag"]` — inject chip as a sibling element.
- Initial ship: `$ETH` and `$SOL` only.
- `$STRK` gated on context-heuristic disambiguation (P1.1).
- Add a CI test that loads a fixture HTML snapshot of an X tweet page and confirms the
  selector finds the expected cashtag elements (regression guard against attribute renames).
- Monitor `data-testid="cashtag"` stability in extension telemetry; alert if detection rate
  drops below 95% of expected.

## Open items

1. Build CI fixture: capture live HTML of an X tweet with `$ETH` and `$SOL` cashtags;
   add snapshot test to the extension package.
2. Design the context-heuristic for `$STRK` disambiguation (tweet text analysis or
   account-type signal).
3. Evaluate whether X's MV3 CSP restrictions affect the ability to inject DOM elements
   next to cashtag anchors.
4. Test the observer pattern against X's "For You" feed scroll behavior at high velocity.
