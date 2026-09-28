// Owner dashboard, built only from chain data: getSignaturesForAddress(owner EURC account) -> LT1
// pay memos grouped by session; "verify" checks the real token movement via getTransaction.
import { isAddress, type Address } from '@solana/kit';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { SessionSummary } from '../../core/chain.ts';
import { CLUSTER } from '../../core/config.ts';
import { errorMessage } from '../../core/errors.ts';
import { sleep } from '../../core/throttle.ts';
import { useAppEnv } from '../app-context.tsx';
import { AddressLink, CopyButton, TxLink } from '../components/bits.tsx';
import { SitePage } from '../components/chrome.tsx';
import { Register } from '../components/Register.tsx';
import { eurRegister, kwhRegister } from '../components/register-digits.ts';
import { sessionsCsv } from '../csv.ts';
import { dateTime, duration, eur, kwh } from '../format.ts';
import { usePolling } from '../hooks.ts';
import { href, navigate } from '../router.ts';
import { readJson } from '../storage.ts';
import { OWNER_SETTINGS_KEY, type OwnerSettings } from './OwnerSetup.tsx';

/** getTransaction budget for verification (spec 4.6: lazy, <= 3/s). */
const VERIFY_GAP_MS = 340;

interface Check {
  guest: string | null;
  ok: number;
  bad: number;
  total: number;
  state: 'sampled' | 'running' | 'done' | 'error';
}

function Picker({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  const [touched, setTouched] = useState(false);
  const ok = isAddress(value.trim());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (ok) navigate('/owner/dashboard', { o: value.trim() });
  };
  return (
    <div className="dash">
      <div className="dash__head">
        <p className="eyebrow">Owner dashboard</p>
        <h1>Earnings</h1>
        <p className="muted">Enter the payout wallet of a wallbox. The dashboard is rebuilt from Solana devnet history, with no login.</p>
      </div>
      <form className="plate dash__picker" onSubmit={submit} noValidate>
        <label className="field">
          <span className="field__label">Payout wallet</span>
          <input className="input input--mono" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Solana address" aria-invalid={touched && !ok} data-testid="dash-owner" />
          {touched && !ok && <span className="field__error">Enter a valid Solana address.</span>}
        </label>
        <button type="submit" className="btn">
          Show earnings
        </button>
      </form>
    </div>
  );
}

