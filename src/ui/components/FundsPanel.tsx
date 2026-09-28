// "Get test funds": everything a judge needs to fund a devnet wallet by hand in about 3 minutes.
// The app never calls the web faucets itself; the RPC airdrop is one opportunistic button.
import { useState } from 'react';
import type { Address } from '@solana/kit';
import { errorMessage } from '../../core/errors.ts';
import { useAppEnv } from '../app-context.tsx';
import { eur, sol } from '../format.ts';
import { usePolling } from '../hooks.ts';
import { CopyButton, TxLink } from './bits.tsx';
import { Modal } from './Modal.tsx';

const NEED_LAMPORTS = 10_000_000n; // 0.01 SOL
const NEED_MICRO = 1_000_000n; // 1 EURC

export function FundsPanel({ open, onClose, address, walletLabel }: { open: boolean; onClose: () => void; address: Address; walletLabel: string }) {
  const { chain } = useAppEnv();
  const symbol = chain.token.symbol;
  const mock = chain.kind === 'mock';
  const balances = usePolling(
    async () => {
      const ata = await chain.findAta(address);
      const [lamports, acc] = await Promise.all([chain.getSolBalance(address), chain.getAllowance(ata)]);
      return { lamports, micro: acc.balanceMicro, ataExists: acc.exists };
    },
    3_000,
    [chain, address],
    open,
  );
  const [drop, setDrop] = useState<{ state: 'idle' | 'busy' | 'ok' | 'error'; text?: string; sig?: string }>({ state: 'idle' });

  const requestFunds = async () => {
    setDrop({ state: 'busy' });
    try {
      const sig = await chain.requestTestFunds(address);
      setDrop({ state: 'ok', sig, text: mock ? `Added 1 SOL and 20 ${symbol} (MOCK).` : 'Airdrop requested. The balance updates in a few seconds.' });
      balances.refresh();
    } catch (e) {
      setDrop({
        state: 'error',
        text: `The RPC airdrop failed (${errorMessage(e).slice(0, 120)}). The public devnet faucet is often rate limited: use faucet.solana.com instead.`,
      });
    }
  };

  const b = balances.data;
  const solOk = b ? b.lamports >= NEED_LAMPORTS : false;
  const tokOk = b ? b.micro >= NEED_MICRO : false;

  return (
    <Modal open={open} onClose={onClose} title="Get test funds" testId="funds-panel">
      {mock ? (
        <p>
          {walletLabel} lives in this browser's <strong>MOCK ledger</strong>. A session needs at least <strong>0.01 SOL</strong> and <strong>1 {symbol}</strong>{' '}
          there; add mock funds with one click.
        </p>
      ) : (
        <p>
          {walletLabel} runs on Solana <strong>devnet</strong>. It needs at least <strong>0.01 SOL</strong> (fee deposit and network fees) and at least{' '}
          <strong>1 {symbol}</strong>. Test tokens have no value.
        </p>
      )}

      <div className="funds__address">
        <span className="eyebrow">Wallet address</span>
        <code className="funds__addr" data-testid="funds-address">
          {address}
        </code>
        <CopyButton text={address} label="Copy address" testId="copy-address" />
      </div>

      <div className="funds__balances" aria-live="polite">
        <div className={`funds__bal${solOk ? ' is-ok' : ''}`}>
          <span className="eyebrow">SOL</span>
          <strong data-testid="funds-sol">{b ? sol(b.lamports) : '…'}</strong>
          <span>{solOk ? 'enough' : 'need 0.01'}</span>
        </div>
        <div className={`funds__bal${tokOk ? ' is-ok' : ''}`}>
          <span className="eyebrow">{symbol}</span>
          <strong data-testid="funds-token">{b ? eur(b.micro) : '…'}</strong>
          <span>{tokOk ? 'enough' : 'need 1.00'}</span>
        </div>
      </div>

      {mock ? (
        <div className="funds__mock">
          <p>
            <strong>MOCK mode:</strong> the chain is simulated in this browser, so test funds are instant.
          </p>
          <button type="button" className="btn btn--block" onClick={requestFunds} disabled={drop.state === 'busy'} data-testid="mock-faucet">
            {drop.state === 'busy' ? 'Adding…' : `Add 1 SOL + 20 ${symbol} (mock)`}
          </button>
        </div>
      ) : (
        <>
          <ol className="funds__steps">
            <li>
              <h3>Devnet SOL</h3>
              <p>
                Open{' '}
                <a href="https://faucet.solana.com" target="_blank" rel="noreferrer">
                  faucet.solana.com
                </a>
                , paste the address, choose <strong>Devnet</strong> and request 0.5 SOL. Signing in with GitHub raises the limit.
              </p>
            </li>
            <li>
              <h3>Test {symbol}</h3>
              <p>
                Open{' '}
                <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
                  faucet.circle.com
                </a>
                , choose <strong>{symbol}</strong> and the network <strong>Solana Devnet</strong>, paste the address and send. Circle allows one request per
                address every couple of hours.
              </p>
            </li>
          </ol>
          <div className="funds__airdrop">
            <button type="button" className="btn btn--ghost btn--sm" onClick={requestFunds} disabled={drop.state === 'busy'}>
              {drop.state === 'busy' ? 'Requesting…' : 'Try an RPC airdrop (0.1 SOL)'}
            </button>
            <span className="muted">Often rate limited on the public devnet.</span>
          </div>
        </>
      )}
      {drop.text && (
        <p className={`notice${drop.state === 'error' ? ' notice--error' : ' notice--ok'}`} role="status">
          <span>
            {drop.text} {drop.sig && <TxLink sig={drop.sig} />}
          </span>
        </p>
      )}
      <details className="funds__phantom">
        <summary>Using Phantom instead of the demo wallet?</summary>
        <p>
          In Phantom open Settings → Developer Settings → turn on <strong>Testnet Mode</strong> and choose <strong>Solana Devnet</strong>. Then fund your Phantom
          address with the same two faucets. The app only asks Phantom to sign; it sends the transaction to devnet itself.
        </p>
      </details>
      <button type="button" className="btn btn--ghost btn--block" onClick={onClose}>
        Done
      </button>
    </Modal>
  );
}
