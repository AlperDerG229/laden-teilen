// Layout and safety checks: no horizontal scroll on a 390x844 phone, MOCK is never silent.
import { expect, test } from '@playwright/test';
import { MOCK, OWNER, horizontalOverflow, screen } from './helpers.ts';

const SESSION = 'C3rJM2UJg8JtWzeD5ZXY9XB48Yms7h2FbXnHCqdC7LYi';

const ROUTES: [string, string][] = [
  ['landing', '#/'],
  ['owner', '#/owner'],
  ['how', '#/how'],
  ['dashboard', `#/owner/dashboard?o=${OWNER}`],
  ['charge', `#/charge?k=${SESSION}&o=${OWNER}&p=0.39&n=Garage&cap=5`],
  ['wallbox', `#/wallbox?o=${OWNER}&p=0.39&n=Garage&cap=5`],
  ['demo', '#/demo'],
];

test.describe('phone 390x844', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  for (const [name, route] of ROUTES) {
    test(`${name}: no horizontal overflow`, async ({ page }) => {
      await page.goto(`./${MOCK}${route}`);
      await expect(page.locator('main, .demo').first()).toBeVisible();
      await page.waitForTimeout(600);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      if (['landing', 'how', 'dashboard', 'charge'].includes(name)) await screen(page, `mobile-${name}`, { fullPage: true });
    });
  }
});

test.describe('desktop pages', () => {
  for (const [name, route] of ROUTES.filter(([n]) => ['landing', 'how'].includes(n))) {
    test(`${name}: renders without horizontal overflow`, async ({ page }) => {
      await page.goto(`./${MOCK}${route}`);
      await expect(page.locator('main').first()).toBeVisible();
      await page.waitForTimeout(600);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      await screen(page, `desktop-${name}`, { fullPage: true });
    });
  }
});

test('landing CTAs lead to the demo, the owner setup and how it works', async ({ page }) => {
  await page.goto(`./${MOCK}#/`);
  await page.getByTestId('cta-demo').click();
  await expect(page.getByTestId('kiosk')).toBeVisible();
  await page.goto(`./${MOCK}#/`);
  await page.getByTestId('cta-owner').click();
  await expect(page.getByTestId('owner-address')).toBeVisible();
  await page.goto(`./${MOCK}#/`);
  await page.getByTestId('cta-how').click();
  await expect(page.getByTestId('eichrecht')).toContainText('Devnet prototype with a simulated charger. No real energy is sold and the tokens have no value.');
});

test('MOCK mode is never silent: devnet by default, banner and [MOCK] title with ?mock=1', async ({ page }) => {
  await page.goto('./#/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByTestId('mock-banner')).toHaveCount(0);
  await expect(page.locator('.site-header .net-tag')).toHaveText('Devnet');
  expect(await page.title()).not.toContain('MOCK');

  await page.goto('./?mock=1#/');
  await expect(page.getByTestId('mock-banner')).toBeVisible();
  await expect(page.locator('.site-header .net-tag')).toHaveText('Mock');
  expect(await page.title()).toContain('[MOCK]');
  // MOCK and devnet never share keys or wallets.
  await page.goto('./?mock=1#/demo');
  await page.getByTestId('phone').getByTestId('demo-wallet').click();
  await expect(page.getByTestId('funds-panel')).toBeVisible();
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys).toContain('lt:mock:demo-wallet');
  expect(keys.filter((k) => k.startsWith('lt:devnet:'))).toEqual([]);
});

test('guest page without a session link explains what to scan', async ({ page }) => {
  await page.goto(`./${MOCK}#/charge`);
  await expect(page.getByRole('heading', { name: 'Scan the QR code on the wallbox display' })).toBeVisible();
});
