import { useConnect, useConnectedWallet, useWallets } from '@solana/kit-plugin-wallet/react';
import { isAddress } from '@solana/kit';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { stepMicro } from '../../core/amounts.ts';
import { CAP_CHOICES_EUR, DEFAULT_PRICE_EUR, STEP_WH } from '../../core/config.ts';
import { useAppEnv } from '../app-context.tsx';
import { SitePage } from '../components/chrome.tsx';
import { Modal } from '../components/Modal.tsx';
import { DEMO_OWNER, DEMO_WALLBOX_NAME } from '../demo-config.ts';
import { eur } from '../format.ts';
import { cleanName, parseCap, parsePrice } from '../links.ts';
import { navigate } from '../router.ts';
import { readJson, writeJson } from '../storage.ts';
import { getWalletClient } from '../wallet/standard.ts';

export const OWNER_SETTINGS_KEY = 'lt:owner-settings';

export interface OwnerSettings {
  owner: string;
  price: string;
  name: string;
  cap: string;
}

/** Fills the payout address from a connected wallet. Nothing is signed. */
function UseWalletAddress({ onAddress }: { onAddress: (a: string) => void }) {
  const client = getWalletClient();
  const wallets = useWallets(client);
  const connected = useConnectedWallet(client);
  const { dispatch: connect } = useConnect(client);
  const [open, setOpen] = useState(false);
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current && connected) {
      asked.current = false;
      onAddress(connected.account.address);
    }
  }, [connected, onAddress]);
  return (
    <>
      <button type="button" className="linkbtn" onClick={() => (connected ? onAddress(connected.account.address) : setOpen(true))}>
        {connected ? `Use ${connected.wallet.name} address` : 'Use my wallet address'}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Use a wallet address">
        {wallets.length === 0 ? (
          <p>No Solana wallet was found in this browser. Paste the payout address instead.</p>
        ) : (
          <div className="wallet-list">
            {wallets.map((w) => (
              <button
                key={w.name}
                type="button"
                className="wallet-option"
                onClick={() => {
                  asked.current = true;
                  connect(w);
                  setOpen(false);
                }}
              >
                {w.icon && <img src={w.icon} alt="" width={28} height={28} />}
                <span>{w.name}</span>
              </button>
            ))}
          </div>
        )}
        <p className="muted">Only the address is read. Owners never sign anything.</p>
      </Modal>
    </>
  );
}

