// In-process charger simulator with the same port contract as evcc / go-e. Used by the unit tests
// (injected clock) and for runs without Docker or hardware (`--charger sim`, e.g. a short demo).
import type { ChargerPort, ChargerReading } from './types.ts';

export interface SimPortOptions {
  /** Charge power in W while switched on (default 11 kW). */
  powerW?: number;
  /** Time multiplier for demos: 10 = ten times faster than real time. */
  speed?: number;
  /** The simulated car stops taking energy after this many Wh (default: never). */
  fullAtWh?: number;
  /** Seconds (simulated) between switching on and the first energy, like a car waking up. */
  startDelayS?: number;
  now?: () => number;
}

export class SimPort implements ChargerPort {
  readonly label: string;
  private readonly powerW: number;
  private readonly speed: number;
  private readonly fullAtWh: number;
  private readonly startDelayS: number;
  private readonly now: () => number;

  private on = false;
  private onSince = 0;
  private lastTick = 0;
  private wh = 0;
  private plugged = true;
  private started = false;
  /** Counts start()/stop() calls, for tests. */
  readonly calls: string[] = [];

  constructor(opts: SimPortOptions = {}) {
    this.powerW = opts.powerW ?? 11_000;
    this.speed = opts.speed ?? 1;
    this.fullAtWh = opts.fullAtWh ?? Number.POSITIVE_INFINITY;
    this.startDelayS = opts.startDelayS ?? 0;
    this.now = opts.now ?? Date.now;
    this.label = `simulated ${(this.powerW / 1000).toFixed(1)} kW charger${this.speed !== 1 ? ` (x${this.speed} speed)` : ''}`;
  }

  /** Simulates unplugging the car (the port reports connected = false). */
  unplug(): void {
    this.tick();
    this.plugged = false;
  }

  private flowing(): boolean {
    return this.on && this.plugged && this.wh < this.fullAtWh;
  }

  private tick(): void {
    const t = this.now();
    if (this.flowing()) {
      const from = Math.max(this.lastTick, this.onSince + (this.startDelayS * 1000) / this.speed);
      if (t > from) this.wh = Math.min(this.fullAtWh, this.wh + (this.powerW * ((t - from) / 1000) * this.speed) / 3600);
    }
    this.lastTick = t;
  }

  async read(): Promise<ChargerReading> {
    this.tick();
    const warmingUp = this.now() < this.onSince + (this.startDelayS * 1000) / this.speed;
    const charging = this.flowing() && !warmingUp;
    return {
      sessionWh: this.started ? this.wh : 0,
      connected: this.plugged,
      charging,
      powerW: charging ? this.powerW : 0,
      enabled: this.on,
      detail: `on=${this.on} plugged=${this.plugged} wh=${this.wh.toFixed(1)}`,
    };
  }

  async readSessionWh(): Promise<number> {
    return (await this.read()).sessionWh;
  }

  async isConnected(): Promise<boolean> {
    return this.plugged;
  }

  async start(): Promise<void> {
    this.calls.push('start');
    this.tick();
    if (!this.started) {
      this.started = true;
      this.wh = 0;
    }
    if (!this.on) {
      this.on = true;
      this.onSince = this.now();
      this.lastTick = this.onSince;
    }
  }

  async stop(): Promise<void> {
    this.calls.push('stop');
    this.tick();
    this.on = false;
  }
}
