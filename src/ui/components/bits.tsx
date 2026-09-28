// Small shared pieces: status LED, explorer links, addresses, copy button, checks.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useChain } from '../app-context.tsx';
import { shortAddr } from '../format.ts';

export type LedTone = 'waiting' | 'charging' | 'ending' | 'done' | 'error' | 'idle';

export function Led({ tone, children, testId, state, light }: { tone: LedTone; children: ReactNode; testId?: string; state?: string; light?: boolean }) {
  return (
    <span className={`led led--${tone}${light ? ' led--light' : ''}`} data-testid={testId} data-state={state} role="status">
      <i className="led__dot" aria-hidden="true" />
      {children}
    </span>
  );
}

/** "view on explorer" for a transaction; in MOCK mode a clearly marked label instead of a link. */
export function TxLink({ sig, children }: { sig: string | null | undefined; children?: ReactNode }) {
  const chain = useChain();
  if (!sig) return null;
  const url = chain.explorerTxUrl(sig);
  if (!url) {
    return (
      <span className="txlink txlink--mock" title="MOCK transaction: it exists only in this browser" data-sig={sig}>
        mock tx {sig.slice(0, 6)}…
      </span>
    );
  }
  return (
    <a className="txlink" href={url} target="_blank" rel="noreferrer" data-sig={sig}>
      {children ?? 'view on explorer'}
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}

export function CopyButton({ text, label = 'Copy', testId }: { text: string; label?: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      window.prompt('Copy this:', text);
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" className="copy" onClick={copy} data-testid={testId} aria-live="polite">
      {copied ? 'Copied' : label}
    </button>
  );
}

/** Short address + explorer link (+ optional copy). */
export function AddressLink({ address, full, copy }: { address: string; full?: boolean; copy?: boolean }) {
  const chain = useChain();
  const url = chain.explorerAddressUrl(address);
  const text = full ? address : shortAddr(address);
  return (
    <span className="addr">
      {url ? (
        <a className="addr__value" href={url} target="_blank" rel="noreferrer" title={address}>
          {text}
        </a>
      ) : (
        <span className="addr__value" title={address}>
          {text}
        </span>
      )}
      {copy && <CopyButton text={address} />}
    </span>
  );
}

export function Check({ ok, children, testId }: { ok: boolean; children: ReactNode; testId?: string }) {
  return (
    <div className="check" data-testid={testId} data-ok={ok}>
      <span className={`check__mark${ok ? '' : ' check__mark--open'}`} aria-hidden="true">
        {ok ? '✓' : '!'}
      </span>
      <span>{children}</span>
    </div>
  );
}
