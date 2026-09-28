// The wallbox display ("kiosk"): QR for the current session key, state LED, meters, payment feed
// and the simulator controls. Used full-screen on /#/wallbox and on the left of /#/demo.
import { useEffect, useMemo } from 'react';
import { STEP_WH } from '../../core/config.ts';
import { POWER_CHOICES_KW } from '../../sim/charger-sim.ts';
import { useAppEnv } from '../app-context.tsx';
import { AddressLink, Led, TxLink, type LedTone } from '../components/bits.tsx';
import { QrCode } from '../components/QrCode.tsx';
import { Register } from '../components/Register.tsx';
import { eurRegister, kwhRegister } from '../components/register-digits.ts';
import { END_REASON_TEXT, clockTime, eur, kwh, sol } from '../format.ts';
import { useStore } from '../hooks.ts';
import { guestUrl as buildGuestUrl, phantomBrowseUrl, type WallboxParams } from '../links.ts';
import { getKiosk } from './instance.ts';
import type { KioskPayment } from './kiosk-controller.ts';

const STATE_LABEL = {
  IDLE: 'Starting',
  WAITING_FOR_GUEST: 'Waiting for guest',
  CHARGING: 'CHARGING',
  ENDING: 'Ending session',
} as const;

const STATE_TONE: Record<keyof typeof STATE_LABEL, LedTone> = {
  IDLE: 'idle',
  WAITING_FOR_GUEST: 'waiting',
  CHARGING: 'charging',
  ENDING: 'ending',
};

const SPEED_PRESETS = [
  { value: 60, label: '1 kWh per minute' },
  { value: 360, label: '6 kWh per minute' },
] as const;

function PaymentRows({ rows }: { rows: KioskPayment[] }) {
  return (
    <ol className="feed" aria-label="Payments">
      {rows.map((p) => (
        <li key={p.sig} className="feed__row" data-testid="payment-row" data-seq={p.seq}>
          <span className="feed__seq">#{p.seq}</span>
          <span className="feed__amount">+{eur(p.amountMicro)} EURC</span>
          <span className="feed__kwh">{kwh(p.whCum)} kWh</span>
          <span className="feed__time">{p.at ? clockTime(p.at / 1000) : '—'}</span>
          <TxLink sig={p.sig} />
        </li>
      ))}
    </ol>
  );
}

