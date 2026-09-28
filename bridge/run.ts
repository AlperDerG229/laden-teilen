// One bridge charging session: ChargerSession (core) + MeteredCharger (continuous charger) + logs.
// Used by the CLI for every combination of charger (evcc / go-e / sim) and chain (mock / devnet).
import type { Address, KeyPairSigner } from '@solana/kit';
import { formatMicro, formatSol, stepMicro } from '../src/core/amounts.ts';
import { TOKEN } from '../src/core/config.ts';
import type { EndReason } from '../src/core/memo.ts';
import { ChargerSession, type ChargerChain, type PaymentEvent, type SessionResult } from '../src/core/session.ts';
import { MeteredCharger, withMeteredEnd } from './metered.ts';
import type { ChargerPort } from './ports/types.ts';

export const REASON_TEXT: Readonly<Record<EndReason, string>> = {
  user: 'stopped by the operator',
  revoked: 'the guest revoked the allowance',
  cap: "the guest's spending cap is used up",
  funds: "the guest's token balance is used up",
  full: 'vehicle full or unplugged',
  sol: "the session key's fee budget is used up",
  error: 'error',
};

export interface Logger {
  (line?: string): void;
  readonly transcript: string[];
}

export function createLogger(opts: { timestamps?: boolean } = {}): Logger {
  const transcript: string[] = [];
  const log = ((line = '') => {
    const stamped = opts.timestamps === false || line === '' ? line : `${new Date().toTimeString().slice(0, 8)}  ${line}`;
    transcript.push(stamped);
    console.log(stamped);
  }) as Logger;
  Object.defineProperty(log, 'transcript', { value: transcript });
  return log;
}

export interface BridgeRunOptions {
  port: ChargerPort;
  chain: ChargerChain;
  sessionKey: KeyPairSigner;
  owner: Address;
  priceMicroPerKWh: bigint;
  stepWh: number;
  leadWh: number;
  pollMs: number;
  idleTimeoutMs: number;
  /** Operator stop once this much energy was metered (demo runs). */
  stopAfterWh?: number;
  /** Formats a tx signature for the log (explorer link on devnet, plain `mock:` label otherwise). */
  sigLink: (sig: string) => string;
  log: Logger;
  onPayment?: (p: PaymentEvent) => void;
}

/** Charger-side facts collected during the run (for the smoke assertions and the report). */
export interface BridgeRunStats {
  switchedOn: boolean;
  switchedOff: boolean | null;
  paidWh: number;
  meteredWh: number;
  /** Largest (metered - paid) seen while charging; > 0 means energy flowed before it was paid. */
  maxUnpaidWh: number;
  meterReadings: number;
  drained: boolean;
}

export class BridgeRun {
  readonly metered: MeteredCharger;
  readonly session: ChargerSession;
  readonly stats: BridgeRunStats = {
    switchedOn: false,
    switchedOff: null,
    paidWh: 0,
    meteredWh: 0,
    maxUnpaidWh: Number.NEGATIVE_INFINITY,
    meterReadings: 0,
    drained: false,
  };

  private readonly o: BridgeRunOptions;
  private charging = true;
  private lastLoggedWh = 0;

