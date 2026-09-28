import { useEffect, useState, type ReactNode } from 'react';
import { useAppEnv } from '../app-context.tsx';
import { href } from '../router.ts';

export const REPO_URL = 'https://github.com/AlperDerG229/laden-teilen';

export function Wordmark({ to = '/' }: { to?: string }) {
  return (
    <a className="wordmark" href={href(to)}>
      <span className="wordmark__mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      Laden teilen
    </a>
  );
}

export function SiteHeader({ current }: { current?: string }) {
  const { chain } = useAppEnv();
  const link = (path: string, label: string, cls?: string) => (
    <a href={href(path)} aria-current={current === path ? 'page' : undefined} className={cls}>
      {label}
    </a>
  );
  return (
    <header className="site-header">
      <Wordmark />
      <nav className="site-nav" aria-label="Main">
        {link('/how', 'How it works')}
        {link('/owner', 'For owners', 'hide-sm')}
        {link('/demo', 'Demo')}
        <span className="net-tag" title={chain.kind === 'mock' ? 'Simulated chain' : 'Solana devnet'}>
          {chain.kind === 'mock' ? 'Mock' : 'Devnet'}
        </span>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <p>
        <strong>Devnet prototype with a simulated charger. No real energy is sold and the tokens have no value.</strong> Production requires an
        eichrechtskonforme wallbox, a MID meter plus a signed meter-value chain.
      </p>
      <div className="site-footer__links">
        <a href={href('/how')}>How it works</a>
        <a href={href('/owner')}>Set up a wallbox</a>
        <a href={href('/owner/dashboard')}>Owner dashboard</a>
        <a href={REPO_URL} target="_blank" rel="noreferrer">
          Source on GitHub
        </a>
        <a href={`${REPO_URL}#development-history`} target="_blank" rel="noreferrer">
          Development history
        </a>
      </div>
    </footer>
  );
}

export function SitePage({ current, children, className }: { current?: string; children: ReactNode; className?: string }) {
  return (
    <>
      <SiteHeader current={current} />
      <main className={`page${className ? ` ${className}` : ''}`}>{children}</main>
      <SiteFooter />
    </>
  );
}

export function MockBanner({ source }: { source: 'url' | 'dev-env' }) {
  const exit = (() => {
    if (typeof window === 'undefined') return '#';
    const u = new URL(window.location.href);
    u.searchParams.delete('mock');
    return u.toString();
  })();
  return (
    <div className="mock-banner" role="note" data-testid="mock-banner">
      <strong>MOCK</strong>
      <span>
        Simulated chain<span className="mock-banner__long">: nothing is sent to Solana, transactions exist only in this browser</span>.
      </span>
      {source === 'url' ? <a href={exit}>Use devnet</a> : <span>(VITE_MOCK_CHAIN=1)</span>}
    </div>
  );
}

declare global {
  interface Window {
    /** Demo recorder hook: sets the caption bar text ('' hides it). */
    __caption?: (text: string) => void;
  }
}

export function CaptionBar({ enabled }: { enabled: boolean }) {
  const [text, setText] = useState('');
  useEffect(() => {
    window.__caption = (t: string) => setText(String(t ?? ''));
    return () => {
      delete window.__caption;
    };
  }, []);
  if (!enabled && !text) return null;
  return (
    <div className="caption-bar" data-testid="caption" aria-live="polite">
      {text}
    </div>
  );
}
