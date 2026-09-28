import { ATA_PROGRAM, MEMO_PROGRAM, SYSTEM_PROGRAM, TOKEN, TOKEN_PROGRAM } from '../../core/config.ts';
import { useAppEnv } from '../app-context.tsx';
import { AddressLink } from '../components/bits.tsx';
import { REPO_URL, SitePage } from '../components/chrome.tsx';
import { href } from '../router.ts';

/** Sequence diagram of the four transaction types between the three parties. */
function TxDiagram() {
  const lanes = [
    { x: 150, title: 'Guest wallet', sub: 'phone' },
    { x: 480, title: 'Session key', sub: 'wallbox display, new per session' },
    { x: 810, title: 'Owner wallet', sub: 'payout' },
  ];
  return (
    <figure className="txd">
      <svg viewBox="0 0 960 440" role="img" aria-labelledby="txd-title txd-desc" className="txd__svg">
        <title id="txd-title">The four transactions of a session</title>
        <desc id="txd-desc">
          Start: the guest sends a SOL fee deposit and approves a spending cap for the session key. Pay: before every 0.1 kWh the session key moves 0.039 EURC
          from the guest to the owner. Stop: the guest revokes the approval. End: the session key writes the final memo and refunds the remaining SOL.
        </desc>
        <defs>
          <marker id="arr-ink" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" className="txd__head txd__head--ink" />
          </marker>
          <marker id="arr-sol" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" className="txd__head txd__head--sol" />
          </marker>
          <marker id="arr-eur" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" className="txd__head txd__head--eur" />
          </marker>
        </defs>
        {lanes.map((l) => (
          <g key={l.title}>
            <rect x={l.x - 125} y={14} width={250} height={58} rx={4} className="txd__lane" />
            <text x={l.x} y={40} className="txd__lane-title" textAnchor="middle">
              {l.title}
            </text>
            <text x={l.x} y={60} className="txd__lane-sub" textAnchor="middle">
              {l.sub}
            </text>
            <line x1={l.x} y1={72} x2={l.x} y2={430} className="txd__life" />
          </g>
        ))}
        {/* start */}
        <text x={20} y={118} className="txd__step">
          1 start
        </text>
        <line x1={150} y1={112} x2={474} y2={112} className="txd__arrow txd__arrow--sol" markerEnd="url(#arr-sol)" />
        <text x={315} y={102} className="txd__label" textAnchor="middle">
          0.005 SOL fee deposit
        </text>
        <line x1={150} y1={140} x2={474} y2={140} className="txd__arrow" markerEnd="url(#arr-ink)" strokeDasharray="6 5" />
        <text x={315} y={160} className="txd__label" textAnchor="middle">
          ApproveChecked: cap, e.g. 5 EURC
        </text>
        {/* pay */}
        <text x={20} y={228} className="txd__step">
          2 pay #n
        </text>
        <line x1={150} y1={222} x2={804} y2={222} className="txd__arrow txd__arrow--eur" markerEnd="url(#arr-eur)" />
        <text x={640} y={212} className="txd__label" textAnchor="middle">
          0.039 EURC per 0.1 kWh
        </text>
        <circle cx={480} cy={222} r={7} className="txd__dot" />
        <text x={480} y={250} className="txd__label" textAnchor="middle">
          signed by the session key as delegate, before the energy flows
        </text>
        {/* stop */}
        <text x={20} y={318} className="txd__step">
          3 stop
        </text>
        <path d="M150 300 h70 v28 h-64" className="txd__arrow" markerEnd="url(#arr-ink)" fill="none" />
        <text x={236} y={318} className="txd__label">
          Revoke (optional, by the guest)
        </text>
        {/* end */}
        <text x={20} y={398} className="txd__step">
          4 end
        </text>
        <line x1={480} y1={392} x2={156} y2={392} className="txd__arrow txd__arrow--sol" markerEnd="url(#arr-sol)" />
        <text x={315} y={382} className="txd__label" textAnchor="middle">
          refund of the unused SOL
        </text>
        <text x={315} y={414} className="txd__label" textAnchor="middle">
          memo LT1|end|… with kWh, EURC and reason
        </text>
      </svg>
      <figcaption className="txd__legend">
        <span>
          <i className="swatch swatch--eur" /> EURC
        </span>
        <span>
          <i className="swatch swatch--sol" /> SOL
        </span>
        <span>
          <i className="swatch swatch--ink" /> approval
        </span>
        <span>Every transaction also carries an LT1 memo.</span>
      </figcaption>
    </figure>
  );
}

