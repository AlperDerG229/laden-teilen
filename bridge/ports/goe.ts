// go-e Charger (Gemini / HOMEfix / V3 and newer) via the local HTTP API v2.
// UNTESTED against hardware: implemented from the vendor docs
// (github.com/goecharger/go-eCharger-API-v2, http-en.md + API_KEYS_FIRMWARE/apikeys-en.md).
// The HTTP API v2 must be enabled in the go-e app first.
//
//   GET /api/status?filter=wh,car,frc,alw,nrg,err   (firmware >= 051.4; older: filter=["wh","car",...])
//   GET /api/set?frc=2   -> {"frc": true}            (values are JSON-encoded; true or an error string)
//
// Keys: frc forceState (Neutral=0, Off=1, On=2) · wh "energy in Wh since car connected" ·
// car (Unknown/Error=0, Idle=1, Charging=2, WaitCar=3, Complete=4, Error=5; null on internal error) ·
// alw allowed to charge now · nrg energy array, index 11 = total power in W · err error code.
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

export interface GoePortOptions {
  /** Charger base URL on the LAN, e.g. http://192.168.0.75 */
  url: string;
  fetch?: FetchFn;
  timeoutMs?: number;
  /** Use the pre-051.4 JSON-array filter syntax. */
  legacyFilter?: boolean;
}

export const GOE_FORCE = { neutral: 0, off: 1, on: 2 } as const;
export const GOE_CAR = { unknown: 0, idle: 1, charging: 2, waitCar: 3, complete: 4, error: 5 } as const;

export interface GoeStatus {
  wh: number;
  car: number | null;
  frc: number | null;
  alw: boolean;
  powerW: number;
  err: number | null;
}

const KEYS = ['wh', 'car', 'frc', 'alw', 'nrg', 'err'];

export class GoePort implements ChargerPort {
  readonly url: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly legacyFilter: boolean;
  private readonly counter = new EnergyCounter();

  constructor(opts: GoePortOptions) {
    this.url = baseUrl(opts.url);
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.legacyFilter = opts.legacyFilter ?? false;
  }

  get label(): string {
    return `go-e charger ${this.url}`;
  }

  readonly actions = { on: 'GET /api/set?frc=2', off: 'GET /api/set?frc=1' };

  async readStatus(): Promise<GoeStatus> {
    // Sent as in the vendor docs (raw commas): the charger's HTTP server may not percent-decode.
    const filter = this.legacyFilter ? JSON.stringify(KEYS) : KEYS.join(',');
    const raw = await requestJson(this.fetchFn, `${this.url}/api/status?filter=${filter}`, {
      method: 'GET',
      timeoutMs: this.timeoutMs,
      what: 'go-e GET /api/status',
    });
    if (!isRecord(raw) || typeof raw.wh !== 'number') {
      throw new ChargerApiError(`go-e /api/status: unexpected payload ${JSON.stringify(raw)?.slice(0, 120)}`);
    }
    const nrg = Array.isArray(raw.nrg) ? raw.nrg : [];
    return {
      wh: num(raw.wh),
      car: typeof raw.car === 'number' ? raw.car : null,
      frc: typeof raw.frc === 'number' ? raw.frc : null,
      alw: raw.alw === true,
      powerW: num(nrg[11]),
      err: typeof raw.err === 'number' ? raw.err : null,
    };
  }

  async read(): Promise<ChargerReading> {
    const s = await this.readStatus();
    const sessionWh = this.counter.update(s.wh);
    const plugged = s.car === GOE_CAR.charging || s.car === GOE_CAR.waitCar || s.car === GOE_CAR.complete;
    return {
      sessionWh,
      connected: plugged && !this.counter.reset,
      charging: s.car === GOE_CAR.charging,
      powerW: s.powerW,
      enabled: s.frc === GOE_FORCE.on,
      detail: `car=${s.car} frc=${s.frc} alw=${s.alw} wh=${s.wh}${s.err ? ` err=${s.err}` : ''}`,
    };
  }

  async readSessionWh(): Promise<number> {
    return (await this.read()).sessionWh;
  }

  async isConnected(): Promise<boolean> {
    return (await this.read()).connected;
  }

  async start(): Promise<void> {
    const s = await this.readStatus();
    this.counter.setBaseline(s.wh);
    await this.setForceState(GOE_FORCE.on);
  }

  /** Force off (frc=1): the charger stays locked until the next paid session. */
  async stop(): Promise<void> {
    await this.setForceState(GOE_FORCE.off);
  }

  async setForceState(frc: number): Promise<void> {
    const answer = await requestJson(this.fetchFn, `${this.url}/api/set?frc=${frc}`, {
      method: 'GET',
      timeoutMs: this.timeoutMs,
      what: `go-e GET /api/set?frc=${frc}`,
    });
    if (!isRecord(answer) || answer.frc !== true) {
      throw new ChargerApiError(`go-e /api/set?frc=${frc} was rejected: ${JSON.stringify(answer)?.slice(0, 120)}`);
    }
  }
}
