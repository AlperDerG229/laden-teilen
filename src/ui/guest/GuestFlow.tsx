// Guest charging page: wallbox info + cap + wallet -> one approval -> live meter -> stop & revoke
// -> receipt. Used on /#/charge and inside the phone frame of /#/demo.
import { useConnect, useConnectedWallet, useWallets } from '@solana/kit-plugin-wallet/react';
import type { Address } from '@solana/kit';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { parseEurToMicro } from '../../core/amounts.ts';
import { CAP_CHOICES_EUR, STEP_WH } from '../../core/config.ts';
import { useAppEnv } from '../app-context.tsx';
import { AddressLink, Check, Led, TxLink } from '../components/bits.tsx';
import { FundsPanel } from '../components/FundsPanel.tsx';
import { Modal } from '../components/Modal.tsx';
import { Register } from '../components/Register.tsx';
import { kwhRegister } from '../components/register-digits.ts';
import { END_REASON_TEXT, clockTime, dateTime, eur, kwh, shortAddr, sol } from '../format.ts';
import { useStore } from '../hooks.ts';
import { phantomBrowseUrl, type GuestParams } from '../links.ts';
import { loadDemoWallet } from '../wallet/demo-wallet.ts';
import { getWalletClient, isMobileBrowser } from '../wallet/standard.ts';
import { GuestController, type GuestSnapshot, type GuestWallet } from './guest-controller.ts';

interface GuestFlowProps {
  /** Must be referentially stable (memoize it): a new object starts a new controller. */
  params: GuestParams;
  embedded?: boolean;
  onScanNew?: () => void;
  /** Called once the guest has started (or returns to) a session on this QR code. */
  onEngaged?: () => void;
}

export function GuestFlow({ params, embedded = false, onScanNew, onEngaged }: GuestFlowProps) {
  const env = useAppEnv();
  const controller = useMemo(
    () => new GuestController({ chain: env.chain, storage: env.storage, mode: env.chain.kind, params }),
    [env.chain, env.storage, params],
  );
  useEffect(() => {
    void controller.init();
    return () => controller.dispose();
  }, [controller]);
  return (
    <div className={`guest${embedded ? ' guest--embedded' : ''}`} data-testid="guest">
      <div className="guest__bar">
        <span className="wordmark wordmark--sm">
          <span className="wordmark__mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          Laden teilen
        </span>
        <span className="net-tag">{env.chain.kind === 'mock' ? 'Mock' : 'Devnet'}</span>
      </div>
      <GuestScreens controller={controller} params={params} embedded={embedded} onScanNew={onScanNew} onEngaged={onEngaged} />
    </div>
  );
}

function capKwh(capEur: string, priceMicro: bigint): string {
  const micro = parseEurToMicro(capEur);
  const tenths = (micro * 10n) / priceMicro; // floor(cap / price * 10)
  return (Number(tenths) / 10).toFixed(1);
}