export function KioskPanel({ wallbox, compact = false, onGuestUrl }: { wallbox: WallboxParams; compact?: boolean; onGuestUrl?: (url: string | null) => void }) {
  const env = useAppEnv();
  const kiosk = getKiosk(env);
  const snap = useStore(kiosk);
  const sim = useStore(kiosk.sim);

  useEffect(() => {
    kiosk.configure({
      owner: wallbox.owner,
      priceEur: wallbox.priceEur,
      priceMicroPerKWh: wallbox.priceMicroPerKWh,
      name: wallbox.name,
      capEur: wallbox.capEur,
    });
    kiosk.start();
  }, [kiosk, wallbox.owner, wallbox.priceEur, wallbox.priceMicroPerKWh, wallbox.name, wallbox.capEur]);

  const cfg = snap.config ?? wallbox;
  const guestUrl = useMemo(
    () => (snap.session ? buildGuestUrl(env.baseUrl, snap.session.address, cfg, env.flags.mock) : null),
    [snap.session, cfg, env.baseUrl, env.flags.mock],
  );
  const phantomUrl = guestUrl ? phantomBrowseUrl(guestUrl, env.baseUrl) : null;

  useEffect(() => {
    onGuestUrl?.(guestUrl);
  }, [guestUrl, onGuestUrl]);

  const state = snap.status === 'booting' ? 'IDLE' : snap.state;
  const charging = state === 'CHARGING';
  const step = snap.stepMicro;
  const reg = kwhRegister(sim.sessionWh);
  const paid = eurRegister(snap.totalMicro);
  const cap = snap.guest?.capMicro ?? null;
  const feedRows = snap.payments.length > 0 ? snap.payments : (snap.last?.feed ?? []);
  const powerNow = charging && sim.plugged && !sim.full ? sim.powerKw : 0;

  return (
    <section className={`kiosk on-housing${compact ? ' kiosk--compact' : ''}`} data-testid="kiosk" aria-label="Wallbox display">
      <header className="kiosk__head">
        <div className="kiosk__title">
          <span className="kiosk__brand">Laden teilen</span>
          <h1 className="kiosk__name">{cfg.name}</h1>
        </div>
        <div className="kiosk__price" title="Price per kWh">
          <span className="kiosk__price-value">{cfg.priceEur}</span>
          <span className="kiosk__price-unit">EUR / kWh</span>
        </div>
        <Led tone={STATE_TONE[state]} testId="kiosk-state" state={state}>
          {STATE_LABEL[state]}
        </Led>
      </header>

      <div className="kiosk__main">
        <div className="kiosk__plate-slot">
          {state === 'WAITING_FOR_GUEST' && guestUrl && phantomUrl ? (
            <div className="qr-plate">
              <QrCode value={guestUrl} label="QR code: open the charging page for this session" testId="kiosk-qr" className="qr-plate__qr" />
              <div className="qr-plate__title">Scan to charge</div>
              <p className="qr-plate__sub">
                Pay {step !== null ? eur(step) : '—'} EURC per 0.1 kWh from your wallet. One approval, stop anytime.
              </p>
              <div className="qr-plate__phantom">
                <QrCode value={phantomUrl} level="L" label="QR code: open this page inside the Phantom app" className="qr-plate__qr-small" />
                <p>
                  <strong>Phantom on your phone?</strong> Scan this code to open the page inside Phantom.
                </p>
              </div>
              <div className="qr-plate__foot">
                <span>Session {snap.session?.sid}</span>
                <a href={guestUrl} target="_blank" rel="noreferrer">
                  Open link
                </a>
              </div>
            </div>
          ) : state === 'CHARGING' || state === 'ENDING' ? (
            <div className="inuse-plate">
              <div className="eyebrow">In use</div>
              <dl className="facts">
                <div>
                  <dt>Guest</dt>
                  <dd>{snap.guest ? <AddressLink address={snap.guest.guest} /> : '—'}</dd>
                </div>
                <div>
                  <dt>Spending cap</dt>
                  <dd>{cap !== null ? `${eur(cap)} EURC` : '—'}</dd>
                </div>
                <div>
                  <dt>Allowance left</dt>
                  <dd>{cap !== null ? `${eur(cap - snap.totalMicro)} EURC` : '—'}</dd>
                </div>
                <div>
                  <dt>Start</dt>
                  <dd>
                    <TxLink sig={snap.guest?.sig} />
                  </dd>
                </div>
              </dl>
              <p className="inuse-plate__note">
                {state === 'ENDING'
                  ? 'Sending the final receipt and refunding the unused fee deposit…'
                  : `Every 0.1 kWh is paid before it is delivered. Session ${snap.session?.sid ?? ''}.`}
              </p>
            </div>
          ) : (
            <div className="qr-plate qr-plate--empty">
              <div className="qr-plate__title">{snap.status === 'locked' ? 'Open in another tab' : 'Preparing a session key…'}</div>
              <p className="qr-plate__sub">
                {snap.status === 'locked'
                  ? 'This wallbox display already runs in another tab of this browser. Close that tab to take over here.'
                  : 'A fresh key is created for every session.'}
              </p>
            </div>
          )}
        </div>

        <div className="kiosk__meters">
          <div className="meter">
            <span className="meter__label">Energy delivered</span>
            <Register digits={reg.digits} lastTurn={reg.lastTurn} unit="kWh" text={reg.text} value={reg.value} size={compact ? 'lg' : 'xl'} testId="kiosk-kwh" />
          </div>
          <div className="meter">
            <span className="meter__label">Paid by the guest</span>
            <Register fraction="plain" digits={paid.digits} unit="EURC" text={paid.text} value={paid.value} size={compact ? 'md' : 'lg'} testId="kiosk-eur" />
          </div>
          <dl className="kiosk__facts">
            <div>
              <dt>Power</dt>
              <dd>{powerNow.toFixed(1)} kW</dd>
            </div>
            <div>
              <dt>Step</dt>
              <dd>
                {STEP_WH / 1000} kWh = {step !== null ? eur(step) : '—'} EURC
              </dd>
            </div>
            <div>
              <dt>Payments</dt>
              <dd>{snap.payments.length}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="kiosk__feed">
        <div className="kiosk__feed-head">
          <h2>{snap.payments.length > 0 || !snap.last ? 'Payments' : 'Last session'}</h2>
          {snap.payments.length === 0 && snap.last && (
            <p className="kiosk__last" data-testid="kiosk-last">
              {kwh(snap.last.whDelivered)} kWh · {eur(snap.last.totalMicro)} EURC · {END_REASON_TEXT[snap.last.reason]}
              {snap.last.refundLamports !== null && <> · refunded {sol(snap.last.refundLamports)} SOL</>} <TxLink sig={snap.last.endSig}>end tx</TxLink>
            </p>
          )}
        </div>
        {feedRows.length > 0 ? (
          <PaymentRows rows={feedRows} />
        ) : (
          <p className="kiosk__empty">One payment per 0.1 kWh appears here, each confirmed on Solana before the energy flows.</p>
        )}
        {(snap.notice || snap.error) && (
          <p className={`kiosk__notice${snap.error ? ' kiosk__notice--error' : ''}`} role="alert">
            {snap.error ?? snap.notice}
          </p>
        )}
        {snap.pendingConfig && <p className="kiosk__notice">New settings apply after this session.</p>}
      </div>

      <div className="kiosk__sim" aria-label="Charger simulator">
        <span className="kiosk__sim-label">Simulator</span>
        <label className="toggle">
          <input type="checkbox" checked={sim.plugged} onChange={(e) => kiosk.sim.setPlugged(e.target.checked)} data-testid="sim-plugged" />
          <span>Car plugged in</span>
        </label>
        <label className="sim-field">
          <span>Power</span>
          <select className="sim-select" value={sim.powerKw} onChange={(e) => kiosk.sim.setPowerKw(Number(e.target.value))}>
            {POWER_CHOICES_KW.map((p) => (
              <option key={p} value={p}>
                {p} kW
              </option>
            ))}
          </select>
        </label>
        <label className="sim-field">
          <span>Demo speed</span>
          <select className="sim-select" value={sim.speed} onChange={(e) => kiosk.sim.setSpeed(Number(e.target.value))} data-testid="sim-speed">
            <option value={sim.powerKw}>Real time</option>
            {SPEED_PRESETS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
            {![sim.powerKw, ...SPEED_PRESETS.map((s) => s.value)].includes(sim.speed) && <option value={sim.speed}>{sim.speed} kWh per hour</option>}
          </select>
        </label>
        <div className="kiosk__sim-actions">
          <button type="button" className="btn btn--ghost btn--sm btn--on-housing" onClick={() => kiosk.sim.setFull()} disabled={!charging} data-testid="sim-full">
            Car full
          </button>
          <button type="button" className="btn btn--stop btn--sm" onClick={() => kiosk.stopSession()} disabled={!charging} data-testid="kiosk-stop">
            Stop
          </button>
        </div>
      </div>
    </section>
  );
}