  constructor(o: BridgeRunOptions) {
    this.o = o;
    const { log } = o;
    const unit = TOKEN.symbol;
    this.metered = new MeteredCharger({
      port: o.port,
      stepWh: o.stepWh,
      leadWh: o.leadWh,
      pollMs: o.pollMs,
      idleTimeoutMs: o.idleTimeoutMs,
      onEvent: (e) => {
        switch (e.type) {
          case 'on':
            this.stats.switchedOn = true;
            log(`${o.port.label}: switched ON${o.port.actions ? ` (${o.port.actions.on})` : ''}`);
            break;
          case 'reading': {
            this.stats.meterReadings++;
            this.stats.meteredWh = e.meteredWh;
            if (this.charging && this.stats.switchedOn) {
              this.stats.maxUnpaidWh = Math.max(this.stats.maxUnpaidWh, e.meteredWh - e.paidWh);
            }
            // Log when the meter moved (evcc books energy every few seconds), not on every poll.
            if (this.stats.switchedOn && e.meteredWh - this.lastLoggedWh >= 0.05) {
              this.lastLoggedWh = e.meteredWh;
              const kw = (e.reading.powerW / 1000).toFixed(1);
              log(`meter ${e.meteredWh.toFixed(1).padStart(6)} Wh   ${kw} kW   paid ${e.paidWh} Wh`);
            }
            if (o.stopAfterWh !== undefined && e.meteredWh >= o.stopAfterWh) {
              this.metered.requestStop('user', `demo limit of ${o.stopAfterWh} Wh reached`, { drain: true });
            }
            break;
          }
          case 'pull-due':
            log(`meter ${e.meteredWh.toFixed(1)} Wh >= paid ${e.paidWh} Wh - lead ${this.metered.leadWh} Wh -> pull the next step`);
            break;
          case 'stop-request':
            this.charging = false;
            log(`stop requested: ${e.reason} (${e.message})`);
            break;
          case 'drain-stopped':
            log(`stopped delivering the paid energy: ${e.message}`);
            break;
          case 'ending':
            this.charging = false;
            log(`ending: ${e.reason} (${REASON_TEXT[e.reason]})`);
            break;
          case 'drain':
            this.charging = false;
            this.stats.drained = true;
            log(`delivering the energy already paid for: metered ${e.meteredWh.toFixed(1)} of ${e.paidWh} Wh`);
            break;
          case 'off':
            this.charging = false;
            this.stats.switchedOff = e.ok;
            log(
              e.ok
                ? `${o.port.label}: switched OFF${o.port.actions ? ` (${o.port.actions.off})` : ''}`
                : `!! could not switch ${o.port.label} off: ${e.error}. SWITCH IT OFF MANUALLY.`,
            );
            break;
          case 'final':
            this.stats.paidWh = e.paidWh;
            this.stats.meteredWh = e.meteredWh;
            log(`final meter reading: ${e.meteredWh.toFixed(1)} Wh delivered, ${e.paidWh} Wh paid`);
            break;
          case 'warning':
            log(`warning: ${e.message}`);
            break;
        }
      },
    });

    this.session = new ChargerSession({
      session: o.sessionKey,
      owner: o.owner,
      priceMicroPerKWh: o.priceMicroPerKWh,
      stepWh: o.stepWh,
      chain: withMeteredEnd(o.chain, this.metered),
      charger: this.metered,
    });
    this.metered.bindSession(this.session);

    const s = this.session;
    s.on('state', (state) => {
      if (state === 'WAITING_FOR_GUEST') log(`waiting for the guest's start transaction (session ${s.sid})`);
    });
    s.on('guest', (g) =>
      log(
        `guest ${g.guest.slice(0, 8)}... approved ${formatMicro(g.capMicro)} ${unit}, deposit ${formatSol(g.depositLamports)} SOL   ${o.sigLink(g.sig)}`,
      ),
    );
    s.on('payment', (p) => {
      this.stats.paidWh = p.seq * o.stepWh;
      log(`pay #${p.seq}   ${formatMicro(p.amountMicro)} ${unit}   paid ${p.whCum} Wh   ${o.sigLink(p.sig)}`);
      o.onPayment?.(p);
    });
    s.on('error', (e) => log(`${e.fatal ? 'error' : 'warning'}: ${e.message}`));
  }

  /** Stops the session gracefully: optionally deliver the paid energy, switch off, end tx, refund. */
  requestStop(reason: EndReason, message: string, opts: { drain?: boolean } = {}): void {
    this.metered.requestStop(reason, message, opts);
  }

  /** Switch off now instead of delivering the rest of the paid energy. */
  skipDrain(): void {
    this.metered.skipDrain();
  }

  async start(): Promise<SessionResult> {
    const { log, stepWh, priceMicroPerKWh } = this.o;
    log(`price ${formatMicro(priceMicroPerKWh)} ${TOKEN.symbol}/kWh · step ${stepWh} Wh = ${formatMicro(stepMicro(priceMicroPerKWh, stepWh))} ${TOKEN.symbol} · lead ${this.metered.leadWh} Wh`);
    let result: SessionResult;
    try {
      result = await this.session.start();
    } finally {
      // Safety net: whatever happened, never leave a charger running that the bridge switched on.
      if (this.metered.switchedOn && this.stats.switchedOff !== true) await this.metered.finish('error');
    }
    const unit = TOKEN.symbol;
    const refund = result.refundLamports === null ? 'no refund tx' : `refund ${formatSol(result.refundLamports)} SOL`;
    log(
      `session ended: ${result.reason} (${REASON_TEXT[result.reason]}) · ${result.payments} payments · ` +
        `${formatMicro(result.totalMicro)} ${unit} · metered ${this.stats.meteredWh.toFixed(1)} Wh · ${refund}` +
        (result.endSig ? `   ${this.o.sigLink(result.endSig)}` : ''),
    );
    if (result.error) log(`note: ${result.error}`);
    return result;
  }
}