function GuestScreens({
  controller,
  params,
  embedded,
  onScanNew,
  onEngaged,
}: {
  controller: GuestController;
  params: GuestParams;
  embedded: boolean;
  onScanNew?: () => void;
  onEngaged?: () => void;
}) {
  const env = useAppEnv();
  const mode = env.chain.kind;
  const snap = useStore(controller);
  const [wallet, setWallet] = useState<GuestWallet | null>(null);
  const [fundsManual, setFundsManual] = useState(false);
  const fundsOpen = fundsManual || snap.fundsPrompt;
  const setFundsOpen = (open: boolean) => {
    setFundsManual(open);
    if (!open) controller.dismissFundsPrompt();
  };

  const engaged = snap.phase === 'live' || snap.phase === 'stopping' || snap.phase === 'receipt';

  // New screen (live view, receipt): start at its top, inside the phone frame or the page.
  const top = useRef<HTMLDivElement>(null);
  const screen = snap.phase === 'stopping' ? 'live' : snap.phase;
  useEffect(() => {
    const scroller = top.current?.closest('.phone__screen');
    if (scroller) scroller.scrollTo({ top: 0 });
    else if (screen === 'live' || screen === 'receipt') window.scrollTo({ top: 0 });
  }, [screen]);
  useEffect(() => {
    if (engaged) onEngaged?.();
  }, [engaged, onEngaged]);

  useEffect(() => {
    void controller.setWallet(wallet);
  }, [controller, wallet]);

  const demoLabel = mode === 'mock' ? 'Demo wallet (mock)' : 'Demo wallet (devnet)';
  const chooseDemo = async () => {
    const signer = await loadDemoWallet(env.storage, mode);
    setWallet({ kind: 'demo', address: signer.address, signer, label: demoLabel });
  };

  // A returning guest who used the demo wallet gets it back automatically.
  useEffect(() => {
    if (controller.recordedWallet?.kind !== 'demo') return;
    let alive = true;
    void loadDemoWallet(env.storage, mode).then((signer) => {
      if (alive) setWallet({ kind: 'demo', address: signer.address, signer, label: demoLabel });
    });
    return () => {
      alive = false;
    };
  }, [controller, env.storage, mode, demoLabel]);

  // While getting ready, keep balances fresh (funding happens in another tab).
  useEffect(() => {
    if (snap.phase !== 'ready' || !wallet) return;
    const t = setInterval(() => void controller.refreshBalances(), 4_000);
    return () => clearInterval(t);
  }, [controller, snap.phase, wallet]);

  // Spec 6.3: without enough funds the "Get test funds" panel opens (the controller sets
  // fundsPrompt once when a wallet is chosen).
  const fundsPanel = wallet && (
    <FundsPanel
      open={fundsOpen}
      onClose={() => {
        setFundsOpen(false);
        void controller.refreshBalances();
      }}
      address={wallet.address}
      walletLabel={wallet.kind === 'demo' ? `The ${wallet.label.toLowerCase()}` : `Your ${wallet.label} wallet`}
    />
  );

  switch (snap.phase) {
    case 'checking':
      return (
        <div className="guest__body" ref={top}>
          <WallboxCard params={params} />
          <p className="guest__loading">Checking this session on Solana…</p>
        </div>
      );
    case 'busy':
      return (
        <div className="guest__body" ref={top}>
          <WallboxCard params={params} />
          <div className="notice notice--warn" data-testid="guest-busy">
            <span>
              This QR code was already used for a charging session. Every session gets a new code: scan the wallbox display again.
              {snap.busyBy && (
                <>
                  {' '}
                  (Started by <AddressLink address={snap.busyBy} />
                  .)
                </>
              )}
            </span>
          </div>
          {embedded && onScanNew && (
            <button type="button" className="btn btn--block" onClick={onScanNew}>
              Scan the new QR code
            </button>
          )}
        </div>
      );
    case 'ready':
    case 'starting':
      return (
        <div className="guest__body" ref={top}>
          <WallboxCard params={params} />
          <section className="guest__section">
            <label className="field">
              <span className="field__label">Spending cap</span>
              <select
                className="select"
                value={snap.capEur}
                onChange={(e) => controller.setCap(e.target.value)}
                data-testid="cap-select"
                disabled={snap.phase === 'starting'}
              >
                {CAP_CHOICES_EUR.map((c) => (
                  <option key={c} value={c}>
                    {c} EURC (up to {capKwh(c, params.priceMicroPerKWh)} kWh)
                  </option>
                ))}
              </select>
              <span className="field__hint">The most this session can take. You only pay for energy delivered.</span>
            </label>
            <p className="guest__deposit">+ 0.005 SOL network-fee deposit, refunded at the end</p>
          </section>

          <section className="guest__section">
            <span className="field__label">Wallet</span>
            {wallet ? (
              <WalletCard wallet={wallet} snap={snap} onFunds={() => setFundsOpen(true)} onSwitch={() => setWallet(null)} />
            ) : (
              <div className="guest__wallets">
                {mode === 'devnet' ? (
                  <StandardWallets selected={wallet} onSelect={setWallet} />
                ) : (
                  <button
                    type="button"
                    className="btn btn--ghost btn--block"
                    disabled
                    data-testid="guest-connect"
                    title="Wallet apps are disabled in MOCK mode"
                  >
                    Connect wallet (off in MOCK mode)
                  </button>
                )}
                <button type="button" className="btn btn--ghost btn--block" onClick={chooseDemo} data-testid="demo-wallet">
                  Use demo wallet ({mode === 'mock' ? 'mock' : 'devnet'})
                </button>
              </div>
            )}
            {snap.replacesDelegate && (
              <div className="notice notice--warn" data-testid="delegate-warning">
                <span>
                  Your EURC account already lets <AddressLink address={snap.replacesDelegate} /> spend {snap.balances ? eur(snap.balances.delegatedMicro) : '?'}{' '}
                  EURC. A token account has one spending approval at a time, so starting here replaces it.
                </span>
              </div>
            )}
          </section>

          {snap.error && (
            <p className="notice notice--error" role="alert">
              <span>{snap.error}</span>
            </p>
          )}
          <StartButton snap={snap} wallet={wallet} onStart={() => void controller.start()} onFunds={() => setFundsOpen(true)} />
          {fundsPanel}
        </div>
      );
    case 'live':
    case 'stopping':
      return (
        <div className="guest__body" ref={top}>
          <LiveView snap={snap} params={params} />
          {snap.error && (
            <p className="notice notice--error" role="alert">
              <span>{snap.error}</span>
            </p>
          )}
          {snap.phase === 'live' ? (
            <>
              {!wallet?.signer && (
                <p className="notice">
                  <span>Connect the wallet that started this session to stop it. You can also just leave: the wallbox stops when your cap is used up.</span>
                </p>
              )}
              {!wallet && mode === 'devnet' && <StandardWallets selected={wallet} onSelect={setWallet} />}
              <button
                type="button"
                className="btn btn--stop btn--block"
                onClick={() => void controller.stopAndRevoke()}
                disabled={!wallet?.signer || snap.pending !== null}
                data-testid="stop-btn"
              >
                {snap.pending === 'stop' ? (wallet?.kind === 'standard' ? `Approve in ${wallet.label}…` : 'Stopping…') : 'Stop & revoke'}
              </button>
              <p className="guest__fine">You can close this page. Charging also stops when your cap is used up or the car is full.</p>
            </>
          ) : (
            <div className="notice" data-testid="guest-stopping">
              <span>
                Allowance revoked <TxLink sig={snap.stopSig} />. Waiting for the wallbox to send the final receipt and refund your fee deposit…
                {snap.notice && <> {snap.notice}</>}
              </span>
            </div>
          )}
        </div>
      );
    case 'receipt':
      return (
        <div className="guest__body" ref={top}>
          <Receipt snap={snap} params={params} wallet={wallet} onRevoke={() => void controller.revokeLeftover()} />
          {embedded && onScanNew ? (
            <button type="button" className="btn btn--block" onClick={onScanNew} data-testid="scan-new">
              Scan the new QR code
            </button>
          ) : null}
        </div>
      );
  }
}

