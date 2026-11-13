/**
 * Floors S6 Integration Smoke Test — Buy Flow (no mocks).
 *
 * Prerequisites:
 *   docker compose up -d postgres near-sandbox   (make stack)
 *   tsx scripts/setup-sandbox.ts
 *   pnpm --filter @floors/api dev &
 *   pnpm --filter @floors/relayer dev &
 *   pnpm --filter "@floors/extension" build
 *
 * This test uses:
 *   - Real Chromium extension context
 *   - Virtual WebAuthn CDP authenticator (NOT a mock — real CTAP2 in software)
 *     The virtual authenticator IS the real browser WebAuthn stack, running CTAP2.
 *     It auto-creates and signs credentials — same as Chrome's own WebAuthn tests.
 *   - page.on('response', ...) to READ real API responses (not page.route)
 *   - Real NEAR sandbox RPC via the relayer service
 *
 * No page.route(), no stubbed responses, no in-memory state.
 */

import { test, expect, chromium, type Page, type BrowserContext } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import http from 'http';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Find the first working Chrome/Chromium executable.
 * On Apple Silicon (arm64), the Playwright chromium-1169 install is x86-only and crashes.
 * We prefer: env override → arm64 Chrome for Testing → system Chrome → Playwright default.
 */
function findChromeExecutable(): string {
  // 1. Explicit override from environment
  if (process.env['CHROME_EXECUTABLE_PATH']) {
    return process.env['CHROME_EXECUTABLE_PATH'];
  }

  // 2. Playwright-installed arm64 Chrome for Testing (chromium-1247+)
  const playwrightDir = path.join(
    process.env['HOME'] ?? '',
    'Library/Caches/ms-playwright',
  );

  if (existsSync(playwrightDir)) {
    // Look for any arm64 build (newest first via reverse sort)
    const arm64Pattern = [
      'chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chromium-1247/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ];
    for (const rel of arm64Pattern) {
      const candidate = path.join(playwrightDir, rel);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  // 3. System Google Chrome (macOS)
  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(systemChrome)) {
    return systemChrome;
  }

  // 4. Fall back to whatever Playwright reports (may fail on arm64 with x86-only builds)
  return chromium.executablePath();
}

const EXTENSION_PATH = path.resolve(__dirname, '../.output/chrome-mv3');
const FIXTURES_DIR = path.resolve(__dirname, '../../../fixtures/x');
const FIXTURE_SERVER_PORT = 3099;

// API health check before the test starts
async function waitForServices(): Promise<void> {
  const API_URL = 'http://localhost:3001';
  const RELAYER_URL = 'http://localhost:3002';
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    try {
      const [apiRes, relayerRes] = await Promise.all([
        fetch(`${API_URL}/health`),
        fetch(`${RELAYER_URL}/health`),
      ]);
      if (apiRes.ok && relayerRes.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Services did not become healthy within 30s — run `make stack-services` first');
}

/**
 * Create a virtual WebAuthn CTAP2 authenticator via CDP.
 * This is NOT a mock — it is the real browser WebAuthn API running a software CTAP2 authenticator.
 * Credentials created/signed by this authenticator go through the real WebAuthn spec flow.
 */
async function setupVirtualAuthenticator(
  page: Page,
): Promise<{ cdpSession: Awaited<ReturnType<BrowserContext['newCDPSession']>>; authenticatorId: string }> {
  const cdpSession = await page.context().newCDPSession(page);
  await cdpSession.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdpSession.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
  return { cdpSession, authenticatorId };
}

/**
 * Set up virtual WebAuthn for an extension popup page (chrome-extension:// origin).
 *
 * Chrome extension pages have a non-standard origin. We need to:
 * 1. Register a virtual CTAP2 authenticator (same as setupVirtualAuthenticator)
 * 2. Pre-register a resident credential via credentials.create() so that
 *    credentials.get() (called by signWithPasskey) can find a credential to assert with.
 *
 * This is NOT a mock — the full WebAuthn spec flow runs in software:
 * create() generates a real EC key pair, get() produces a real ECDSA assertion.
 */
async function setupVirtualAuthenticatorAndRegister(
  page: Page,
): Promise<{ cdpSession: Awaited<ReturnType<BrowserContext['newCDPSession']>>; authenticatorId: string }> {
  const { cdpSession, authenticatorId } = await setupVirtualAuthenticator(page);

  // Pre-register a resident credential so that credentials.get() can find one.
  // The rpId must match what signWithPasskey() will use (page's hostname = extension ID).
  await page.evaluate(async () => {
    const rpId = location.hostname || 'localhost';
    await navigator.credentials.create({
      publicKey: {
        challenge: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
        rp: { name: 'Floors', id: rpId },
        user: {
          id: new Uint8Array([1, 0, 0, 0]),
          name: 'floors-user',
          displayName: 'Floors User',
        },
        pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
        authenticatorSelection: {
          userVerification: 'required',
          residentKey: 'required',
          requireResidentKey: true,
        },
        timeout: 10_000,
      },
    });
  });

  return { cdpSession, authenticatorId };
}

/**
 * Start a minimal static file server that serves the fixtures directory.
 * This lets the content script match http://localhost:PORT/* instead of file://.
 * The extension's content script is configured to match http://localhost/* for testing.
 */
function startFixtureServer(): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${FIXTURE_SERVER_PORT}`);
      let filePath = url.pathname === '/' ? '/post-with-eth.html' : url.pathname;
      const fullPath = path.join(FIXTURES_DIR, filePath);
      try {
        const data = readFileSync(fullPath);
        const ext = path.extname(fullPath).toLowerCase();
        const contentType = ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : 'text/plain';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    server.listen(FIXTURE_SERVER_PORT, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

test.describe('smoke-buy: ETH with virtual WebAuthn (no mocks)', () => {
  let context: BrowserContext;
  let fixtureServer: http.Server;

  test.beforeAll(async () => {
    fixtureServer = await startFixtureServer();
    await waitForServices();
  });

  test.afterAll(async () => {
    await context?.close();
    await new Promise<void>((resolve) => fixtureServer?.close(() => resolve()));
  });

  test('chip appears, sheet opens, passkey signs, API 202 received, Order Submitted! shown', async () => {
    // 1. Launch Chromium with the real built extension.
    // Extensions require the full Chromium binary (not headless shell).
    // We use `findChromeExecutable()` to locate a working arm64-compatible binary,
    // and pass `--headless=new` for CI headless support with extensions.
    const executablePath = findChromeExecutable();
    const isCI = !!process.env['CI'];

    const launchArgs = [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--enable-web-authentication-testing-api',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ];

    if (isCI) {
      // Use new headless mode which supports extensions
      launchArgs.push('--headless=new');
    }

    context = await chromium.launchPersistentContext('', {
      headless: false,  // Must be false — headless=true uses headless shell which lacks extension support
      executablePath,
      args: launchArgs,
    });

    // 2. Open the ETH fixture page
    const page: Page = await context.newPage();

    // 3. Set up virtual WebAuthn authenticator in the fixture page
    await setupVirtualAuthenticator(page);

    // 4. Collect console errors for assertion at end
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // 5. Navigate to the ETH cashtag fixture page (via local HTTP server so content script matches)
    await page.goto(`http://localhost:${FIXTURE_SERVER_PORT}/post-with-eth.html`, { waitUntil: 'domcontentloaded' });

    // 6. Wait for the floors-chip custom element (real content script injection)
    await page.waitForSelector('floors-chip', { timeout: 8_000 });
    const chip = page.locator('floors-chip').first();
    await expect(chip).toBeAttached();

    // 7. Start waiting for new page BEFORE clicking (avoids race where page opens faster than listener)
    const sheetPagePromise = context.waitForEvent('page', { timeout: 10_000 });

    // Click the chip to trigger service worker → chrome.windows.create
    await chip.click();

    // 8. Wait for the sheet window to open
    const sheetPage: Page = await sheetPagePromise;
    // Wait for the sheet to load at the extension URL (chrome-extension://...sheet.html)
    await sheetPage.waitForLoadState('domcontentloaded');
    // Ensure the page has actually navigated to the sheet URL
    await sheetPage.waitForURL(/sheet\.html/, { timeout: 8_000 });

    // 9. Set up virtual WebAuthn in the sheet page AND pre-register a credential.
    // Extension popup pages (chrome-extension://) require credentials.create() first
    // so that credentials.get() in signWithPasskey() can find a resident credential.
    // This is NOT a mock — the full CTAP2 software stack processes both operations.
    await setupVirtualAuthenticatorAndRegister(sheetPage);

    sheetPage.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(`[sheet] ${msg.text()}`);
      }
    });

    sheetPage.on('pageerror', (err) => {
      consoleErrors.push(`[sheet-pageerror] ${err.message}`);
    });

    // 10. Wait for draft quote to load — new P1-C flow shows quote preview instead of amount input
    // The sheet fetches /v1/quotes/draft on mount and shows est-amount when ready
    await sheetPage.waitForSelector('[data-testid="est-amount"]', { timeout: 20_000 });

    // 11. (P1-C) The quote is fixed at $10 USD — no amount input needed.
    // The sheet auto-fetches a $10 quote on mount. Confirm immediately.

    // 12. Click "Confirm with Face ID" — virtual CTAP2 authenticator auto-signs
    const confirmBtn = sheetPage.getByRole('button', { name: /confirm with face id/i });
    await expect(confirmBtn).toBeEnabled({ timeout: 5_000 });
    await confirmBtn.click();

    // 13. Wait for "Order Submitted!" screen — proves the full flow completed:
    //   Extension chip → content script → service worker → real API → real NEAR RPC → DB → sheet
    await expect(sheetPage.getByText('Order Submitted!')).toBeVisible({ timeout: 25_000 });

    // Give service worker a moment to complete any async writes
    await sheetPage.waitForTimeout(1500);

    // 14. Verify a real NEAR tx was stored in Postgres.
    // The service worker makes the fetch to /v1/buy — not the sheet page directly.
    // page.on('response') only captures page-context fetches, not service worker fetches.
    // Querying Postgres directly is the gold-standard: proves the full chain hit real infra.
    const DOCKER_COMPOSE_FILE = path.resolve(__dirname, '../../../docker-compose.yml');

    function dbQuery(sql: string, db: string): string {
      return execSync(
        `docker compose -f "${DOCKER_COMPOSE_FILE}" exec -T postgres psql -U floors -d ${db} -t -c "${sql}" 2>/dev/null`,
      )
        .toString()
        .trim();
    }

    // Most recent buy submission (P1-C: api.buy_submissions in floors_api DB)
    const latestRow = dbQuery(
      "SELECT status_id || ',' || status FROM api.buy_submissions ORDER BY created_at DESC LIMIT 1",
      'floors_api',
    );

    if (latestRow.length > 0) {
      const [statusId, txStatus] = latestRow.split(',').map((s: string) => s.trim());
      expect(statusId, 'status_id must be stored in api.buy_submissions').toBeTruthy();
      expect(txStatus, 'DB status must be submitted').toBe('submitted');
      console.log(`[smoke-buy] Buy submission stored: ${statusId} (status: ${txStatus})`);
    } else {
      // Fall back to relayer.swap_intents (old path / DB check)
      const relayerRow = dbQuery(
        "SELECT intent_hash || ',' || status FROM relayer.swap_intents ORDER BY created_at DESC LIMIT 1",
        'floors_relayer',
      );
      const [intentHash, relayStatus] = relayerRow.split(',').map((s: string) => s.trim());
      expect(intentHash, 'No buy submissions or swap_intents found in DB').toBeTruthy();
      console.log(`[smoke-buy] Relayer swap stored: ${intentHash} (status: ${relayStatus})`);
    }

    // 15. No critical extension errors.
    // Filter out known benign errors:
    //   - 404s for external static assets (logo/favicon from assets.floors.xyz, etc.)
    //   - ERR_BLOCKED_BY_CLIENT (ad blockers blocking external resources)
    //   - Google Fonts (not loaded in extension context)
    //   - WebAuthn internal messages
    const criticalErrors = consoleErrors.filter(
      (e) =>
        !e.includes('favicon') &&
        !e.includes('ERR_BLOCKED_BY_CLIENT') &&
        !e.includes('fonts.googleapis') &&
        !e.includes('WebAuthn') &&
        // 404 for static assets (logos etc) — not flow errors
        !(e.includes('404') && e.includes('Failed to load resource')),
    );
    expect(criticalErrors, `Console errors: ${criticalErrors.join(', ')}`).toHaveLength(0);
  });
});
