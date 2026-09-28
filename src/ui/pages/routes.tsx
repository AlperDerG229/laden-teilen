import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useAppEnv } from '../app-context.tsx';
import { SitePage, Wordmark } from '../components/chrome.tsx';
import { DEMO_OWNER, DEMO_WALLBOX_NAME } from '../demo-config.ts';
import { shortAddr } from '../format.ts';
import { GuestFlow } from '../guest/GuestFlow.tsx';
import { KioskPanel } from '../kiosk/KioskPanel.tsx';
import { parseGuestUrl, readGuestParams, readWallboxParams, wallboxQuery } from '../links.ts';
import { href } from '../router.ts';
import { readJson } from '../storage.ts';
import { OWNER_SETTINGS_KEY, type OwnerSettings } from './OwnerSetup.tsx';

export function Wallbox({ params }: { params: URLSearchParams }) {
  const env = useAppEnv();
  const wallbox = readWallboxParams(params);
  if (!wallbox) {
    const saved = readJson<OwnerSettings>(env.storage, OWNER_SETTINGS_KEY);
    const savedBox = saved ? readWallboxParams(new URLSearchParams({ o: saved.owner, p: saved.price, n: saved.name, cap: saved.cap })) : null;
    return (
      <SitePage className="narrow">
        <div className="plate setup-needed">
          <p className="eyebrow">Wallbox display</p>
          <h1>This display needs a payout wallet</h1>
          <p>Set the payout address and the price first. The display then shows a QR code for each charging session.</p>
          <div className="setup-needed__actions">
            <a className="btn" href={href('/owner')}>
              Set up the wallbox
            </a>
            {savedBox && (
              <a className="btn btn--ghost" href={href('/wallbox', wallboxQuery(savedBox))}>
                Use saved settings ({shortAddr(savedBox.owner)})
              </a>
            )}
          </div>
        </div>
      </SitePage>
    );
  }
  return (
    <main className="wallbox-page">
      <KioskPanel wallbox={wallbox} />
      <p className="wallbox-page__foot">
        Devnet prototype with a simulated charger. No real energy is sold and the tokens have no value. ·{' '}
        <a href={href('/owner/dashboard', { o: wallbox.owner })}>Dashboard</a> · <a href={href('/owner', wallboxQuery(wallbox))}>Settings</a>
      </p>
    </main>
  );
}

export function Charge({ params }: { params: URLSearchParams }) {
  const query = params.toString();
  const guest = useMemo(() => readGuestParams(new URLSearchParams(query)), [query]);
  if (!guest) {
    return (
      <main className="charge-page">
        <div className="guest">
          <div className="guest__bar">
            <Wordmark />
          </div>
          <div className="guest__body">
            <section className="guest__box">
              <p className="eyebrow">Charge</p>
              <h1 className="guest__name">Scan the QR code on the wallbox display</h1>
              <p>This link is incomplete. Every charging session has its own QR code on the display next to the wallbox.</p>
            </section>
            <a className="btn btn--block" href={href('/demo')}>
              Try the demo instead
            </a>
          </div>
        </div>
      </main>
    );
  }
  return (
    <main className="charge-page">
      <GuestFlow key={guest.session} params={guest} />
    </main>
  );
}

function PhoneFrame({ url, children }: { url: string | null; children: ReactNode }) {
  let shown = 'Camera';
  if (url) {
    try {
      const u = new URL(url);
      shown = `${u.host}${u.pathname}`;
    } catch {
      shown = url;
    }
  }
  return (
    <div className="phone" role="group" aria-label="Guest's phone" data-testid="phone">
      <div className="phone__status" aria-hidden="true">
        <span>9:41</span>
        <span className="phone__icons">
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className="phone__url" title={url ?? undefined}>
        <span className="phone__lock" aria-hidden="true" />
        {shown}
      </div>
      <div className="phone__screen">{children}</div>
    </div>
  );
}

export function Demo({ params }: { params: URLSearchParams }) {
  const env = useAppEnv();
  const withDefaults = new URLSearchParams(params);
  if (!withDefaults.get('n')) withDefaults.set('n', DEMO_WALLBOX_NAME);
  const wallbox = readWallboxParams(withDefaults, DEMO_OWNER)!;
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  // The phone "scans" the display: the QR URL is the only thing passed from left to right. It
  // follows the display until the guest starts a session, then holds that code until the guest
  // taps "Scan the new QR code".
  const [held, setHeld] = useState<string | null>(null);
  const scanned = held ?? qrUrl;
  const guest = useMemo(() => (scanned ? parseGuestUrl(scanned) : null), [scanned]);
  const hold = useCallback(() => setHeld((h) => h ?? scanned), [scanned]);
  const scanNew = useCallback(() => setHeld(null), []);
  return (
    <div className="demo">
      <header className="demo__bar">
        <Wordmark />
        <p className="demo__claim">
          Split-screen demo: the wallbox display and a guest's phone. They share nothing but Solana {env.chain.kind === 'mock' ? '(MOCK ledger)' : 'devnet'}.
        </p>
        <nav className="demo__nav">
          <a href={href('/owner', { ...wallboxQuery(wallbox), next: 'demo' })}>Owner settings</a>
          <a href={href('/owner/dashboard', { o: wallbox.owner })}>Dashboard</a>
          <a href={href('/how')}>How it works</a>
        </nav>
      </header>
      <div className="demo__stage">
        <div className="demo__kiosk">
          <KioskPanel wallbox={wallbox} compact onGuestUrl={setQrUrl} />
        </div>
        <div className="demo__phone">
          <PhoneFrame url={scanned}>
            {guest ? (
              <GuestFlow key={guest.session} params={guest} embedded onEngaged={hold} onScanNew={scanNew} />
            ) : (
              <div className="phone__camera">
                <span className="phone__viewfinder" aria-hidden="true" />
                <p>Waiting for the QR code on the wallbox display…</p>
              </div>
            )}
          </PhoneFrame>
          <p className="demo__phone-note">Owner payout: {shortAddr(wallbox.owner)}</p>
        </div>
      </div>
    </div>
  );
}

export function NotFound() {
  return (
    <SitePage className="narrow">
      <div className="plate">
        <h1>This page does not exist</h1>
        <p>
          Go to the <a href={href('/')}>start page</a>, <a href={href('/demo')}>try the demo</a> or read <a href={href('/how')}>how it works</a>.
        </p>
      </div>
    </SitePage>
  );
}
