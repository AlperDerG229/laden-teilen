import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page } from '@playwright/test';

/** A fixed payout wallet for the tests (public key only, nobody needs its secret in MOCK mode). */
export const OWNER = '9THy13GeCvCqrxzFiBUpps4Z1e45Uig8NDLDTYT8mx3x';
/** MOCK chain, fast demo speed (600 kWh/h = one 0.1 kWh step every 0.6 s). */
export const MOCK = '?mock=1&speed=600';
export const LEDGER_KEY = 'lt:mock:ledger:v1';

const SCREENS = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screens');

/** Saves docs/screens/<name>.png when PW_SCREENS=1 (keeps normal runs from touching the repo). */
export async function screen(page: Page, name: string, opts: { fullPage?: boolean } = {}): Promise<void> {
  if (!process.env.PW_SCREENS) return;
  mkdirSync(SCREENS, { recursive: true });
  await page.screenshot({ path: join(SCREENS, `${name}.png`), fullPage: opts.fullPage ?? false, animations: 'disabled' });
}

export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** Demo wallet -> "Get test funds" opens by itself -> MOCK faucet -> close. */
export async function fundDemoWallet(scope: Page | Locator, page: Page): Promise<void> {
  await scope.getByTestId('demo-wallet').click();
  const panel = page.getByTestId('funds-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('funds-sol')).toHaveText('0');
  await page.getByTestId('mock-faucet').click();
  await expect(page.getByTestId('funds-token')).toHaveText('20.00');
  await expect(page.getByTestId('funds-sol')).toHaveText('1');
}

export async function closeFunds(page: Page): Promise<void> {
  await page.getByTestId('funds-panel').getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('funds-panel')).toHaveCount(0);
}

export async function seqs(rows: Locator): Promise<number[]> {
  return (await rows.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-seq'))))).sort((a, b) => a - b);
}
