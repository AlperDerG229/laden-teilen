// Adapter between core's ChargerSession, which thinks in discrete paid steps ("deliver 100 Wh"),
// and a real charger that delivers energy continuously once it is switched on.
//
// Pull before deliver, one step ahead:
//   - The first deliver() call comes after pay #1 has confirmed; only then is the charger switched on.
//   - After that, deliver() hands control back to ChargerSession (which pulls the next step) as soon
//     as the metered energy comes within `leadWh` of the paid energy. With the default lead of one
//     step, the paid energy stays one step ahead of the meter: evcc books energy in coarse chunks
//     (every ~9 s in demo mode, every `interval` = 30 s by default), so a smaller lead would let
//     unpaid energy flow between two meter updates. Bound: paid - metered <= step + lead (2 steps by
//     default) right after a pull.
//
// Stopping. Like core's ChargerSession.stop() ("a step that is already paid is still delivered
// first"), the energy that is already paid for is delivered before the charger is switched off
// ("drain") when the session ends because of the guest's token account (cap / funds / revoked), the
// session key's SOL budget, or an operator stop. Charger-side stops (car unplugged or full, mode
// changed in the evcc UI, charger unreachable) and errors switch off at once: the energy cannot be
// delivered anyway. skipDrain() (the operator's second Ctrl+C) switches off at once as well.
//
// The ChargerChain decorator withMeteredEnd() sequences the shutdown before settlement: the end tx is
// only sent after the charger is off and the meter has settled, and its memo carries the metered
// energy (integer Wh) instead of ChargerSession's step count. Pay memos keep `whCum` = paid energy.
import type { EndReason } from '../src/core/memo.ts';
import type { ChargerChain, ChargerPort as CoreChargerPort } from '../src/core/session.ts';
import { errorMessage } from '../src/core/errors.ts';
import { sleep as defaultSleep, type Sleep } from '../src/core/throttle.ts';
import type { ChargerPort, ChargerReading } from './ports/types.ts';

/** Chain-side end reasons after which the energy that is already paid for is still delivered. */
export const DRAIN_REASONS: ReadonlySet<EndReason> = new Set<EndReason>(['cap', 'funds', 'revoked', 'sol']);

export interface StopCause {
  reason: EndReason;
  message: string;
  /** Deliver the energy that is already paid for before switching off. */
  drain: boolean;
}

export type MeterEvent =
  | { type: 'on' }
  | { type: 'reading'; reading: ChargerReading; paidWh: number; meteredWh: number }
  | { type: 'pull-due'; paidWh: number; meteredWh: number }
  | { type: 'stop-request'; reason: EndReason; message: string; drain: boolean }
  | { type: 'ending'; reason: EndReason; drain: boolean }
  | { type: 'drain'; paidWh: number; meteredWh: number }
  | { type: 'drain-stopped'; message: string }
  | { type: 'off'; ok: boolean; error?: string }
  | { type: 'final'; meteredWh: number; paidWh: number }
  | { type: 'warning'; message: string };

export interface MeteredChargerOptions {
  port: ChargerPort;
  /** Energy per paid step in Wh (must match ChargerSession's stepWh). */
  stepWh: number;
  /** Pull the next step when metered >= paid - leadWh. Default: one step. */
  leadWh?: number;
  /** Charger polling interval while charging. */
  pollMs?: number;
  /** End with 'full' when no energy flowed (and the charger did not report charging) for this long. */
  idleTimeoutMs?: number;
  /** End with 'error' after this many consecutive failed charger reads. */
  maxReadFailures?: number;
  /** Upper bound for delivering already-paid energy when a session ends. */
  drainTimeoutMs?: number;
  /** Upper bound for waiting until the meter stops moving after switching off. */
  settleTimeoutMs?: number;
  sleep?: Sleep;
  now?: () => number;
  onEvent?: (e: MeterEvent) => void;
}

const START_ATTEMPTS = 3;
const STOP_ATTEMPTS = 3;

export class MeteredCharger implements CoreChargerPort {
  readonly port: ChargerPort;
  readonly stepWh: number;
  readonly leadWh: number;

  private readonly pollMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxReadFailures: number;
  private readonly drainTimeoutMs: number;
  private readonly settleTimeoutMs: number;
  private readonly sleep: Sleep;
  private readonly now: () => number;
  private readonly onEvent: (e: MeterEvent) => void;
  /** Aborted by requestStop(): wakes a pending deliver() at once. */
  private readonly wake = new AbortController();
  /** Aborted by skipDrain(): ends a drain at once. */
  private readonly drainWake = new AbortController();

  private session: { stop(reason: EndReason): void } | null = null;
  private paid = 0;
  private metered = 0;
  private startAttempted = false;
  private started = false;
  private ending = false;
  private finishing: Promise<number> | null = null;
  private cause: StopCause | null = null;
  private lastProgressAt = 0;
  private readFailures = 0;
  private lastReadError = '';
  private disconnectedReads = 0;
  private disabledReads = 0;
  private lastReading: ChargerReading | null = null;

