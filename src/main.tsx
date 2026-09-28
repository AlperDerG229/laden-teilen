import '@fontsource-variable/source-sans-3';
import '@fontsource-variable/atkinson-hyperlegible-mono';
import './ui/styles/base.css';
import './ui/styles/components.css';
import './ui/styles/kiosk.css';
import './ui/styles/guest.css';
import './ui/styles/pages.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { createLocalStorageLedgerStore, createMemoryLedgerStore, createMockChain } from './sim/mock-chain.ts';
import type { AppEnv } from './ui/app-context.tsx';
import { createDevnetChain } from './ui/chain/devnet.ts';
import { normalizeFlagsUrl, readFlags } from './ui/env.ts';
import { appBaseUrl } from './ui/links.ts';
import { browserStorage } from './ui/storage.ts';

const flags = readFlags(window.location, import.meta.env);
const normalized = normalizeFlagsUrl(window.location);
if (normalized) window.history.replaceState(null, '', normalized);

function mockLedgerStore() {
  try {
    localStorage.setItem('lt:probe', '1');
    localStorage.removeItem('lt:probe');
    return createLocalStorageLedgerStore(localStorage);
  } catch {
    return createMemoryLedgerStore();
  }
}

// Real devnet is the default. MOCK needs ?mock=1 (or VITE_MOCK_CHAIN=1 on a dev server) and is
// always announced by a banner.
const chain = flags.mock ? createMockChain({ store: mockLedgerStore() }) : createDevnetChain();
if (flags.mock) console.warn('[laden-teilen] MOCK chain mode: nothing is sent to Solana.');

const env: AppEnv = {
  chain,
  flags,
  baseUrl: appBaseUrl(window.location.origin, import.meta.env.BASE_URL),
  storage: browserStorage,
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App env={env} />
  </StrictMode>,
);
