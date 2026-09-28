import { describe, expect, it } from 'vitest';
import { EvccPort } from './evcc.ts';
import { ChargerApiError, EnergyCounter, type FetchFn } from './types.ts';

// Loadpoint shapes as observed from evcc 0.316.1 `--demo` (docs/bridge.md). The full state has
// ~100 keys per loadpoint; the fake keeps the ones the port reads plus a few others.
interface FakeLp {
  title: string;
  mode: string;
  connected: boolean;
  charging: boolean;
  enabled: boolean;
  chargePower: number;
  chargedEnergy: number;
  vehicleTitle: string;
  phasesActive: number;
}

const demoLoadpoints = (): FakeLp[] => [
  { title: 'Carport', mode: 'smart', connected: true, charging: true, enabled: true, chargePower: 3220, chargedEnergy: 8.065, vehicleTitle: 'blue e-Golf', phasesActive: 3 },
  { title: 'Garage', mode: 'off', connected: true, charging: false, enabled: false, chargePower: 0, chargedEnergy: 145.271, vehicleTitle: 'white Model 3', phasesActive: 3 },
];

const PROJECTION = '{title,mode,connected,charging,chargePower,chargedEnergy,vehicleTitle}';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/** Fake evcc HTTP API with the status codes and bodies observed live. */
function fakeEvcc(opts: { jq?: boolean; wrapResult?: boolean; loadpoints?: FakeLp[] } = {}) {
  const loadpoints = opts.loadpoints ?? demoLoadpoints();
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchFn: FetchFn = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url: input, headers: { ...(init?.headers as Record<string, string> | undefined) } });
    if (method === 'GET' && url.pathname === '/api/state') {
      const jq = url.searchParams.get('jq');
      if (jq !== null) {
        if (opts.jq === false) return json({ error: 'unknown parameter' }, 400);
        const m = /^\.loadpoints\[(\d+)\] \| (.*)$/.exec(jq);
        if (!m || m[2] !== PROJECTION) return json({ error: `unsupported filter in fake: ${jq}` }, 400);
        const lp = loadpoints[Number(m[1])];
        const pick = (k: keyof FakeLp) => (lp ? lp[k] : null);
        return json({
          title: pick('title'),
          mode: pick('mode'),
          connected: pick('connected'),
          charging: pick('charging'),
          chargePower: pick('chargePower'),
          chargedEnergy: pick('chargedEnergy'),
          vehicleTitle: pick('vehicleTitle'),
        });
      }
      const state = { version: '0.316.1', demoMode: true, interval: 3, loadpoints };
      return json(opts.wrapResult ? { result: state } : state);
    }
    const mode = /^\/api\/loadpoints\/(\d+)\/mode\/([a-z]+)$/.exec(url.pathname);
    if (method === 'POST' && mode) {
      const lp = loadpoints[Number(mode[1]) - 1];
      if (!lp) return new Response('404 page not found\n', { status: 404 });
      if (!['off', 'now', 'minpv', 'pv', 'smart'].includes(mode[2])) return json({ error: `invalid value: ${mode[2]}` }, 400);
      lp.mode = mode[2];
      lp.enabled = mode[2] !== 'off';
      return json(opts.wrapResult ? { result: mode[2] } : mode[2]);
    }
    return new Response('404 page not found\n', { status: 404 });
  };
  return { fetchFn, calls, loadpoints };
}