  constructor(opts: MeteredChargerOptions) {
    if (!(opts.stepWh > 0)) throw new Error('stepWh must be positive');
    this.port = opts.port;
    this.stepWh = opts.stepWh;
    this.leadWh = opts.leadWh ?? opts.stepWh;
    if (!(this.leadWh >= 0)) throw new Error('leadWh must not be negative');
    this.pollMs = opts.pollMs ?? 2_000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
    this.maxReadFailures = opts.maxReadFailures ?? 5;
    this.drainTimeoutMs = opts.drainTimeoutMs ?? 180_000;
    this.settleTimeoutMs = opts.settleTimeoutMs ?? 30_000;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    this.onEvent = opts.onEvent ?? (() => {});
  }

  /** Energy paid for so far (steps whose payment confirmed). */
  get paidWh(): number {
    return this.paid;
  }

  /** Highest metered session energy seen so far. */
  get meteredWh(): number {
    return this.metered;
  }

  get switchedOn(): boolean {
    return this.started;
  }

  get stopCause(): StopCause | null {
    return this.cause;
  }

  get reading(): ChargerReading | null {
    return this.lastReading;
  }

  /** The session to stop when the charger side ends the session (unplug, idle, errors). */
  bindSession(session: { stop(reason: EndReason): void }): void {
    this.session = session;
  }

  /**
   * Single entry point for stopping (operator Ctrl+C, demo limits, unplug, ...): records the cause,
   * stops the ChargerSession and wakes the polling loop so a pending deliver() returns at once.
   * With `drain`, the energy that is already paid for is still delivered before switching off.
   */
  requestStop(reason: EndReason, message: string, opts: { drain?: boolean } = {}): void {
    if (this.cause) return;
    this.cause = { reason, message, drain: opts.drain ?? false };
    this.emit({ type: 'stop-request', reason, message, drain: this.cause.drain });
    this.session?.stop(reason);
    this.wake.abort();
  }

  /** Switch off without delivering the rest of the paid energy (operator's second Ctrl+C). */
  skipDrain(): void {
    this.drainWake.abort();
  }

  /** Called by ChargerSession after each confirmed payment. Resolves when the next pull is due. */
  async deliver(wh: number): Promise<void> {
    this.paid += wh;
    if (this.cause || this.ending) return;
    if (!this.started) {
      await this.switchOn();
      if (this.cause) return;
    }
    for (;;) {
      const reading = await this.poll();
      if (reading) {
        const trigger = this.chargerTrigger(reading);
        if (trigger) this.requestStop(trigger.reason, trigger.message);
      } else if (this.readFailures >= this.maxReadFailures) {
        this.requestStop('error', `charger unreachable after ${this.readFailures} attempts: ${this.lastReadError}`);
      }
      if (this.cause) return;
      if (reading && this.metered >= this.paid - this.leadWh) {
        this.emit({ type: 'pull-due', paidWh: this.paid, meteredWh: this.metered });
        return;
      }
      await this.sleep(this.pollMs, this.wake.signal);
      if (this.cause) return;
    }
  }

  /**
   * Finishes the energy side before settlement: delivers the energy that is already paid for (see
   * the header), switches the charger off and waits for the final meter value.
   * Idempotent (ChargerSession retries the end tx); resolves with the metered session energy in Wh.
   */
  finish(reason: EndReason): Promise<number> {
    this.ending = true;
    this.finishing ??= this.doFinish(reason);
    return this.finishing;
  }

  private async doFinish(reason: EndReason): Promise<number> {
    const wanted = this.cause ? this.cause.drain : DRAIN_REASONS.has(reason);
    const drain = wanted && this.metered < this.paid;
    this.emit({ type: 'ending', reason, drain });
    // A stop that arrived while pay #1 was confirming: the step is paid, so switch on to deliver it.
    if (drain && !this.startAttempted) await this.switchOn().catch((e: unknown) => this.emit({ type: 'warning', message: errorMessage(e) }));
    if (!this.startAttempted) return this.metered;
    if (drain && this.started) await this.drain();
    await this.switchOff();
    await this.settle();
    if (this.lastReading?.charging) {
      this.emit({ type: 'warning', message: `${this.port.label} still reports charging after it was switched off; check the charger` });
    }
    this.emit({ type: 'final', meteredWh: this.metered, paidWh: this.paid });
    return this.metered;
  }

