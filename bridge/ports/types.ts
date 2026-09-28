// The energy side of the bridge: one wallbox (or energy manager loadpoint) that the bridge may
// switch on and off and whose session energy it can read. Implementations: EvccPort (evcc REST),
// GoePort (go-e HTTP API v2, untested against hardware) and SimPort (in-process simulator).
//
// The bridge never does electrical work: it only toggles the charge mode through the
// manufacturer / energy-manager API, exactly like the owner would in the evcc or go-e app.

/** One status read from the charger. */
export interface ChargerReading {
  /** Energy delivered since `start()` in Wh (0 before `start()`). Never decreases. */
  sessionWh: number;
  /** A vehicle is plugged in. */
  connected: boolean;
  /** Energy is flowing right now (as reported by the charger; may lag a few seconds). */
  charging: boolean;
  /** Present charge power in W (0 when unknown). */
  powerW: number;
  /**
   * The charger is set to charge (evcc mode `now`, go-e `frc=2`). After `start()`, false means
   * someone changed the setting outside the bridge (evcc UI, go-e app).
   */
  enabled: boolean;
  /** Short raw status for logs, e.g. `mode=now charging=true`. */
  detail: string;
}

export interface ChargerPort {
  /** Human-readable name for logs, e.g. `evcc loadpoint 2 "Garage"`. */
  readonly label: string;
  /** What switching on / off does, for logs, e.g. `POST /api/loadpoints/2/mode/now`. */
  readonly actions?: { on: string; off: string };
  /**
   * Takes the energy baseline, then allows energy to flow (evcc mode `now`, go-e `frc=2`).
   * `sessionWh` counts from this baseline.
   */
  start(): Promise<void>;
  /** Stops the energy flow (evcc mode `off`, go-e `frc=1`). Idempotent; safe before `start()`. */
  stop(): Promise<void>;
  /** Energy since `start()` in Wh. */
  readSessionWh(): Promise<number>;
  /** Whether a vehicle is plugged in. */
  isConnected?(): Promise<boolean>;
  /** Everything above in one request (the bridge loop polls this). */
  read(): Promise<ChargerReading>;
}

/** Error from a charger HTTP API (unreachable, non-2xx status, unexpected payload). */
export class ChargerApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ChargerApiError';
    this.status = opts.status;
  }
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Energy counter bookkeeping shared by the ports: converts a raw counter (evcc `chargedEnergy`,
 * go-e `wh`) into energy since the baseline. A counter that goes backwards means the charger
 * started a new plug-in session (the vehicle was unplugged and plugged in again): the tracker then
 * reports `reset = true` until the next baseline and never lets `sessionWh` decrease.
 */
export class EnergyCounter {
  private baseline: number | null = null;
  private lastRaw: number | null = null;
  private sessionWh = 0;
  private wasReset = false;

  /** Starts counting from `raw`. */
  setBaseline(raw: number): void {
    this.baseline = raw;
    this.lastRaw = raw;
    this.sessionWh = 0;
    this.wasReset = false;
  }

  get started(): boolean {
    return this.baseline !== null;
  }

  get reset(): boolean {
    return this.wasReset;
  }

  /** Feeds a raw counter value and returns the energy since the baseline. */
  update(raw: number): number {
    if (this.baseline === null) {
      this.lastRaw = raw;
      return 0;
    }
    // Tolerate tiny float jitter; a real drop means the charger reset its session counter.
    if (this.lastRaw !== null && raw < this.lastRaw - 0.5) this.wasReset = true;
    this.lastRaw = raw;
    if (!this.wasReset) this.sessionWh = Math.max(this.sessionWh, raw - this.baseline);
    return this.sessionWh;
  }
}

/** fetch with a timeout; maps transport failures and non-2xx statuses to ChargerApiError. */
export async function requestText(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit & { timeoutMs: number; what: string },
): Promise<string> {
  const { timeoutMs, what, ...rest } = init;
  let res: Response;
  try {
    res = await fetchFn(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : errorText(e);
    throw new ChargerApiError(`${what}: ${reason}`, { cause: e });
  }
  const body = await res.text().catch(() => '');
  if (!res.ok) {
    throw new ChargerApiError(`${what}: HTTP ${res.status} ${snippet(body)}`.trim(), { status: res.status });
  }
  return body;
}

export async function requestJson(fetchFn: FetchFn, url: string, init: RequestInit & { timeoutMs: number; what: string }): Promise<unknown> {
  const body = await requestText(fetchFn, url, init);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ChargerApiError(`${init.what}: response is not JSON: ${snippet(body)}`);
  }
}

const errorText = (e: unknown): string => {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? ` (${e.cause.message})` : '';
  return `${e.message}${cause}`;
};

const snippet = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
};

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Removes a trailing slash so paths can be appended. */
export const baseUrl = (url: string): string => url.replace(/\/+$/, '');
