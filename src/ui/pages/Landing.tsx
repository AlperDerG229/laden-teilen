import { useEffect, useState } from 'react';
import { Led } from '../components/bits.tsx';
import { SitePage } from '../components/chrome.tsx';
import { Register } from '../components/Register.tsx';
import { eurRegister, kwhRegister } from '../components/register-digits.ts';
import { href } from '../router.ts';

const STEP_MS = 1_600;
const STEP_MICRO = 39_000n;
const FIRST_STEP = 7;

/** Illustration: the charger pulls 0.039 EURC first, then the 0.1 kWh flows. */
function HeroMeter() {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const started = Date.now();
    const timer = setInterval(() => setT(Date.now() - started), 120);
    return () => clearInterval(timer);
  }, []);
  const steps = t / STEP_MS;
  const step = FIRST_STEP + Math.floor(steps);
  const wh = (FIRST_STEP - 1 + steps) * 100;
  const paid = BigInt(step) * STEP_MICRO;
  const reg = kwhRegister(wh, 3);
  const money = eurRegister(paid);
  return (
    <figure className="hero-meter on-housing" aria-label="Illustration of a charging session">
      <div className="hero-meter__head">
        <Led tone="charging">Charging</Led>
        <span className="hero-meter__box">Wallbox · 11 kW</span>
      </div>
      <div className="hero-meter__row">
        <span className="meter__label">Energy</span>
        <Register digits={reg.digits} lastTurn={reg.lastTurn} unit="kWh" text={reg.text} size="lg" />
      </div>
      <div className="hero-meter__row">
        <span className="meter__label">Paid</span>
        <Register fraction="plain" digits={money.digits} unit="EURC" text={money.text} size="md" />
      </div>
      <figcaption className="hero-meter__log">
        <span className="hero-meter__seq">pay #{step}</span>
        <span>0.039 EURC pulled and confirmed, then 0.1 kWh delivered</span>
      </figcaption>
    </figure>
  );
}

export function Landing() {
  return (
    <SitePage current="/" className="landing">
      <section className="hero">
        <div className="hero__copy">
          <p className="eyebrow">Pay-as-you-charge for private wallboxes</p>
          <h1 className="hero__title">
            Share your wallbox. <span className="hero__title-2">Get paid every <span className="hero__em">0.1&nbsp;kWh</span>.</span>
          </h1>
          <p className="hero__lead">
            Guests scan a QR code and approve one spending cap. Before each 0.1 kWh, the charger pulls 0.039 EURC from their wallet on Solana, then delivers the
            energy. No app, no account, no invoice.
          </p>
          <div className="hero__ctas">
            <a className="btn" href={href('/demo')} data-testid="cta-demo">
              Try the demo
            </a>
            <a className="btn btn--ghost" href={href('/owner')} data-testid="cta-owner">
              I own a wallbox
            </a>
            <a className="hero__how" href={href('/how')} data-testid="cta-how">
              How it works →
            </a>
          </div>
          <p className="hero__fine">Runs on Solana devnet with test tokens. The in-page demo wallet needs no install.</p>
        </div>
        <HeroMeter />
      </section>

      <section className="problem">
        <div>
          <p className="eyebrow">The problem</p>
          <h2>Street parkers have no plug. Private wallboxes sit idle.</h2>
          <p>
            Many EV drivers in German cities park on the street and have no home charger. Meanwhile private wallboxes stand unused most of the day. Sharing one
            today means cash, chasing PayPal transfers, or a billing subscription where the host still sends payment links.
          </p>
        </div>
        <table className="compare">
          <caption className="sr-only">Settling a shared charge today and with Laden teilen</caption>
          <thead>
            <tr>
              <th scope="col">Today</th>
              <th scope="col">With Laden teilen</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Pay afterwards, in cash or by PayPal</td>
              <td>Paid before every 0.1 kWh</td>
            </tr>
            <tr>
              <td>The host chases missing payments</td>
              <td>Settled in seconds, in euro stablecoin</td>
            </tr>
            <tr>
              <td>Billing plans cost up to €59 a year</td>
              <td>No subscription, no sign-up</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="steps" aria-labelledby="steps-title">
        <p className="eyebrow">A session, step by step</p>
        <h2 id="steps-title">One QR code, one approval, then the meter runs.</h2>
        <ol className="steps__list">
          <li>
            <h3>Scan</h3>
            <p>The display next to the wallbox shows a QR code with a fresh key for this session only.</p>
          </li>
          <li>
            <h3>Approve one cap</h3>
            <p>One wallet approval: a spending cap, for example 5 EURC, for that key, plus a 0.005 SOL fee deposit that comes back. The money stays in your wallet.</p>
          </li>
          <li>
            <h3>Pay, then charge</h3>
            <p>Before every 0.1 kWh the charger pulls 0.039 EURC and waits for the confirmation. Each payment is an on-chain receipt.</p>
          </li>
          <li>
            <h3>Stop anytime</h3>
            <p>Stop &amp; revoke removes the approval and the unused deposit is refunded. You pay exactly for the energy delivered.</p>
          </li>
        </ol>
      </section>

      <section className="why">
        <div>
          <p className="eyebrow">Why Solana</p>
          <h2>Payments small enough to follow the meter.</h2>
        </div>
        <ul className="why__list">
          <li>
            <strong>Sub-cent fees make 0.1 kWh steps possible.</strong> A 12.8 kWh session is 128 payments and about 0.0006 SOL in network fees.
          </li>
          <li>
            <strong>EURC settles instantly, in euros.</strong> The owner is paid while the car charges, not at the end of the month.
          </li>
          <li>
            <strong>The chain is the database.</strong> The owner dashboard is rebuilt from Solana history on any device. There is no backend.
          </li>
        </ul>
      </section>

      <section className="fit">
        <blockquote>
          DeCharge sells chargers. Stromnachbar sends PayPal links. Laden teilen turns the wallbox you already own into a pay-per-kWh charger with one QR code and
          one wallet approval, settled in EURC every 0.1 kWh.
        </blockquote>
        <a className="btn btn--ghost" href={href('/how')}>
          Read how it works
        </a>
      </section>
    </SitePage>
  );
}
