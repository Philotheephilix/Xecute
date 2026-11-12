import { test, expect } from '@playwright/test';

test('full onboarding flow: welcome → passkey → account ready', async ({ page }) => {
  await page.goto('http://localhost:5173');

  // Welcome screen
  await expect(page.locator('text=Floors').first()).toBeVisible();
  await expect(page.locator('text=Get Started')).toBeVisible();

  // Mock the API call before clicking
  await page.route('**/v1/accounts', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ account_id: '0sabc123', created: true }),
    }),
  );

  // Override navigator.credentials before navigating to the passkey screen
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'credentials', {
      writable: true,
      value: {
        create: async () => ({
          id: 'mock-credential-id',
          type: 'public-key',
          rawId: new Uint8Array(16).fill(1).buffer,
          response: {
            clientDataJSON: new Uint8Array(32).fill(0).buffer,
            attestationObject: new Uint8Array(64).fill(0).buffer,
            getPublicKey: () => new Uint8Array(65).fill(4).buffer,
            getPublicKeyAlgorithm: () => -7,
          },
          getClientExtensionResults: () => ({}),
          authenticatorAttachment: null,
        }),
        get: async () => null,
      },
    });
  });

  await page.click('text=Get Started');

  // Create Passkey screen
  await expect(page.locator('text=Secure Your Account')).toBeVisible();
  await page.click('text=Create Passkey');

  // Creating Account screen (brief)
  await expect(page.locator('text=Setting up your account')).toBeVisible({ timeout: 5000 });

  // Account ready screen
  await expect(page.locator('text=Account Ready!')).toBeVisible({ timeout: 10000 });
});

test('welcome screen shows tagline', async ({ page }) => {
  await page.goto('http://localhost:5173');
  await expect(page.locator('text=Buy crypto on X')).toBeVisible();
  await expect(page.locator('text=Protected')).toBeVisible();
});

test('back navigation from create passkey returns to welcome', async ({ page }) => {
  await page.goto('http://localhost:5173');
  await page.click('text=Get Started');
  await expect(page.locator('text=Secure Your Account')).toBeVisible();
  await page.click('[aria-label="Go back"]');
  await expect(page.locator('text=Get Started')).toBeVisible({ timeout: 5000 });
});
