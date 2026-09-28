// evcc (https://evcc.io) energy manager as the charger: the bridge switches one loadpoint between
// mode `now` and `off` and meters the session with the loadpoint's `chargedEnergy` (Wh).
//
// Verified live against evcc 0.316.1 in demo mode (docs/bridge.md):
//   GET  /api/state                          -> 200, the state object (no `result` wrapper), ~94 KB
//   GET  /api/state?jq=<filter>              -> 200, the filtered value; 400 {"error":...} on a bad filter
//   POST /api/loadpoints/{id}/mode/{mode}    -> 200 "now" | "off"; 400 {"error":"invalid value: turbo"};
//                                               404 for an unknown loadpoint id (ids are 1-based)
// Loadpoint keys used: mode, connected, charging, chargePower (W), chargedEnergy (Wh), title,
// vehicleTitle. `chargedEnergy` keeps counting across mode toggles within one plug-in session, so
// the port meters against a baseline taken at start().
//
// Auth: in evcc 0.316.1 `/api/state` and the loadpoint mode route are public (no login), also
// outside demo mode. An API key (`evcc_...`) is optional and sent as `Authorization: Bearer ...`
// (useful behind a reverse proxy that requires it); evcc ignores it on public routes.
import {
  ChargerApiError,
  EnergyCounter,
  baseUrl,
  isRecord,
  num,
  requestJson,
  type ChargerPort,
  type ChargerReading,
  type FetchFn,
} from './types.ts';

export interface EvccPortOptions {
  /** evcc base URL, e.g. http://127.0.0.1:7070 */
  url: string;
  /** Loadpoint id as in `/api/loadpoints/{id}` (1-based, like the evcc UI order). */
  loadpoint: number;
  /** Optional evcc API key (`evcc_...`), sent as a Bearer token. */
  apiKey?: string;
  fetch?: FetchFn;
  timeoutMs?: number;
}

export type EvccMode = 'off' | 'now' | 'minpv' | 'pv' | 'smart';

/** The loadpoint fields the bridge reads. */
export interface EvccLoadpoint {
  title: string;
  mode: string;
  connected: boolean;
  charging: boolean;
  chargePower: number;
  chargedEnergy: number;
  vehicleTitle: string;
}

const FIELDS = 'title,mode,connected,charging,chargePower,chargedEnergy,vehicleTitle';

export class EvccPort implements ChargerPort {
  readonly url: string;
  readonly loadpoint: number;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly counter = new EnergyCounter();
  /** null until the first read; false after a 400 on `?jq=` (older evcc): then the full state is read. */
  private jqSupported: boolean | null = null;
  private title = '';

  constructor(opts: EvccPortOptions) {
    if (!Number.isSafeInteger(opts.loadpoint) || opts.loadpoint < 1) {
      throw new Error(`evcc loadpoint id must be 1 or higher (got ${opts.loadpoint})`);
    }
    this.url = baseUrl(opts.url);
    this.loadpoint = opts.loadpoint;
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.headers = opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {};
  }

  get label(): string {
    return `evcc loadpoint ${this.loadpoint}${this.title ? ` "${this.title}"` : ''}`;
  }

  get actions(): { on: string; off: string } {
    return { on: `POST /api/loadpoints/${this.loadpoint}/mode/now`, off: `POST /api/loadpoints/${this.loadpoint}/mode/off` };
  }

