/**
 * Playwright E2E tests for Floors X adapter chip injection.
 *
 * Loads the built extension and fixture pages, then asserts chip
 * injection behaviour.
 *
 * Note: Extension must be built before running E2E:
 *   pnpm build && pnpm e2e
 */

import { test, expect, chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const extensionPath = path.resolve(__dirname, '../.output/chrome-mv3');
const fixturesDir = path.resolve(__dirname, '../../../fixtures/x');

test.describe('X adapter chip injection', () => {
  test('chip appears on ETH cashtag in post fixture', async () => {
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });

    const page = await context.newPage();
    await page.goto(`file://${fixturesDir}/post-with-eth.html`);
    // Give content script time to inject
    await page.waitForTimeout(1500);

    const chip = page.locator('floors-chip').first();
    await expect(chip).toBeAttached();

    await context.close();
  });

  test('chip appears on SOL cashtag in post fixture', async () => {
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });

    const page = await context.newPage();
    await page.goto(`file://${fixturesDir}/post-with-sol.html`);
    await page.waitForTimeout(1500);

    const chip = page.locator('floors-chip').first();
    await expect(chip).toBeAttached();

    await context.close();
  });

  test('no chip on page without cashtag', async () => {
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });

    const page = await context.newPage();
    await page.goto(`file://${fixturesDir}/post-no-cashtag.html`);
    await page.waitForTimeout(1500);

    const chips = page.locator('floors-chip');
    await expect(chips).toHaveCount(0);

    await context.close();
  });

  test('no chip injected for STRK cashtag (deferred per ADR-0006)', async () => {
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });

    const page = await context.newPage();

    // Create a minimal inline page with a STRK cashtag
    await page.setContent(`
      <html><body>
        <a data-testid="cashtag" href="/search?q=%24STRK&src=cashtag_click">$STRK</a>
      </body></html>
    `);
    await page.waitForTimeout(1500);

    const chips = page.locator('floors-chip');
    await expect(chips).toHaveCount(0);

    await context.close();
  });

  test('chip appears in timeline with multiple cashtags', async () => {
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });

    const page = await context.newPage();
    await page.goto(`file://${fixturesDir}/timeline-light.html`);
    await page.waitForTimeout(1500);

    // At least one chip from the ETH/SOL cashtags in the fixture
    const chips = page.locator('floors-chip');
    const count = await chips.count();
    expect(count).toBeGreaterThan(0);

    await context.close();
  });

  test('no duplicate chips on same cashtag element', async () => {
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });

    const page = await context.newPage();
    await page.goto(`file://${fixturesDir}/post-with-eth.html`);
    await page.waitForTimeout(1000);

    // Count chips before
    const countBefore = await page.locator('floors-chip').count();

    // Force a re-observe cycle (simulate X partial re-render)
    await page.evaluate(() => {
      const anchor = document.querySelector('a[data-testid="cashtag"]');
      if (anchor?.parentElement) {
        const parent = anchor.parentElement;
        const clone = anchor.cloneNode(true);
        parent.appendChild(clone);
        // Remove cloned to clean up — original was never re-added
        parent.removeChild(clone);
      }
    });

    await page.waitForTimeout(500);
    const countAfter = await page.locator('floors-chip').count();

    // Should not have grown by more than the one new anchor we briefly added
    expect(countAfter).toBeLessThanOrEqual(countBefore + 1);

    await context.close();
  });
});