function Dashboard({ owner }: { owner: Address }) {
  const { chain } = useAppEnv();
  const q = usePolling(() => chain.listOwnerSessions(owner), 20_000, [chain, owner]);
  const ata = usePolling(() => chain.findAta(owner), 3_600_000, [chain, owner]);
  const sessions: SessionSummary[] | undefined = q.data;
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const checksRef = useRef(checks);
  useEffect(() => {
    checksRef.current = checks;
  });

  // Lazy: verify the first payment of each session, which also reveals the paying guest wallet.
  useEffect(() => {
    if (!sessions || !ata.data) return;
    const ownerAta = ata.data;
    let alive = true;
    void (async () => {
      for (const s of sessions) {
        if (!alive) return;
        if (checksRef.current[s.sid] || s.payments.length === 0) continue;
        try {
          const v = await chain.verifyPayment(s.payments[0].sig, ownerAta);
          if (!alive) return;
          setChecks((c) => ({ ...c, [s.sid]: c[s.sid] ?? { guest: v.payer, ok: v.ok ? 1 : 0, bad: v.ok ? 0 : 1, total: s.paymentCount, state: 'sampled' } }));
        } catch {
          // leave unchecked; the row offers "Verify all"
        }
        await sleep(VERIFY_GAP_MS);
      }
    })();
    return () => {
      alive = false;
    };
  }, [sessions, ata.data, chain]);

  const verifyAll = async (s: SessionSummary) => {
    if (!ata.data) return;
    setChecks((c) => ({ ...c, [s.sid]: { guest: c[s.sid]?.guest ?? null, ok: 0, bad: 0, total: s.paymentCount, state: 'running' } }));
    let ok = 0;
    let bad = 0;
    let guest: string | null = checksRef.current[s.sid]?.guest ?? null;
    try {
      for (const p of s.payments) {
        const v = await chain.verifyPayment(p.sig, ata.data);
        if (v.ok) ok++;
        else bad++;
        guest ??= v.payer;
        setChecks((c) => ({ ...c, [s.sid]: { guest, ok, bad, total: s.paymentCount, state: 'running' } }));
        await sleep(VERIFY_GAP_MS);
      }
      setChecks((c) => ({ ...c, [s.sid]: { guest, ok, bad, total: s.paymentCount, state: 'done' } }));
    } catch (e) {
      setChecks((c) => ({ ...c, [s.sid]: { guest, ok, bad, total: s.paymentCount, state: 'error' } }));
      console.warn('verify failed', errorMessage(e));
    }
  };

  const totalWh = sessions?.reduce((a, s) => a + s.whTotal, 0) ?? 0;
  const totalMicro = sessions?.reduce((a, s) => a + s.totalMicro, 0n) ?? 0n;
  const count = sessions?.length ?? 0;

  const exportCsv = () => {
    if (!sessions) return;
    const guests = new Map(Object.entries(checks).map(([sid, c]) => [sid, c.guest]));
    const csv = sessionsCsv(sessions, { guests, cluster: CLUSTER, mint: chain.token.mint });
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `laden-teilen-${owner.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  const kwhReg = kwhRegister(totalWh, 4);
  const earned = eurRegister(totalMicro, 3);

  return (
    <div className="dash">
      <div className="dash__head">
        <div>
          <p className="eyebrow">Owner dashboard</p>
          <h1>Earnings</h1>
          <p className="dash__owner">
            Payout wallet <AddressLink address={owner} full /> <CopyButton text={owner} />{' '}
            <a href={href('/owner/dashboard')} className="dash__change">
              Change
            </a>
          </p>
        </div>
        <button type="button" className="btn btn--ghost" onClick={exportCsv} disabled={!sessions || sessions.length === 0} data-testid="export-csv">
          Export CSV
        </button>
      </div>

      <div className="dash__totals" data-testid="dash-total" data-kwh={kwh(totalWh)} data-eur={eur(totalMicro)} data-sessions={count}>
        <div className="dash__total">
          <span className="meter__label">Energy sold</span>
          <Register digits={kwhReg.digits} unit="kWh" text={kwhReg.text} value={kwhReg.value} size="md" />
        </div>
        <div className="dash__total">
          <span className="meter__label">Earned</span>
          <Register fraction="plain" digits={earned.digits} unit="EURC" text={earned.text} value={earned.value} size="md" />
        </div>
        <div className="dash__total">
          <span className="meter__label">Sessions</span>
          <strong className="dash__count">{count}</strong>
        </div>
      </div>

      {q.error !== undefined && !sessions ? (
        <p className="notice notice--error" role="alert">
          <span>Could not read devnet history ({errorMessage(q.error)}). Retrying every 20 seconds.</span>
        </p>
      ) : !sessions ? (
        <p className="dash__loading">Reading Solana history…</p>
      ) : sessions.length === 0 ? (
        <div className="plate dash__empty" data-testid="dash-empty">
          <h2>No sessions yet</h2>
          <p>
            Open the <a href={href('/owner')}>wallbox display</a>. Every paid 0.1 kWh lands in this wallet's EURC account and shows up here.
          </p>
        </div>
      ) : (
        <div className="dash__tablewrap">
          <table className="dash__table">
            <thead>
              <tr>
                <th scope="col">Start</th>
                <th scope="col">Duration</th>
                <th scope="col" className="num">
                  Energy
                </th>
                <th scope="col" className="num">
                  Paid
                </th>
                <th scope="col">Guest</th>
                <th scope="col" className="num">
                  Payments
                </th>
                <th scope="col">Transactions</th>
                <th scope="col">Verified</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const c = checks[s.sid];
                const first = s.payments[0];
                const last = s.payments[s.payments.length - 1];
                return (
                  <tr key={s.sid} data-testid="dash-session-row" data-sid={s.sid} data-kwh={kwh(s.whTotal)} data-eur={eur(s.totalMicro)}>
                    <td data-label="Start">{dateTime(s.firstBlockTime)}</td>
                    <td data-label="Duration">{duration(s.firstBlockTime && s.lastBlockTime ? s.lastBlockTime - s.firstBlockTime : null)}</td>
                    <td data-label="Energy" className="num">
                      {kwh(s.whTotal)} kWh
                    </td>
                    <td data-label="Paid" className="num">
                      {eur(s.totalMicro)} EURC
                    </td>
                    <td data-label="Guest">{c?.guest ? <AddressLink address={c.guest} /> : <span className="muted">…</span>}</td>
                    <td data-label="Payments" className="num">
                      {s.paymentCount}
                    </td>
                    <td data-label="Transactions">
                      <span className="dash__txs">
                        <TxLink sig={first?.sig}>first</TxLink>
                        {last && last !== first && <TxLink sig={last.sig}>last</TxLink>}
                      </span>
                    </td>
                    <td data-label="Verified">
                      <span className="dash__verify">
                      {c?.state === 'done' ? (
                        <span className={c.bad ? 'verify verify--bad' : 'verify verify--ok'} data-testid="verify-result">
                          {c.bad ? `✗ ${c.bad} mismatch` : `✓ ${c.ok}/${c.total}`}
                        </span>
                      ) : c?.state === 'running' ? (
                        <span className="verify">
                          {c.ok + c.bad}/{c.total}…
                        </span>
                      ) : (
                        <>
                          {c && <span className={c.bad ? 'verify verify--bad' : 'verify verify--ok'}>{c.bad ? '✗ sample' : '✓ sample'}</span>}
                          <button type="button" className="linkbtn" onClick={() => void verifyAll(s)} data-testid="verify-btn">
                            Verify all
                          </button>
                        </>
                      )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="dash__source">
        Rebuilt from Solana {chain.kind === 'mock' ? 'MOCK ledger' : 'devnet'} history: <code>getSignaturesForAddress</code> on this wallet's EURC account
        {ata.data && (
          <>
            {' '}
            (<AddressLink address={ata.data} />)
          </>
        )}
        , then the LT1 payment memos. “Verify” checks each transfer's real token balances with <code>getTransaction</code>. No database, works on any device.
      </p>
    </div>
  );
}

export function OwnerDashboard({ params }: { params: URLSearchParams }) {
  const env = useAppEnv();
  const o = params.get('o') ?? '';
  const saved = readJson<OwnerSettings>(env.storage, OWNER_SETTINGS_KEY);
  return <SitePage current="/owner/dashboard">{isAddress(o) ? <Dashboard owner={o} /> : <Picker initial={o || saved?.owner || ''} />}</SitePage>;
}
