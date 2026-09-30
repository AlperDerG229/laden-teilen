// Guest link + terminal QR code for the bridge (same URL format as the browser kiosk, spec 6.2).
import QRCode from 'qrcode';
import { APP_URL } from '../src/core/config.ts';

export interface GuestLinkParams {
  /** Session public key (the delegate the guest approves). */
  session: string;
  /** Owner payout wallet. */
  owner: string;
  /** Price in EUR per kWh as a decimal string, e.g. "0.39". */
  price: string;
  /** Wallbox name shown to the guest. */
  name: string;
  /** Suggested spending cap in EUR, e.g. "5". */
  cap: string;
}

/** https://lyvoralper.github.io/laden-teilen/#/charge?k=<session>&o=<owner>&p=<price>&n=<name>&cap=<cap> */
export function guestUrl(p: GuestLinkParams, appUrl: string = APP_URL): string {
  const query = new URLSearchParams({ k: p.session, o: p.owner, p: p.price, n: p.name, cap: p.cap });
  return `${appUrl}#/charge?${query.toString()}`;
}

/** Phantom in-app browser deeplink (https://docs.phantom.com/phantom-deeplinks/other-methods/browse). */
export function phantomBrowseUrl(url: string, appUrl: string = APP_URL): string {
  return `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(new URL(appUrl).origin)}`;
}

/** QR code drawn with Unicode half blocks for a terminal. */
export function terminalQr(text: string): Promise<string> {
  return QRCode.toString(text, { type: 'terminal', small: true, errorCorrectionLevel: 'L' });
}
