import type { SupportedTicker } from './registry.js';

const CHIP_STYLES = `
  :host {
    display: inline-flex;
    align-items: center;
    vertical-align: middle;
    margin-left: 4px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    max-height: 28px;
    background-color: #EF7B28;
    border: 2px solid #111111;
    border-radius: 13px;
    box-shadow: 0px 2.5px 0px #111111;
    cursor: pointer;
    font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 12px;
    font-weight: 800;
    color: #111111;
    line-height: 1;
    text-decoration: none;
    white-space: nowrap;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
    transition: transform 0.1s ease, box-shadow 0.1s ease;
  }
  .chip:active {
    transform: translateY(2px);
    box-shadow: 0px 0.5px 0px #111111;
  }
  .chip:hover {
    background-color: #ED7725;
  }
  .icon {
    font-size: 11px;
    line-height: 1;
  }
`;

/**
 * FloorsBuyChip — closed shadow-root custom element.
 * Renders a neo-brutalist pill button for buying a supported crypto from an X post.
 * Only text content is used; no innerHTML with untrusted data.
 */
export class FloorsBuyChip extends HTMLElement {
  private readonly ticker: SupportedTicker;
  private readonly postId: string | undefined;

  constructor(ticker: SupportedTicker, postId?: string) {
    super();
    this.ticker = ticker;
    this.postId = postId;

    const shadow = this.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = CHIP_STYLES;

    const button = document.createElement('button');
    button.className = 'chip';
    button.setAttribute('aria-label', `Buy ${ticker} via Floors`);
    button.setAttribute('type', 'button');

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = '🟠';

    const label = document.createElement('span');
    // Safe: ticker is validated against a fixed allowlist before chip creation
    label.textContent = `Buy $${ticker}`;

    button.appendChild(icon);
    button.appendChild(label);

    button.addEventListener('click', this.handleClick);

    shadow.appendChild(style);
    shadow.appendChild(button);
  }

  private handleClick = (e: Event): void => {
    e.stopPropagation();
    e.preventDefault();

    // Dispatch a window message that the isolated-world bridge script will forward
    // to chrome.runtime. We use window.postMessage because MAIN world content
    // scripts cannot call chrome.runtime directly.
    window.postMessage({
      __floors__: true,
      type: 'OPEN_SHEET',
      ticker: this.ticker,
      ...(this.postId !== undefined ? { postId: this.postId } : {}),
    }, '*');
  };
}

export function defineFloorsBuyChip(): void {
  if (!customElements.get('floors-chip')) {
    customElements.define('floors-chip', FloorsBuyChip);
  }
}