export function OwnerSetup({ params }: { params: URLSearchParams }) {
  const env = useAppEnv();
  const toDemo = params.get('next') === 'demo';
  const saved = readJson<OwnerSettings>(env.storage, OWNER_SETTINGS_KEY);
  const [owner, setOwner] = useState(params.get('o') ?? saved?.owner ?? (toDemo ? DEMO_OWNER : ''));
  const [price, setPrice] = useState(params.get('p') ?? saved?.price ?? DEFAULT_PRICE_EUR);
  const [name, setName] = useState(params.get('n') ?? saved?.name ?? (toDemo ? DEMO_WALLBOX_NAME : 'My wallbox'));
  const [cap, setCap] = useState(parseCap(params.get('cap') ?? saved?.cap));
  const [touched, setTouched] = useState(false);

  const ownerTrim = owner.trim();
  const ownerOk = isAddress(ownerTrim);
  const parsed = parsePrice(price);
  const step = parsed ? stepMicro(parsed.micro, STEP_WH) : null;

  const go = (target: 'wallbox' | 'demo' | 'dashboard') => {
    setTouched(true);
    if (!ownerOk || (target !== 'dashboard' && !parsed)) return;
    const q = { o: ownerTrim, p: parsed?.eur ?? DEFAULT_PRICE_EUR, n: cleanName(name) || 'Wallbox', cap };
    writeJson(env.storage, OWNER_SETTINGS_KEY, { owner: q.o, price: q.p, name: q.n, cap } satisfies OwnerSettings);
    if (target === 'dashboard') navigate('/owner/dashboard', { o: q.o });
    else navigate(target === 'demo' ? '/demo' : '/wallbox', q);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    go(toDemo ? 'demo' : 'wallbox');
  };

  return (
    <SitePage current="/owner" className="owner">
      <div className="owner__intro">
        <p className="eyebrow">For wallbox owners</p>
        <h1>Set up your wallbox</h1>
        <p className="owner__lead">Choose where the money goes and what a kWh costs. There is no account, and you never sign anything here.</p>
      </div>

      <div className="owner__grid">
        <form className="plate owner__form" onSubmit={onSubmit} noValidate>
          <div className="field">
            <label className="field__label" htmlFor="owner-address">
              Payout wallet
            </label>
            <input
              id="owner-address"
              className="input input--mono"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder="Solana address"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={touched && !ownerOk}
              data-testid="owner-address"
            />
            <span className="field__hint">
              EURC from every session goes straight to this address. {env.chain.kind === 'devnet' && <UseWalletAddress onAddress={setOwner} />}
            </span>
            {touched && !ownerOk && <span className="field__error">Enter a valid Solana address (base58, 32–44 characters).</span>}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="owner-name">
              Wallbox name
            </label>
            <input id="owner-name" className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} data-testid="owner-name" />
            <span className="field__hint">Shown on the display and on the guest's receipt.</span>
          </div>

          <div className="owner__row">
            <div className="field">
              <label className="field__label" htmlFor="owner-price">
                Price per kWh
              </label>
              <div className="input-affix">
                <input
                  id="owner-price"
                  className="input"
                  inputMode="decimal"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  aria-invalid={touched && !parsed}
                  data-testid="owner-price"
                />
                <span className="input-affix__unit">EUR</span>
              </div>
              <span className="field__hint">{step !== null ? `Guests pay ${eur(step)} EURC per 0.1 kWh.` : 'For example 0.39'}</span>
              {touched && !parsed && <span className="field__error">Enter a price between 0.01 and 9.99 EUR.</span>}
            </div>
            <div className="field">
              <label className="field__label" htmlFor="owner-cap">
                Suggested cap
              </label>
              <select id="owner-cap" className="select" value={cap} onChange={(e) => setCap(e.target.value)} data-testid="owner-cap">
                {CAP_CHOICES_EUR.map((c) => (
                  <option key={c} value={c}>
                    {c} EURC
                  </option>
                ))}
              </select>
              <span className="field__hint">Guests can pick another.</span>
            </div>
          </div>

          <div className="owner__actions">
            <button type="submit" className="btn" data-testid="open-kiosk">
              {toDemo ? 'Open the split-screen demo' : 'Open wallbox display'}
            </button>
            {!toDemo && (
              <button type="button" className="btn btn--ghost" onClick={() => go('demo')} data-testid="open-demo">
                Split-screen demo
              </button>
            )}
            <button type="button" className="btn btn--ghost" onClick={() => go('dashboard')} data-testid="open-dashboard">
              Dashboard
            </button>
          </div>
        </form>

        <aside className="owner__aside">
          <h2>What happens next</h2>
          <ul>
            <li>
              <strong>The display</strong> runs in a browser next to the wallbox, on a tablet or an old phone. It shows a QR code with a fresh key for every
              session.
            </li>
            <li>
              <strong>A guest approves a cap.</strong> The display then pulls {step !== null ? eur(step) : '0.039'} EURC before every 0.1 kWh, straight to your
              wallet.
            </li>
            <li>
              <strong>Keep it open while charging.</strong> If the page reloads, it resumes the session or refunds the guest's fee deposit.
            </li>
            <li>
              <strong>Your dashboard</strong> is rebuilt from Solana history, on any device, with CSV export for your bookkeeping.
            </li>
          </ul>
        </aside>
      </div>
    </SitePage>
  );
}