export function How() {
  const { chain } = useAppEnv();
  const programs = [
    { name: 'System Program', address: SYSTEM_PROGRAM, use: 'SOL fee deposit (start) and refund (end)' },
    { name: 'SPL Token', address: TOKEN_PROGRAM, use: 'ApproveChecked, TransferChecked, Revoke' },
    { name: 'Associated Token Account', address: ATA_PROGRAM, use: "Creates the owner's EURC account with the first payment" },
    { name: 'Memo (v2)', address: MEMO_PROGRAM, use: 'LT1 session memos, readable on any explorer' },
    { name: `${TOKEN.symbol} mint (devnet)`, address: TOKEN.mint, use: `Circle ${TOKEN.symbol}, ${TOKEN.decimals} decimals` },
  ];
  return (
    <SitePage current="/how" className="how">
      <header className="how__intro">
        <p className="eyebrow">How it works</p>
        <h1>Four transactions, no custom program, no backend.</h1>
        <p className="how__lead">
          A session uses only Solana's standard programs. The wallbox display holds a fresh key that the guest allows to spend up to a cap. It pulls a payment
          before every 0.1 kWh and ends by refunding what is left of the fee deposit. The chain history is both the message bus and the database.
        </p>
      </header>

      <section className="how__section">
        <h2>The transactions</h2>
        <TxDiagram />
        <div className="how__txlist">
          <article>
            <h3>1 · start (guest signs)</h3>
            <p>
              One approval: <code>System.transfer</code> of 0.005 SOL to the session key, <code>Token.ApproveChecked</code> for the cap with the session key as
              delegate, and the start memo.
            </p>
          </article>
          <article>
            <h3>2 · pay #n (session key signs)</h3>
            <p>
              <code>Token.TransferChecked</code> of one step from the guest's EURC account to the owner's, signed by the session key as delegate, plus the pay
              memo. Pay #1 also creates the owner's token account if needed. The energy is delivered only after the payment confirmed.
            </p>
          </article>
          <article>
            <h3>3 · stop (guest signs, optional)</h3>
            <p>
              <code>Token.Revoke</code> plus the stop memo. Only the owner of a token account can revoke; the delegate cannot.
            </p>
          </article>
          <article>
            <h3>4 · end (session key signs)</h3>
            <p>The end memo with total kWh, EURC and the reason, and a transfer of the session key's entire remaining SOL back to the guest. The key is then discarded.</p>
          </article>
        </div>
      </section>

      <section className="how__section">
        <h2>Program IDs</h2>
        <div className="how__tablewrap">
          <table className="how__table">
            <thead>
              <tr>
                <th scope="col">Program</th>
                <th scope="col">Address</th>
                <th scope="col">Used for</th>
              </tr>
            </thead>
            <tbody>
              {programs.map((p) => (
                <tr key={p.address}>
                  <td>{p.name}</td>
                  <td>{chain.kind === 'mock' ? <code>{p.address}</code> : <AddressLink address={p.address} full />}</td>
                  <td>{p.use}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted">Cluster: Solana devnet. No custom on-chain program is deployed.</p>
      </section>

      <section className="how__section">
        <h2>Memo format</h2>
        <pre className="how__memo">
          <code>{`LT1|start|<sid>|<priceMicroPerKWh>|<capMicro>
LT1|pay|<sid>|<n>|<whCumulative>|<stepMicro>
LT1|stop|<sid>
LT1|end|<sid>|<whTotal>|<totalMicro>|<reason>`}</code>
        </pre>
        <ul className="how__list">
          <li>
            <code>sid</code> is the first 8 base58 characters of the session public key.
          </li>
          <li>Amounts are integers in micro-EURC (10⁻⁶). At 0.39 EUR/kWh the price is 390000 and one 100 Wh step is 39000, that is 0.039 EURC.</li>
          <li>
            <code>reason</code> is one of <code>user</code>, <code>revoked</code>, <code>cap</code>, <code>funds</code>, <code>full</code>, <code>sol</code>,{' '}
            <code>error</code>.
          </li>
          <li>Memos are claims. The dashboard's “Verify” checks the real token balance changes of each payment.</li>
        </ul>
      </section>

      <section className="how__section how__trust">
        <h2>Trust model</h2>
        <dl className="how__defs">
          <div>
            <dt>Pull before deliver</dt>
            <dd>The wallbox is paid for each 0.1 kWh before it delivers it. With an honest wallbox the guest is never more than one step (about €0.04) ahead.</dd>
          </div>
          <div>
            <dt>The cap is the worst case</dt>
            <dd>Like a card pre-authorisation: even a dishonest wallbox cannot take more than the approved cap. The money stays in the guest's wallet until it is used.</dd>
          </div>
          <div>
            <dt>A fresh key per session</dt>
            <dd>The display creates a new key for every session and discards it at the end. The guest can revoke at any time; the key can never revoke or raise its own allowance.</dd>
          </div>
          <div>
            <dt>One approval per token account</dt>
            <dd>An SPL token account has a single delegate, so a new approval replaces the previous one. The guest page warns before that happens.</dd>
          </div>
          <div>
            <dt>The display must stay online</dt>
            <dd>It is the side that pulls payments. If it reloads, it resumes the session from the chain, or ends it and refunds the fee deposit.</dd>
          </div>
          <div>
            <dt>QR codes can be swapped</dt>
            <dd>The guest page shows the payout address before any approval. Roadmap: an owner-signed charger registry on-chain.</dd>
          </div>
        </dl>
      </section>

      <section className="how__section how__law" data-testid="eichrecht">
        <h2>Metering law (Eichrecht)</h2>
        <ul className="how__list">
          <li>
            <strong>Devnet prototype with a simulated charger. No real energy is sold and the tokens have no value.</strong>
          </li>
          <li>Pricing is per kWh on purpose, because kWh is the unit German metering law expects.</li>
          <li>Production requires an eichrechtskonforme wallbox, a MID meter plus a signed meter-value chain.</li>
          <li>
            Flat or time-based pricing is not a way around this: the{' '}
            <a href="https://www.eichamt.sachsen.de/elektromobilitaet.html" target="_blank" rel="noreferrer">
              Eichamt Sachsen
            </a>{' '}
            states that neither flat-rate billing nor billing by parking time is permitted for charging points in commercial use.
          </li>
          <li>
            Roadmap: anchor each signed meter reading (OCMF payload hash) in the pay memo. This yields a public, tamper-evident receipt that the guest can check
            with the PTB-approved transparency software.
          </li>
        </ul>
        <p className="muted">This is not legal advice.</p>
      </section>

      <section className="how__section">
        <h2>Where it fits</h2>
        <blockquote className="how__quote">
          DeCharge sells chargers. Stromnachbar sends PayPal links. Laden teilen turns the wallbox you already own into a pay-per-kWh charger with one QR code and
          one wallet approval, settled in EURC every 0.1 kWh.
        </blockquote>
        <dl className="how__defs">
          <div>
            <dt>DeCharge</dt>
            <dd>
              A Solana EV-charging network with its own hardware and USDC/USDT payments, including peer-to-peer home charging with Wallbox in the US. Laden teilen is
              software-only for the wallbox you already own, euro-first with EURC, and holds no funds.
            </dd>
          </div>
          <div>
            <dt>Stromnachbar</dt>
            <dd>
              Wallbox sharing for neighbours in Germany. Its billing plan costs €59 a year and does not process payments: hosts share PayPal or bank details. Here,
              settlement is the product: instant, no chasing, no subscription, receipts on-chain.
            </dd>
          </div>
          <div>
            <dt>Share&amp;Charge (2017)</dt>
            <dd>Peer-to-peer charging on Ethereum in Germany. Fees at the time made per-step settlement impossible, and it needed an app. Laden teilen needs only a browser and a wallet.</dd>
          </div>
        </dl>
      </section>

      <section className="how__section how__next">
        <h2>Next</h2>
        <p>
          An evcc bridge for real wallboxes, signed Eichrecht-compliant meter readings anchored on-chain, an owner-signed charger registry and mainnet EURC. See
          the{' '}
          <a href={`${REPO_URL}#development-history`} target="_blank" rel="noreferrer">
            development history
          </a>{' '}
          and the{' '}
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            source code
          </a>
          , or <a href={href('/demo')}>try the demo</a>.
        </p>
      </section>
    </SitePage>
  );
}