function WallboxCard({ params }: { params: GuestParams }) {
  return (
    <section className="guest__box">
      <span className="eyebrow">Wallbox</span>
      <h1 className="guest__name">{params.name}</h1>
      <p className="guest__price">
        <strong>{params.priceEur}</strong> EUR per kWh
      </p>
      <p className="guest__step">{eur((params.priceMicroPerKWh * BigInt(STEP_WH)) / 1000n)} EURC per 0.1 kWh, paid before it is delivered</p>
      <p className="guest__owner">
        Payout to <AddressLink address={params.owner} />
      </p>
    </section>
  );
}

function WalletCard({ wallet, snap, onFunds, onSwitch }: { wallet: GuestWallet; snap: GuestSnapshot; onFunds: () => void; onSwitch: () => void }) {
  const b = snap.balances;
  return (
    <div className="wallet-card" data-testid="wallet-card">
      <div className="wallet-card__head">
        <strong>{wallet.label}</strong>
        <button type="button" className="linkbtn" onClick={onSwitch}>
          Switch
        </button>
      </div>
      <AddressLink address={wallet.address} copy />
      <div className="wallet-card__bal">
        <span>
          <span className="eyebrow">SOL</span> {b ? sol(b.lamports) : '…'}
        </span>
        <span>
          <span className="eyebrow">EURC</span> {b ? eur(b.tokenMicro) : '…'}
        </span>
        <button type="button" className="linkbtn" onClick={onFunds} data-testid="open-funds">
          Get test funds
        </button>
      </div>
      {wallet.kind === 'demo' && (
        <p className="wallet-card__badge">
          {wallet.label.includes('mock')
            ? 'Demo wallet (mock): on devnet, Phantom/Solflare work the same way.'
            : 'Demo wallet (devnet): Phantom/Solflare work the same way.'}
        </p>
      )}
    </div>
  );
}

