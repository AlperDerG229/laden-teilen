// Opt-in (PW_DEVNET=1): the real devnet path in the browser, read-only. No transaction is sent and
// no faucet is used: the kiosk creates a session key and polls devnet, the guest page reads the
// demo wallet's balances from devnet, the dashboard reads an owner's history.
import { expect, test } from '@playwright/test';

test.skip(!process.env.PW_DEVNET, 'set PW_DEVNET=1 to run against the public devnet RPC (read-only)');

const DEMO_OWNER = 'gnjANn6HJYbphXyT8fUkG4AUUNueykpzJ3VuWf1EMRD';

test('devnet (read-only): kiosk key + QR, devnet balances in the funds panel, dashboard, no page errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('./#/demo');
  await expect(page.getByTestId('mock-banner')).toHaveCount(0);
  const kiosk = page.getByTestId('kiosk');
  await expect(kiosk.getByTestId('kiosk-state')).toHaveAttribute('data-state', 'WAITING_FOR_GUEST', { timeout: 30_000 });
  const url = await kiosk.getByTestId('kiosk-qr').getAttribute('data-url');
  expect(url).not.toContain('mock=1');
  expect(url).toContain('#/charge?k=');

  const phone = page.getByTestId('phone');
  await phone.getByTestId('demo-wallet').click();
  // A fresh demo wallet has nothing on devnet: the funds panel opens with live devnet balances.
  await expect(page.getByTestId('funds-panel')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('funds-sol')).toHaveText('0', { timeout: 30_000 });
  await expect(page.getByTestId('funds-token')).toHaveText('0.00');
  await expect(page.getByTestId('funds-panel')).toContainText('faucet.solana.com');
  await expect(page.getByTestId('funds-panel')).toContainText('faucet.circle.com');
  await page.getByTestId('funds-panel').getByRole('button', { name: 'Done' }).click();
  await expect(phone.getByTestId('start-btn')).toBeDisabled();

  // Let the kiosk poll devnet for a while (getSignaturesForAddress every 2 s).
  await page.waitForTimeout(8_000);
  await expect(kiosk.getByTestId('kiosk-state')).toHaveAttribute('data-state', 'WAITING_FOR_GUEST');

  await page.goto(`./#/owner/dashboard?o=${DEMO_OWNER}`);
  await expect(page.getByTestId('dash-total')).toBeVisible();
  await expect(page.getByTestId('dash-empty').or(page.getByTestId('dash-session-row').first())).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});
