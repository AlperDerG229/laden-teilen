// App-wide flags from the URL. They may appear before the hash (`/?mock=1#/demo`) or inside the
// hash query (`/#/demo?mock=1&speed=60&captions=1`). On load they are normalised into the real
// query string so hash navigation keeps them.
//
// MOCK mode is never silent: it needs `?mock=1` in the URL (or VITE_MOCK_CHAIN=1 in a dev server,
// never in a production build), and the app then always shows a MOCK banner.
import { DEFAULT_SPEED, parseSpeed } from '../sim/charger-sim.ts';

export const GLOBAL_FLAGS = ['mock', 'speed', 'captions'] as const;

export interface AppFlags {
  mock: boolean;
  /** Where MOCK mode came from (for the banner). */
  mockSource: 'url' | 'dev-env' | null;
  /** Simulated delivery rate in kWh per real hour (see charger-sim.ts). */
  speed: number;
  captions: boolean;
}

interface LocationLike {
  search: string;
  hash: string;
}

const truthy = (v: string | null): boolean => v !== null && v !== '0' && v !== 'false';

function hashQuery(hash: string): URLSearchParams {
  const i = hash.indexOf('?');
  return new URLSearchParams(i >= 0 ? hash.slice(i + 1) : '');
}

export function readFlags(loc: LocationLike, env: { DEV: boolean; VITE_MOCK_CHAIN?: string }): AppFlags {
  const search = new URLSearchParams(loc.search);
  const inHash = hashQuery(loc.hash);
  const get = (name: string) => search.get(name) ?? inHash.get(name);
  const mockUrl = truthy(get('mock'));
  const mockDev = !mockUrl && env.DEV && env.VITE_MOCK_CHAIN === '1';
  return {
    mock: mockUrl || mockDev,
    mockSource: mockUrl ? 'url' : mockDev ? 'dev-env' : null,
    speed: parseSpeed(get('speed'), DEFAULT_SPEED),
    captions: truthy(get('captions')),
  };
}

/**
 * Moves global flags from the hash query into the real query string, so `#/owner` links keep
 * them: `/#/demo?mock=1&o=X` -> `/?mock=1#/demo?o=X`. Returns null when nothing changes.
 */
export function normalizeFlagsUrl(loc: LocationLike & { pathname: string }): string | null {
  const i = loc.hash.indexOf('?');
  if (i < 0) return null;
  const route = loc.hash.slice(0, i);
  const inHash = new URLSearchParams(loc.hash.slice(i + 1));
  const search = new URLSearchParams(loc.search);
  let moved = false;
  for (const name of GLOBAL_FLAGS) {
    const v = inHash.get(name);
    if (v === null) continue;
    inHash.delete(name);
    search.set(name, v);
    moved = true;
  }
  if (!moved) return null;
  const q = search.toString();
  const h = inHash.toString();
  return `${loc.pathname}${q ? `?${q}` : ''}${route}${h ? `?${h}` : ''}`;
}