  /** Reads the loadpoint (one small request thanks to evcc's jq filter). */
  async readLoadpoint(): Promise<EvccLoadpoint> {
    const index = this.loadpoint - 1;
    let raw: unknown;
    if (this.jqSupported !== false) {
      try {
        raw = await this.get(`/api/state?jq=${encodeURIComponent(`.loadpoints[${index}] | {${FIELDS}}`)}`);
        this.jqSupported = true;
      } catch (e) {
        if (!(e instanceof ChargerApiError) || e.status !== 400 || this.jqSupported === true) throw e;
        this.jqSupported = false;
      }
    }
    if (this.jqSupported === false) {
      const state = await this.get('/api/state');
      // evcc < 0.200 wrapped the state in {"result": ...}.
      const root = isRecord(state) && isRecord(state.result) ? state.result : state;
      const loadpoints = isRecord(root) && Array.isArray(root.loadpoints) ? root.loadpoints : [];
      raw = loadpoints[index] ?? null;
    }
    const lp = parseLoadpoint(raw);
    if (!lp) throw new ChargerApiError(`evcc has no loadpoint ${this.loadpoint} (check --loadpoint; ids are 1-based)`);
    this.title = lp.title;
    return lp;
  }

  /** evcc version and demo flag (for the startup log). */
  async readInfo(): Promise<{ version: string; demoMode: boolean }> {
    let raw: unknown;
    try {
      raw = await this.get(`/api/state?jq=${encodeURIComponent('{version,demoMode}')}`);
    } catch (e) {
      if (!(e instanceof ChargerApiError) || e.status !== 400) throw e;
      const state = await this.get('/api/state');
      raw = isRecord(state) && isRecord(state.result) ? state.result : state;
    }
    const info = isRecord(raw) ? raw : {};
    return { version: typeof info.version === 'string' ? info.version : 'unknown', demoMode: info.demoMode === true };
  }

  async read(): Promise<ChargerReading> {
    const lp = await this.readLoadpoint();
    const sessionWh = this.counter.update(lp.chargedEnergy);
    const connected = lp.connected && !this.counter.reset;
    return {
      sessionWh,
      connected,
      charging: lp.charging,
      powerW: lp.chargePower,
      enabled: lp.mode === 'now',
      detail: `mode=${lp.mode} connected=${lp.connected} charging=${lp.charging} chargedEnergy=${lp.chargedEnergy} Wh`,
    };
  }

  async readSessionWh(): Promise<number> {
    return (await this.read()).sessionWh;
  }

  async isConnected(): Promise<boolean> {
    return (await this.read()).connected;
  }

  async start(): Promise<void> {
    const lp = await this.readLoadpoint();
    this.counter.setBaseline(lp.chargedEnergy);
    await this.setMode('now');
  }

  async stop(): Promise<void> {
    await this.setMode('off');
  }

  /** POST /api/loadpoints/{id}/mode/{mode}; evcc answers with the new mode as a JSON string. */
  async setMode(mode: EvccMode): Promise<void> {
    const answer = await requestJson(this.fetchFn, `${this.url}/api/loadpoints/${this.loadpoint}/mode/${mode}`, {
      method: 'POST',
      headers: this.headers,
      timeoutMs: this.timeoutMs,
      what: `evcc POST mode/${mode}`,
    });
    // evcc 0.316 echoes "now"; older versions wrapped it as {"result": "now"}.
    const echoed = isRecord(answer) ? answer.result : answer;
    if (echoed !== mode) throw new ChargerApiError(`evcc POST mode/${mode}: unexpected answer ${JSON.stringify(answer)}`);
  }

  private get(path: string): Promise<unknown> {
    return requestJson(this.fetchFn, `${this.url}${path}`, {
      method: 'GET',
      headers: this.headers,
      timeoutMs: this.timeoutMs,
      what: `evcc GET ${path.split('?')[0]}`,
    });
  }
}

function parseLoadpoint(raw: unknown): EvccLoadpoint | null {
  if (!isRecord(raw) || typeof raw.mode !== 'string') return null;
  return {
    title: typeof raw.title === 'string' ? raw.title : '',
    mode: raw.mode,
    connected: raw.connected === true,
    charging: raw.charging === true,
    chargePower: num(raw.chargePower),
    chargedEnergy: num(raw.chargedEnergy),
    vehicleTitle: typeof raw.vehicleTitle === 'string' ? raw.vehicleTitle : '',
  };
}