  private async switchOn(): Promise<void> {
    this.startAttempted = true;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.port.start();
        break;
      } catch (e) {
        if (attempt >= START_ATTEMPTS) throw e; // ChargerSession ends with 'error' (and refunds)
        this.emit({ type: 'warning', message: `could not switch the charger on (${attempt}/${START_ATTEMPTS}): ${errorMessage(e)}` });
        await this.sleep(1_000, this.wake.signal);
        if (this.cause) return;
      }
    }
    this.started = true;
    this.lastProgressAt = this.now();
    this.emit({ type: 'on' });
  }

  private async switchOff(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= STOP_ATTEMPTS; attempt++) {
      try {
        await this.port.stop();
        this.emit({ type: 'off', ok: true });
        return;
      } catch (e) {
        lastError = e;
        if (attempt < STOP_ATTEMPTS) await this.sleep(1_000);
      }
    }
    this.emit({ type: 'off', ok: false, error: errorMessage(lastError) });
  }

  /** Delivers the energy that is already paid for (guest-favourable: until the meter reaches it). */
  private async drain(): Promise<void> {
    this.emit({ type: 'drain', paidWh: this.paid, meteredWh: this.metered });
    const deadline = this.now() + this.drainTimeoutMs;
    const stopped = (message: string) => this.emit({ type: 'drain-stopped', message });
    for (;;) {
      if (this.drainWake.signal.aborted) return stopped('skipped by the operator');
      if (this.now() >= deadline) return stopped(`timeout after ${Math.round(this.drainTimeoutMs / 1000)} s`);
      const reading = await this.poll();
      if (this.metered >= this.paid) return;
      if (reading) {
        const trigger = this.chargerTrigger(reading);
        if (trigger) return stopped(trigger.message);
      } else if (this.readFailures >= this.maxReadFailures) {
        return stopped(`charger unreachable after ${this.readFailures} attempts: ${this.lastReadError}`);
      }
      await this.sleep(this.pollMs, this.drainWake.signal);
    }
  }

  /** After switching off, evcc still books the last seconds of energy: wait until the meter is stable. */
  private async settle(): Promise<void> {
    const deadline = this.now() + this.settleTimeoutMs;
    let previous = this.metered;
    let stableReads = 0;
    while (this.now() < deadline) {
      await this.sleep(this.pollMs);
      const r = await this.poll();
      if (!r) continue;
      const quiet = !r.charging && r.powerW === 0 && this.metered === previous;
      stableReads = quiet ? stableReads + 1 : 0;
      previous = this.metered;
      if (stableReads >= 2) return;
    }
  }

  /** One charger read; returns null (and counts the failure) when it fails. */
  private async poll(): Promise<ChargerReading | null> {
    let r: ChargerReading;
    try {
      r = await this.port.read();
    } catch (e) {
      this.readFailures++;
      this.lastReadError = errorMessage(e);
      this.emit({ type: 'warning', message: `charger read failed (${this.readFailures}/${this.maxReadFailures}): ${errorMessage(e)}` });
      return null;
    }
    this.readFailures = 0;
    if (r.sessionWh > this.metered + 1e-9 || r.charging) this.lastProgressAt = this.now();
    this.metered = Math.max(this.metered, r.sessionWh);
    this.lastReading = r;
    this.emit({ type: 'reading', reading: r, paidWh: this.paid, meteredWh: this.metered });
    return r;
  }

  /** Charger-side stop conditions while switched on (unplugged, switched off elsewhere, no energy). */
  private chargerTrigger(r: ChargerReading): { reason: EndReason; message: string } | null {
    if (!this.started) return null;
    // Two consecutive reads, so a single glitch in the charger status does not end a session.
    this.disconnectedReads = r.connected ? 0 : this.disconnectedReads + 1;
    this.disabledReads = r.enabled ? 0 : this.disabledReads + 1;
    if (this.disconnectedReads >= 2) return { reason: 'full', message: 'vehicle unplugged' };
    if (this.disabledReads >= 2) return { reason: 'user', message: 'charging was switched off outside the bridge (evcc / charger app)' };
    if (this.now() - this.lastProgressAt >= this.idleTimeoutMs) {
      return { reason: 'full', message: `no energy for ${Math.round(this.idleTimeoutMs / 1000)} s (vehicle full or not charging)` };
    }
    return null;
  }

  private emit(e: MeterEvent): void {
    try {
      this.onEvent(e);
    } catch {
      // A faulty logger must never break the charging loop.
    }
  }
}

/**
 * Wraps a ChargerChain so that the end tx is only sent after the charger side has finished
 * (drain, switch off, settle) and so that the end memo reports the metered energy.
 */
export function withMeteredEnd(chain: ChargerChain, charger: MeteredCharger): ChargerChain {
  return {
    findStartTx: (session) => chain.findStartTx(session),
    getAllowance: (guestAta) => chain.getAllowance(guestAta),
    getSolBalance: (address) => chain.getSolBalance(address),
    getRentExemptMinimum: (bytes) => chain.getRentExemptMinimum(bytes),
    pay: (req) => chain.pay(req),
    async end(req) {
      const meteredWh = await charger.finish(req.reason);
      return chain.end({ ...req, whTotal: Math.floor(meteredWh) });
    },
  };
}
