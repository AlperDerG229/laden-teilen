import { describe, expect, it } from 'vitest';
import { guestUrl, phantomBrowseUrl, terminalQr } from './qr.ts';

const params = {
  session: 'H4jpTwRQWd6DJfPQgjcWVahJCjVDGv5vUJv1RP1iPW4v',
  owner: 'BLHyh896CjGYFpKJqX7AHaX8r1tVCYv7gHXykikNPGZR',
  price: '0.39',
  name: 'Garage (evcc)',
  cap: '5',
};

describe('guest link', () => {
  it('uses the kiosk URL format of spec 6.2 (hash route, k/o/p/n/cap)', () => {
    const url = guestUrl(params, 'https://alperderg229.github.io/laden-teilen/');
    expect(url).toBe(
      'https://alperderg229.github.io/laden-teilen/#/charge?k=H4jpTwRQWd6DJfPQgjcWVahJCjVDGv5vUJv1RP1iPW4v' +
        '&o=BLHyh896CjGYFpKJqX7AHaX8r1tVCYv7gHXykikNPGZR&p=0.39&n=Garage+%28evcc%29&cap=5',
    );
    const query = new URLSearchParams(url.split('#/charge?')[1]);
    expect(Object.fromEntries(query)).toEqual({ k: params.session, o: params.owner, p: '0.39', n: 'Garage (evcc)', cap: '5' });
  });

  it('wraps the link in a Phantom browse deeplink and draws a terminal QR', async () => {
    const url = guestUrl(params, 'https://alperderg229.github.io/laden-teilen/');
    expect(phantomBrowseUrl(url, 'https://alperderg229.github.io/laden-teilen/')).toBe(
      `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=https%3A%2F%2Falperderg229.github.io`,
    );
    const qr = await terminalQr(url);
    expect(qr.split('\n').length).toBeGreaterThan(20);
    expect(qr).toContain('▄');
  });
});