function StartButton({ snap, wallet, onStart, onFunds }: { snap: GuestSnapshot; wallet: GuestWallet | null; onStart: () => void; onFunds: () => void }) {
  let hint: ReactNode = 'One approval in your wallet: the spending cap plus the refundable fee deposit.';
  if (!wallet) hint = 'Choose a wallet first.';
  else if (!snap.balances) hint = 'Reading balances…';
  else if (snap.blockers.includes('no-signer')) hint = 'This wallet cannot sign here. Use another wallet or the demo wallet.';
  else if (snap.blockers.length > 0)
    hint = (
      <>
        Needs at least 0.006 SOL and one step of EURC.{' '}
        <button type="button" className="linkbtn" onClick={onFunds}>
          Get test funds
        </button>
      </>
    );
  const ready = !!wallet && !!snap.balances && snap.blockers.length === 0 && snap.phase === 'ready';
  return (
    <div className="guest__start">
      <button type="button" className="btn btn--go btn--block btn--lg" onClick={onStart} disabled={!ready} data-testid="start-btn">
        {snap.phase === 'starting' ? (wallet?.kind === 'standard' ? `Approve in ${wallet.label}…` : 'Starting…') : `Start charging · cap ${snap.capEur} EURC`}
      </button>
      <p className="guest__fine">{hint}</p>
    </div>
  );
}

