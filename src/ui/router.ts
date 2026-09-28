// Hash routing (GitHub Pages has no rewrites): `#/charge?k=...`.
import { useSyncExternalStore } from 'react';

export interface Route {
  path: string;
  params: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const i = raw.indexOf('?');
  const path = (i >= 0 ? raw.slice(0, i) : raw) || '/';
  const params = new URLSearchParams(i >= 0 ? raw.slice(i + 1) : '');
  const clean = path.startsWith('/') ? path : `/${path}`;
  return { path: clean.length > 1 ? clean.replace(/\/+$/, '') : clean, params };
}

type Params = Record<string, string | number | null | undefined>;

/** `href('/charge', { k })` -> `#/charge?k=...` (empty values are dropped). */
export function href(path: string, params: Params = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return `#${path}${s ? `?${s}` : ''}`;
}

export function navigate(path: string, params: Params = {}): void {
  window.location.hash = href(path, params).slice(1);
}

const subscribe = (cb: () => void) => {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
};
const getHash = () => window.location.hash;

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getHash, getHash);
  return parseHash(hash);
}
