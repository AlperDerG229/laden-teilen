// Simulated wallbox (the ChargerPort of the kiosk). No real energy is involved.
//
// Units:
// - `powerKw` is the charging power the display shows (e.g. 11 kW).
// - `speed` is the demo delivery rate in kWh per real hour. `speed=60` means 1 kWh per minute,
//   i.e. one 0.1 kWh step every 6 s. `speed === powerKw` is real time.
//
// Pacing: the charger loop pays for a step first and only then calls deliver(). To keep a steady
// cadence of one step per 0.1 kWh at `speed` (payment time included), deliver() subtracts the
// time spent since the previous step ended (the payment) from the nominal step duration, but
// always animates for at least 30% of it.
import type { ChargerPort } from '../core/session.ts';
import { sleep as defaultSleep, type Sleep } from '../core/throttle.ts';

export const DEFAULT_POWER_KW = 11;
export const DEFAULT_SPEED = 60;
export const POWER_CHOICES_KW = [3.7, 11, 22] as const;

export interface ChargerSimSnapshot {
  plugged: boolean;
  powerKw: number;
  /** kWh per real hour. */
  speed: number;
  /** "Car full" was pressed (or the cable was unplugged) during this session. */
  full: boolean;
  /** A paid step is being delivered right now. */
  delivering: boolean;
  /** Waiting for the car to be plugged in before a paid step can be delivered. */
  waitingForPlug: boolean;
  /** Energy delivered in the current session in Wh (animated within a step). */
  sessionWh: number;
}

export interface ChargerSimOptions {
  powerKw?: number;
  speed?: number;
  plugged?: boolean;
  now?: () => number;
  sleep?: Sleep;
  /** Display update interval while delivering. */
  tickMs?: number;
}

/** Nominal real-time duration of `wh` at `speed` kWh/h, in ms. */
export const stepDurationMs = (wh: number, speed: number): number => (wh * 3_600) / speed;

/** Parses the `?speed=` value: a positive number of kWh per hour; anything else gives the default. */
export function parseSpeed(raw: string | null | undefined, fallback = DEFAULT_SPEED): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 36_000 ? n : fallback;
}

export class ChargerSim implements ChargerPort {
  /** Called once per session when the car reports full or is unplugged. */
  onFull?: () => void;

  private snap: ChargerSimSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly sleep: Sleep;
  private readonly tickMs: number;
  private lastStepEnd: number | null = null;
  private fullNotified = false;

  constructor(opts: ChargerSimOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    this.tickMs = opts.tickMs ?? 120;
    this.snap = {
      plugged: opts.plugged ?? true,
      powerKw: opts.powerKw ?? DEFAULT_POWER_KW,
      speed: opts.speed ?? DEFAULT_SPEED,
      full: false,
      delivering: false,
      waitingForPlug: false,
      sessionWh: 0,
    };
  }

  getSnapshot = (): ChargerSimSnapshot => this.snap;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Starts a new session meter (optionally at `initialWh` when a session resumes). */
  resetSession(initialWh = 0): void {
    this.lastStepEnd = null;
    this.fullNotified = false;
    this.update({ sessionWh: initialWh, full: false, delivering: false, waitingForPlug: false });
  }

  setPlugged(plugged: boolean): void {
    this.update({ plugged });
    if (!plugged) this.markFull();
  }

  setPowerKw(powerKw: number): void {
    if (powerKw > 0) this.update({ powerKw });
  }

  setSpeed(speed: number): void {
    if (speed > 0) this.update({ speed });
  }

  /** "Car full": the kiosk ends the session after the step that is already paid. */
  setFull(): void {
    this.markFull();
  }

  async deliver(wh: number): Promise<void> {
    while (!this.snap.plugged) {
      this.update({ waitingForPlug: true });
      await this.sleep(200);
    }
    const startedAt = this.now();
    const startWh = this.snap.sessionWh;
    const nominal = stepDurationMs(wh, this.snap.speed);
    const gap = this.lastStepEnd === null ? Number.POSITIVE_INFINITY : startedAt - this.lastStepEnd;
    const duration = gap < nominal ? Math.max(nominal - gap, nominal * 0.3) : nominal;
    this.update({ delivering: true, waitingForPlug: false });
    for (;;) {
      const elapsed = this.now() - startedAt;
      if (elapsed >= duration) break;
      this.update({ sessionWh: startWh + (wh * elapsed) / duration });
      await this.sleep(Math.max(1, Math.min(this.tickMs, duration - elapsed)));
    }
    this.lastStepEnd = this.now();
    this.update({ sessionWh: startWh + wh, delivering: false });
  }

  private markFull(): void {
    this.update({ full: true });
    if (this.fullNotified) return;
    this.fullNotified = true;
    try {
      this.onFull?.();
    } catch {
      // a UI callback must never break the simulator
    }
  }

  private update(patch: Partial<ChargerSimSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }
}