function LiveView({ snap, params }: { snap: GuestSnapshot; params: GuestParams }) {
  const reg = kwhRegister(snap.whTotal);
  const cap = parseEurToMicro(snap.capEur);
  const capMicro = snap.allowanceMicro + snap.paidMicro > cap ? snap.allowanceMicro + snap.paidMicro : cap;
  const left = snap.delegateActive ? snap.allowanceMicro : 0n;
  const pct = capMicro > 0n ? Number((left * 1000n) / capMicro) / 10 : 0;
  return (
    <section className="live" aria-label="Charging">
      <div className="live__head">
        <Led tone={snap.phase === 'live' ? 'charging' : 'ending'} light state={snap.phase}>
          {snap.phase === 'live' ? 'Charging' : 'Stopping'}
        </Led>
        <span className="live__sid">Session {snap.sid}</span>
      </div>
      <div className="live__meter">
        <span className="meter__label">Energy</span>
        <Register digits={reg.digits} unit="kWh" text={reg.text} value={reg.value} size="lg" testId="guest-kwh" />
      </div>
      <div className="live__stats">
        <div>
          <span className="eyebrow">Paid</span>
          <strong data-testid="guest-paid">{eur(snap.paidMicro)} EURC</strong>
        </div>
        <div>
          <span className="eyebrow">Allowance left</span>
          <strong data-testid="allowance" data-value={eur(left)}>
            {eur(left)} EURC
          </strong>
          <span className="allowance-bar" aria-hidden="true">
            <i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
          </span>
        </div>
      </div>
      <p className="live__start">
        Started with one approval <TxLink sig={snap.startSig} /> · {params.priceEur} EUR/kWh
      </p>
      <h2 className="live__list-title">Payments ({snap.payments.length})</h2>
      {snap.payments.length === 0 ? (
        <p className="guest__fine">The wallbox pulls the first 0.1 kWh in a moment.</p>
      ) : (
        <ol className="feed feed--light">
          {snap.payments.map((p) => (
            <li key={p.sig} className="feed__row" data-testid="payment-row" data-seq={p.seq}>
              <span className="feed__seq">#{p.seq}</span>
              <span className="feed__amount">{eur(p.amountMicro)} EURC</span>
              <span className="feed__kwh">{kwh(p.whCum)} kWh</span>
              <span className="feed__time">{clockTime(p.blockTime)}</span>
              <TxLink sig={p.sig} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Receipt({ snap, params, wallet, onRevoke }: { snap: GuestSnapshot; params: GuestParams; wallet: GuestWallet | null; onRevoke: () => void }) {
  const mock = useAppEnv().chain.kind === 'mock';
  const end = snap.end!;
  const reg = kwhRegister(end.whTotal);
  const ascending = [...snap.payments].reverse();
  return (
    <section className="receipt" data-testid="receipt" aria-label="Receipt">
      <div className="receipt__head">
        <span className="eyebrow">Receipt</span>
        <span className="receipt__meta">
          {params.name} · session {snap.sid}
        </span>
      </div>
      <div className="receipt__totals">
        <div>
          <span className="meter__label">Energy</span>
          <Register digits={reg.digits} unit="kWh" text={reg.text} value={reg.value} size="md" testId="receipt-kwh" />
        </div>
        <div>
          <span className="meter__label">Paid</span>
          <strong className="receipt__eur" data-testid="receipt-eur" data-value={eur(end.totalMicro)}>
            {eur(end.totalMicro)} <small>EURC</small>
          </strong>
        </div>
      </div>
      <p className="receipt__reason">
        {END_REASON_TEXT[end.reason]} · {params.priceEur} EUR/kWh · {snap.payments.length} payments
      </p>
      <div className="receipt__checks">
        {snap.delegateActive ? (
          <div className="receipt__open">
            <Check ok={false} testId="receipt-allowance">
              Allowance still active: {eur(snap.allowanceMicro)} EURC. The session key is thrown away, but you can remove the approval.
            </Check>
            <button type="button" className="btn btn--sm" onClick={onRevoke} disabled={!wallet?.signer || snap.pending !== null} data-testid="revoke-btn">
              {snap.pending === 'revoke' ? 'Revoking…' : 'Revoke now'}
            </button>
          </div>
        ) : (
          <Check ok testId="receipt-allowance">
            Allowance revoked {snap.stopSig ? <TxLink sig={snap.stopSig} /> : <span className="muted">(nothing left to spend)</span>}
          </Check>
        )}
        <Check ok={end.refundLamports !== null} testId="receipt-refund">
          {end.refundLamports !== null ? <>Fee deposit refunded: {sol(end.refundLamports)} SOL </> : <>Fee deposit refund: checking… </>}
          <TxLink sig={end.sig} />
        </Check>
      </div>
      <details className="receipt__txs">
        <summary>All transactions ({snap.payments.length + (snap.stopSig ? 3 : 2)})</summary>
        <ol>
          <li>
            Start (cap + deposit) <TxLink sig={snap.startSig} />
          </li>
          {ascending.map((p) => (
            <li key={p.sig}>
              Pay #{p.seq}: {eur(p.amountMicro)} EURC for {kwh(p.whCum)} kWh <TxLink sig={p.sig} />
            </li>
          ))}
          {snap.stopSig && (
            <li>
              Stop & revoke <TxLink sig={snap.stopSig} />
            </li>
          )}
          <li>
            End & refund <TxLink sig={end.sig} />
          </li>
        </ol>
      </details>
      <p className="guest__fine">
        {dateTime(end.blockTime)} · paid to {shortAddr(params.owner)} · {mock ? 'MOCK ledger, nothing on Solana' : 'Solana devnet, test tokens only'}.
      </p>
    </section>
  );
}

/** Wallet-standard wallets. Only mounted in devnet mode. */
function StandardWallets({ selected, onSelect }: { selected: GuestWallet | null; onSelect: (w: GuestWallet | null) => void }) {
  const env = useAppEnv();
  const client = getWalletClient();
  const wallets = useWallets(client);
  const connected = useConnectedWallet(client);
  const { dispatch: connect, isRunning, error } = useConnect(client);
  const [open, setOpen] = useState(false);
  const userAsked = useRef(false);

  useEffect(() => {
    if (!connected?.signer) return;
    // A silent auto-reconnect must not override a wallet the guest already picked.
    if (selected && !userAsked.current) return;
    if (selected?.kind === 'standard' && selected.address === connected.account.address) return;
    onSelect({ kind: 'standard', address: connected.account.address as Address, signer: connected.signer, label: connected.wallet.name });
    userAsked.current = false;
  }, [connected, selected, onSelect]);

  const here = typeof window !== 'undefined' ? window.location.href : env.baseUrl;
  return (
    <>
      <button type="button" className="btn btn--block" onClick={() => setOpen(true)} data-testid="guest-connect" disabled={isRunning}>
        {isRunning ? 'Connecting…' : 'Connect wallet'}
      </button>
      {isMobileBrowser() && wallets.length === 0 && (
        <a className="btn btn--ghost btn--block" href={phantomBrowseUrl(here, env.baseUrl)} data-testid="open-in-phantom">
          Open in Phantom
        </a>
      )}
      {error ? (
        <p className="notice notice--error">
          <span>Could not connect: {error instanceof Error ? error.message : String(error)}</span>
        </p>
      ) : null}
      <Modal open={open} onClose={() => setOpen(false)} title="Connect a wallet">
        {wallets.length === 0 ? (
          <p>No Solana wallet was found in this browser. Install Phantom, Solflare or Backpack, open this page in the Phantom app, or use the demo wallet.</p>
        ) : (
          <div className="wallet-list">
            {wallets.map((w) => (
              <button
                key={w.name}
                type="button"
                className="wallet-option"
                onClick={() => {
                  userAsked.current = true;
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
        <p className="muted">
          Set the wallet to Solana <strong>devnet</strong> (Phantom: Settings → Developer Settings → Testnet Mode) so its preview matches. The wallet only
          signs; this page sends the transaction to devnet.
        </p>
      </Modal>
    </>
  );
}