describe('EvccPort', () => {
  it('reads one loadpoint through a jq filter and maps the evcc keys', async () => {
    const evcc = fakeEvcc();
    const port = new EvccPort({ url: 'http://127.0.0.1:7070/', loadpoint: 2, fetch: evcc.fetchFn });
    const r = await port.read();
    expect(evcc.calls[0].method).toBe('GET');
    expect(new URL(evcc.calls[0].url).searchParams.get('jq')).toBe(`.loadpoints[1] | ${PROJECTION}`);
    expect(r).toMatchObject({ sessionWh: 0, connected: true, charging: false, powerW: 0, enabled: false });
    expect(r.detail).toContain('chargedEnergy=145.271 Wh');
    expect(port.label).toBe('evcc loadpoint 2 "Garage"');
    expect(evcc.calls[0].headers.Authorization).toBeUndefined();
  });

  it('start() takes the chargedEnergy baseline, then switches to mode now; sessionWh counts from there', async () => {
    const evcc = fakeEvcc();
    const port = new EvccPort({ url: 'http://127.0.0.1:7070', loadpoint: 2, fetch: evcc.fetchFn });
    await port.start();
    const post = evcc.calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('http://127.0.0.1:7070/api/loadpoints/2/mode/now');
    const lp = evcc.loadpoints[1];
    expect(lp.mode).toBe('now');
    // chargedEnergy is in Wh and keeps counting within the plug-in session (observed: 145.271 -> 172.869).
    lp.charging = true;
    lp.chargePower = 11040;
    lp.chargedEnergy = 172.869;
    const r = await port.read();
    expect(r.sessionWh).toBeCloseTo(27.598, 3);
    expect(r).toMatchObject({ enabled: true, charging: true, powerW: 11040, connected: true });
    expect(await port.readSessionWh()).toBeCloseTo(27.598, 3);
    await port.stop();
    expect(lp.mode).toBe('off');
    expect((await port.read()).enabled).toBe(false);
  });

  it('treats a chargedEnergy drop (new plug-in session) as unplugged and never reports less energy', async () => {
    const evcc = fakeEvcc();
    const port = new EvccPort({ url: 'http://127.0.0.1:7070', loadpoint: 2, fetch: evcc.fetchFn });
    await port.start();
    evcc.loadpoints[1].chargedEnergy = 300;
    expect((await port.read()).sessionWh).toBeCloseTo(154.729, 3);
    evcc.loadpoints[1].chargedEnergy = 3; // evcc reset the session counter after a re-plug
    const r = await port.read();
    expect(r.connected).toBe(false);
    expect(r.sessionWh).toBeCloseTo(154.729, 3);
    expect(await port.isConnected()).toBe(false);
  });

  it('reports connected = false when evcc says so', async () => {
    const evcc = fakeEvcc();
    evcc.loadpoints[1].connected = false;
    const port = new EvccPort({ url: 'http://127.0.0.1:7070', loadpoint: 2, fetch: evcc.fetchFn });
    expect(await port.isConnected()).toBe(false);
  });

  it('falls back to the full state when the jq filter is rejected, also with the legacy {result} wrapper', async () => {
    const evcc = fakeEvcc({ jq: false, wrapResult: true });
    const port = new EvccPort({ url: 'http://evcc.local:7070', loadpoint: 1, fetch: evcc.fetchFn });
    const r = await port.read();
    expect(r).toMatchObject({ charging: true, powerW: 3220, enabled: false });
    await port.read();
    // First read: jq (400) + full state; afterwards only the full state.
    expect(evcc.calls.map((c) => new URL(c.url).search)).toEqual([expect.stringContaining('jq='), '', '']);
    await port.start(); // legacy {"result": "now"} echo is accepted
    expect(evcc.loadpoints[0].mode).toBe('now');
  });

  it('explains an unknown loadpoint id', async () => {
    const evcc = fakeEvcc();
    const port = new EvccPort({ url: 'http://127.0.0.1:7070', loadpoint: 7, fetch: evcc.fetchFn });
    await expect(port.read()).rejects.toThrow('evcc has no loadpoint 7');
    await expect(port.stop()).rejects.toMatchObject({ name: 'ChargerApiError', status: 404 });
    expect(() => new EvccPort({ url: 'http://x', loadpoint: 0 })).toThrow('1 or higher');
  });

  it('surfaces evcc error bodies, e.g. an invalid mode', async () => {
    const evcc = fakeEvcc();
    const port = new EvccPort({ url: 'http://127.0.0.1:7070', loadpoint: 2, fetch: evcc.fetchFn });
    const err = await port.setMode('turbo' as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChargerApiError);
    expect((err as ChargerApiError).status).toBe(400);
    expect((err as Error).message).toBe('evcc POST mode/turbo: HTTP 400 {"error":"invalid value: turbo"}');
  });

  it('rejects an unexpected mode echo', async () => {
    const fetchFn: FetchFn = async () => new Response('"off"', { status: 200 });
    const port = new EvccPort({ url: 'http://127.0.0.1:7070', loadpoint: 2, fetch: fetchFn });
    await expect(port.setMode('now')).rejects.toThrow('unexpected answer "off"');
  });

  it('sends the optional evcc_ API key as a Bearer token', async () => {
    const evcc = fakeEvcc();
    const port = new EvccPort({ url: 'http://127.0.0.1:7070', loadpoint: 2, apiKey: 'evcc_testkey', fetch: evcc.fetchFn });
    await port.start();
    expect(evcc.calls.length).toBeGreaterThanOrEqual(2);
    for (const c of evcc.calls) expect(c.headers.Authorization).toBe('Bearer evcc_testkey');
  });

  it('maps network failures and timeouts to ChargerApiError', async () => {
    const refused: FetchFn = async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:7070') });
    };
    const port = new EvccPort({ url: 'http://127.0.0.1:7070', loadpoint: 1, fetch: refused });
    await expect(port.read()).rejects.toThrow('evcc GET /api/state: fetch failed (connect ECONNREFUSED 127.0.0.1:7070)');

    const hanging: FetchFn = (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    const slow = new EvccPort({ url: 'http://127.0.0.1:7070', loadpoint: 1, fetch: hanging, timeoutMs: 20 });
    await expect(slow.read()).rejects.toThrow('timed out after 20 ms');
  });
});

describe('EnergyCounter', () => {
  it('counts from the baseline, ignores float jitter and flags a counter reset', () => {
    const c = new EnergyCounter();
    expect(c.update(50)).toBe(0); // before the baseline
    c.setBaseline(100);
    expect(c.update(150.5)).toBeCloseTo(50.5);
    expect(c.update(150.2)).toBeCloseTo(50.5); // jitter below 0.5 Wh is not a reset
    expect(c.reset).toBe(false);
    expect(c.update(2)).toBeCloseTo(50.5);
    expect(c.reset).toBe(true);
    c.setBaseline(2);
    expect(c.reset).toBe(false);
    expect(c.update(12)).toBe(10);
  });
});
