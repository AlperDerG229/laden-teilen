// Full charging sessions in MOCK chain mode. The kiosk and the phone are separate pages that
// share nothing but the (MOCK) chain, like two devices on devnet.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { LEDGER_KEY, MOCK, OWNER, closeFunds, fundDemoWallet, horizontalOverflow, screen, seqs } from './helpers.ts';

test('owner setup -> kiosk QR -> guest starts with the demo wallet -> 6+ payments on both sides -> stop -> receipt -> dashboard', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const kiosk = await context.newPage();

  // Owner setup: payout wallet + price, then open the wallbox display.
  await kiosk.goto(`./${MOCK}#/owner`);
  await expect(kiosk.getByTestId('mock-banner')).toBeVisible();
  await kiosk.getByTestId('owner-address').fill(OWNER);
  await kiosk.getByTestId('owner-price').fill('0.39');
  await kiosk.getByTestId('owner-name').fill('Garage Sonnenweg 12');
  await screen(kiosk, 'desktop-owner-setup');
  await kiosk.getByTestId('open-kiosk').click();
  await expect(kiosk).toHaveURL(/#\/wallbox\?o=/);

  const qr = kiosk.getByTestId('kiosk-qr');
  await expect(qr).toBeVisible();
  await expect(kiosk.getByTestId('kiosk-state')).toHaveAttribute('data-state', 'WAITING_FOR_GUEST');
  const guestUrl = (await qr.getAttribute('data-url'))!;
  expect(guestUrl).toMatch(/\?mock=1#\/charge\?k=\w+&o=9THy13GeCvCqrxzFiBUpps4Z1e45Uig8NDLDTYT8mx3x&p=0\.39/);
  await screen(kiosk, 'desktop-kiosk-waiting');

  // The phone "scans" the QR: a second page with a phone viewport.
  const phone = await context.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(guestUrl);
  await expect(phone.getByRole('heading', { name: 'Garage Sonnenweg 12' })).toBeVisible();
  await fundDemoWallet(phone, phone);
  await screen(phone, 'mobile-funds-panel');
  await closeFunds(phone);
  await expect(phone.getByTestId('wallet-card')).toContainText('Demo wallet (mock)');
  await phone.getByTestId('cap-select').selectOption('5');
  await expect(phone.getByTestId('start-btn')).toBeEnabled();
  expect(await horizontalOverflow(phone)).toBeLessThanOrEqual(0);
  await screen(phone, 'mobile-guest-ready', { fullPage: true });

  await phone.getByTestId('start-btn').click();
  await expect(kiosk.getByTestId('kiosk-state')).toHaveText('CHARGING');
  await expect(phone.getByTestId('allowance')).toBeVisible();

  // Pull before deliver: the meter never shows more energy than was paid for.
  for (let i = 0; i < 6; i++) {
    const delivered = Number(await kiosk.getByTestId('kiosk-kwh').getAttribute('data-value'));
    const paid = await kiosk.getByTestId('payment-row').count();
    expect(Math.round(delivered * 10)).toBeLessThanOrEqual(paid);
    await kiosk.waitForTimeout(400);
  }
  await expect.poll(() => kiosk.getByTestId('payment-row').count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(6);
  await expect.poll(() => phone.getByTestId('payment-row').count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(6);
  await expect(phone.getByTestId('allowance')).not.toHaveAttribute('data-value', '5.00');
  expect(await horizontalOverflow(phone)).toBeLessThanOrEqual(0);
  await screen(kiosk, 'desktop-kiosk-charging');
  await screen(phone, 'mobile-guest-live');

  // Stop & revoke -> the wallbox ends the session and refunds -> receipt.
  await phone.getByTestId('stop-btn').click();
  await expect(phone.getByTestId('receipt')).toBeVisible({ timeout: 60_000 });
  await expect(phone.getByTestId('receipt-refund')).toContainText('Fee deposit refunded');
  await expect(phone.getByTestId('receipt-allowance')).toContainText('Allowance revoked');
  const kwh = (await phone.getByTestId('receipt-kwh').getAttribute('data-value'))!;
  const eur = (await phone.getByTestId('receipt-eur').getAttribute('data-value'))!;
  expect(Number(kwh)).toBeGreaterThanOrEqual(0.6);
  expect(Number(eur)).toBeCloseTo(Number(kwh) * 0.39, 6);
  expect(await horizontalOverflow(phone)).toBeLessThanOrEqual(0);
  await screen(phone, 'mobile-guest-receipt', { fullPage: true });

  // The kiosk moved on: a new key and QR, and a summary of the last session.
  await expect(kiosk.getByTestId('kiosk-last')).toContainText('Guest stopped and revoked');
  await expect(kiosk.getByTestId('kiosk-qr')).not.toHaveAttribute('data-url', guestUrl);
  expect(await seqs(kiosk.getByTestId('payment-row'))).toEqual([...Array(Math.round(Number(kwh) * 10)).keys()].map((i) => i + 1));

  // Owner dashboard from chain data only: wipe every app key but the MOCK ledger (= the chain).
  const dash = await context.newPage();
  await dash.goto(`./${MOCK}#/`);
  await dash.evaluate((ledger) => {
    for (const k of Object.keys(localStorage)) if (k !== ledger) localStorage.removeItem(k);
    sessionStorage.clear();
  }, LEDGER_KEY);
  await dash.goto(`./${MOCK}#/owner/dashboard?o=${OWNER}`);
  const row = dash.getByTestId('dash-session-row');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-kwh', kwh);
  await expect(row).toHaveAttribute('data-eur', eur);
  await expect(dash.getByTestId('dash-total')).toHaveAttribute('data-sessions', '1');
  await expect(dash.getByTestId('dash-total')).toHaveAttribute('data-eur', eur);
  await expect(row).toContainText('✓ sample'); // first payment verified via its token balances
  await row.getByTestId('verify-btn').click();
  await expect(row.getByTestId('verify-result')).toHaveText(new RegExp(`✓ ${Math.round(Number(kwh) * 10)}/`));
  await screen(dash, 'desktop-dashboard', { fullPage: true });

  const [download] = await Promise.all([dash.waitForEvent('download'), dash.getByTestId('export-csv').click()]);
  const csv = readFileSync((await download.path())!, 'utf8');
  expect(csv.split('\r\n')[0]).toBe('session_id,start_utc,end_utc,duration_s,energy_kwh,amount_eurc,payments,guest_wallet,first_tx,last_tx,cluster,token_mint');
  expect(csv.split('\r\n')[1]).toContain(`,${kwh},${eur},`);
  await context.close();
});

test('split-screen demo: captions, 6+ payments on both halves, stop, receipt, scan the new QR', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  // Flags may sit inside the hash query, as the demo recorder uses them.
  await page.goto('./#/demo?mock=1&captions=1&speed=600');
  await expect(page.getByTestId('mock-banner')).toBeVisible();
  await page.evaluate(() => window.__caption?.('The guest approves ONE transaction.'));
  await expect(page.getByTestId('caption')).toHaveText('The guest approves ONE transaction.');

  const kiosk = page.getByTestId('kiosk');
  const phone = page.getByTestId('phone');
  await expect(kiosk.getByTestId('kiosk-qr')).toBeVisible();
  await screen(page, 'desktop-demo-waiting');
  await fundDemoWallet(phone, page);
  await closeFunds(page);
  await phone.getByTestId('cap-select').selectOption('5');
  await phone.getByTestId('start-btn').click();
  await expect(kiosk.getByTestId('kiosk-state')).toHaveText('CHARGING');
  await expect.poll(() => kiosk.getByTestId('payment-row').count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(6);
  await expect.poll(() => phone.getByTestId('payment-row').count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(6);
  await page.evaluate(() => window.__caption?.('Every 0.1 kWh the charger pulls 0.039 EURC, before delivering the energy.'));
  await screen(page, 'desktop-demo-charging');

  await phone.getByTestId('stop-btn').click();
  await expect(phone.getByTestId('receipt')).toBeVisible({ timeout: 60_000 });
  await expect(phone.getByTestId('receipt-refund')).toContainText('refunded');
  await page.evaluate(() => window.__caption?.(''));
  await screen(page, 'desktop-demo-receipt');

  // The phone holds its receipt while the display already shows the next session's QR.
  const next = await kiosk.getByTestId('kiosk-qr').getAttribute('data-url');
  await phone.getByTestId('scan-new').click();
  await expect(phone.getByTestId('start-btn')).toBeVisible();
  await expect(page.getByTestId('phone').locator('.phone__url')).toHaveAttribute('title', next!);
});

test('kiosk reload mid-session resumes without pulling a step twice; kiosk Stop leaves a revocable allowance', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const kiosk = await context.newPage();
  await kiosk.goto(`./${MOCK}#/wallbox?o=${OWNER}&p=0.45&n=Reload+test&cap=2`);
  const guestUrl = (await kiosk.getByTestId('kiosk-qr').getAttribute('data-url'))!;
  const phone = await context.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(guestUrl);
  await expect(phone.getByTestId('cap-select')).toHaveValue('2');
  await fundDemoWallet(phone, phone);
  await closeFunds(phone);
  await phone.getByTestId('start-btn').click();
  await expect.poll(() => kiosk.getByTestId('payment-row').count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(2);

  await kiosk.reload();
  await expect(kiosk.getByTestId('kiosk-state')).toHaveText('CHARGING');
  await expect.poll(() => kiosk.getByTestId('payment-row').count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(5);
  await kiosk.getByTestId('kiosk-stop').click();

  // Stopped at the wallbox: the guest's receipt shows the unused allowance and lets them revoke it.
  await expect(phone.getByTestId('receipt')).toBeVisible({ timeout: 60_000 });
  await expect(phone.getByTestId('receipt')).toContainText('Stopped at the wallbox');
  await expect(phone.getByTestId('receipt-allowance')).toContainText('Allowance still active');
  await phone.getByTestId('revoke-btn').click();
  await expect(phone.getByTestId('receipt-allowance')).toContainText('Allowance revoked');

  // Every step was pulled exactly once, before and after the reload: the kiosk's feed of the
  // session (rebuilt from the chain after the reload) has no duplicate or missing sequence number.
  const kioskSeqs = await seqs(kiosk.getByTestId('payment-row'));
  expect(kioskSeqs.length).toBeGreaterThanOrEqual(5);
  expect(kioskSeqs).toEqual([...Array(kioskSeqs.length).keys()].map((i) => i + 1));
  await context.close();
});
