// Kiosk / charger state machine (spec 6.2): IDLE -> WAITING_FOR_GUEST -> CHARGING -> ENDING -> IDLE.
// Chain access and the charger are injected, so the loop runs against mocks in unit tests,
// against Kit + devnet in the browser kiosk and in scripts/e2e-session.ts.
//
// Invariant: pull before deliver. Energy for step n is only delivered after payment n confirmed.
import type { Address, KeyPairSigner } from '@solana/kit';
import { stepMicro as priceStep } from './amounts.ts';
import type { Allowance, StartInfo } from './chain.ts';
import {
  MIN_DEPOSIT_LAMPORTS,
  MIN_SOL_BUDGET_LAMPORTS,
  POLL_INTERVAL_MS,
  STEP_WH,
  TOKEN_ACCOUNT_SIZE,
} from './config.ts';
import { errorMessage, isRetryableChainError } from './errors.ts';
import { sidOf, type EndReason } from './memo.ts';
import { sleep as defaultSleep, type Sleep } from './throttle.ts';

export type ChargerState = 'IDLE' | 'WAITING_FOR_GUEST' | 'CHARGING' | 'ENDING';

export interface PayRequest {
  session: KeyPairSigner;
  owner: Address;
  guestAta: Address;
  amountMicro: bigint;
  seq: number;
  whCum: number;
  sid: string;
  createOwnerAta: boolean;
}

export interface EndRequest {
  session: KeyPairSigner;
  guest: Address;
  sid: string;
  whTotal: number;
  totalMicro: bigint;
  reason: EndReason;
}

/** Chain port used by the charger loop. `createChargerChain(client)` in chain.ts implements it with Kit. */
export interface ChargerChain {
  findStartTx(session: Address): Promise<StartInfo | null>;
  getAllowance(guestAta: Address): Promise<Allowance>;
  getSolBalance(address: Address): Promise<bigint>;
  /** Rent-exempt minimum for an account with `bytes` of data (queried from the cluster, may be cached). */
  getRentExemptMinimum(bytes: number): Promise<bigint>;
  /** Sends pay #seq (TransferChecked as delegate + memo). Resolves with the confirmed signature. */
  pay(req: PayRequest): Promise<string>;
  /** Sends the end memo and sweeps all session-key lamports back to the guest. */
  end(req: EndRequest): Promise<{ sig: string; refundLamports: bigint }>;
}

/** The energy side (simulator, evcc bridge, ...). */
export interface ChargerPort {
  /** Delivers `wh` watt-hours; resolves once delivered. Only called after the step is paid. */
  deliver(wh: number): Promise<void>;
}

/** Progress restored after a kiosk reload (e.g. rebuilt from listSessionPayments). */
export interface ResumeState {
  start: StartInfo;
  payments: number;
  whDelivered: number;
  totalMicro: bigint;
}

export interface PaymentEvent {
  seq: number;
  sig: string;
  amountMicro: bigint;
  whCum: number;
  totalMicro: bigint;
}

export interface DeliveredEvent {
  seq: number;
  wh: number;
  whDelivered: number;
}

export interface SessionResult {
  reason: EndReason;
  sid: string;
  guest: Address | null;
  payments: number;
  whDelivered: number;
  totalMicro: bigint;
  /** null when no end tx was needed (stopped before a guest arrived) or when it failed. */
  endSig: string | null;
  refundLamports: bigint | null;
  error?: string;
}

export interface ChargerErrorEvent {
  message: string;
  /** true when the session cannot continue normally (it still tries to end and refund). */
  fatal: boolean;
  cause: unknown;
}

export type ChargerEvents = {
  state: [ChargerState];
  guest: [StartInfo];
  payment: [PaymentEvent];
  delivered: [DeliveredEvent];
  ended: [SessionResult];
  error: [ChargerErrorEvent];
};

export interface ChargerSessionOptions {
  /** Fresh per-session key: the delegate that pulls payments and pays its own fees. */
  session: KeyPairSigner;
  /** Owner wallet receiving the payments (its ATA is created idempotently in pay #1). */
  owner: Address;
  priceMicroPerKWh: bigint;
  chain: ChargerChain;
  charger: ChargerPort;
  stepWh?: number;
  pollIntervalMs?: number;
  minSolBudgetLamports?: bigint;
  minDepositLamports?: bigint;
  resume?: ResumeState;
  sleep?: Sleep;
}

const MAX_CONSECUTIVE_READ_FAILURES = 5;
const END_ATTEMPTS = 3;

type Listener<K extends keyof ChargerEvents> = (...args: ChargerEvents[K]) => void;
type AnyListener = (...args: unknown[]) => void;

/**
 * One charging session for one session key. Single use: after `start()` resolves the state is
 * IDLE again and the kiosk creates a new ChargerSession with a new key.
 */
export class ChargerSession {
  readonly sid: string;
  readonly stepMicro: bigint;
  readonly stepWh: number;

  private readonly opts: ChargerSessionOptions;
  private readonly pollIntervalMs: number;
  private readonly minSolBudget: bigint;
  private readonly minDeposit: bigint;
  private readonly sleep: Sleep;
  private readonly wake = new AbortController();
  private readonly listeners = new Map<keyof ChargerEvents, Set<AnyListener>>();

  private currentState: ChargerState = 'IDLE';
  private started = false;
  private stopReason: EndReason | null = null;
  private guest: StartInfo | null = null;
  private seq = 0;
  private whDelivered = 0;
  private totalMicro = 0n;
  private endResult: SessionResult | null = null;

  constructor(opts: ChargerSessionOptions) {
    this.opts = opts;
    this.stepWh = opts.stepWh ?? STEP_WH;
    this.stepMicro = priceStep(opts.priceMicroPerKWh, this.stepWh);
    if (this.stepMicro <= 0n) throw new Error('Price per step must be positive');
    this.sid = sidOf(opts.session.address);
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.minSolBudget = opts.minSolBudgetLamports ?? MIN_SOL_BUDGET_LAMPORTS;
    this.minDeposit = opts.minDepositLamports ?? MIN_DEPOSIT_LAMPORTS;
    this.sleep = opts.sleep ?? defaultSleep;
    if (opts.resume) {
      this.seq = opts.resume.payments;
      this.whDelivered = opts.resume.whDelivered;
      this.totalMicro = opts.resume.totalMicro;
    }
  }

  get state(): ChargerState {
    return this.currentState;
  }

  get progress(): { guest: StartInfo | null; payments: number; whDelivered: number; totalMicro: bigint } {
    return { guest: this.guest, payments: this.seq, whDelivered: this.whDelivered, totalMicro: this.totalMicro };
  }

  get result(): SessionResult | null {
    return this.endResult;
  }

  /** Subscribes to an event; returns an unsubscribe function. */
  on<K extends keyof ChargerEvents>(event: K, cb: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    const listener = cb as unknown as AnyListener;
    set.add(listener);
    return () => set.delete(listener);
  }

  /**
   * Requests the end of the session ('user' = kiosk stop button, 'full' = car full / unplugged).
   * A step that is already paid is still delivered first. The first stop reason wins.
   */
  stop(reason: EndReason = 'user'): void {
    this.stopReason ??= reason;
    this.wake.abort();
  }

  /** Runs the whole session and resolves with its result (also emitted as 'ended'). */
  async start(): Promise<SessionResult> {
    if (this.started) throw new Error('ChargerSession is single use; create a new one per session key');
    this.started = true;

    const guest = this.opts.resume ? this.opts.resume.start : await this.waitForGuest();
    if (!guest) return this.finish({ reason: this.stopReason ?? 'user', endSig: null, refundLamports: null });
    this.guest = guest;

    this.setState('CHARGING');
    this.emit('guest', guest);

    let reason: EndReason;
    const problem = this.validateStart(guest);
    if (problem) {
      this.emitError(new Error(problem), true);
      reason = 'error';
    } else {
      try {
        reason = await this.chargeLoop(guest);
      } catch (e) {
        this.emitError(e, true);
        reason = 'error';
      }
    }
    return this.endSession(guest, reason, problem);
  }

  private async waitForGuest(): Promise<StartInfo | null> {
    this.setState('WAITING_FOR_GUEST');
    for (;;) {
      const stopping = this.stopReason !== null;
      try {
        // One more look after a stop request: a guest who already paid the deposit gets refunded.
        const found = await this.opts.chain.findStartTx(this.opts.session.address);
        if (found) return found;
      } catch (e) {
        this.emitError(e, false);
      }
      if (stopping) return null;
      await this.sleep(this.pollIntervalMs, this.wake.signal);
    }
  }

  private validateStart(g: StartInfo): string | null {
    if (g.sid !== this.sid) return `Start tx is for session ${g.sid}, expected ${this.sid}`;
    if (g.priceMicroPerKWh !== this.opts.priceMicroPerKWh) {
      return `Start tx price ${g.priceMicroPerKWh} does not match the wallbox price ${this.opts.priceMicroPerKWh} (micro-EURC/kWh)`;
    }
    if (g.capMicro < this.stepMicro) return `Spending cap ${g.capMicro} is below one step (${this.stepMicro})`;
    if (g.depositLamports < this.minDeposit) return `Fee deposit ${g.depositLamports} lamports is below ${this.minDeposit}`;
    return null;
  }

  /** Stop trigger from the guest's token account, or null when another step may be pulled. */
  private allowanceStop(a: Allowance, g: StartInfo): EndReason | null {
    if (a.delegate !== this.opts.session.address) {
      // The token program clears the delegate when the allowance reaches exactly 0.
      return g.capMicro - this.totalMicro < this.stepMicro ? 'cap' : 'revoked';
    }
    if (a.delegatedMicro < this.stepMicro) return 'cap';
    if (a.balanceMicro < this.stepMicro) return 'funds';
    return null;
  }

  private async chargeLoop(g: StartInfo): Promise<EndReason> {
    const { chain, charger, session, owner } = this.opts;
    let readFailures = 0;
    for (;;) {
      if (this.stopReason) return this.stopReason;

      let allowance: Allowance;
      let spendable: bigint;
      let needed: bigint;
      try {
        allowance = await chain.getAllowance(g.guestAta);
        const balance = await chain.getSolBalance(session.address);
        const reserve = await chain.getRentExemptMinimum(0);
        // Pay #1 also creates the owner's token account; its rent comes out of the deposit.
        const ataRent = this.seq === 0 ? await chain.getRentExemptMinimum(TOKEN_ACCOUNT_SIZE) : 0n;
        spendable = balance - reserve;
        needed = this.minSolBudget + ataRent;
        readFailures = 0;
      } catch (e) {
        if (++readFailures >= MAX_CONSECUTIVE_READ_FAILURES) {
          this.emitError(e, true);
          return 'error';
        }
        this.emitError(e, false);
        await this.sleep(this.pollIntervalMs, this.wake.signal);
        continue;
      }

      const blocked = this.allowanceStop(allowance, g);
      if (blocked) return blocked;
      if (spendable < needed) return 'sol';
      if (this.stopReason) return this.stopReason;

      const seq = this.seq + 1;
      const whCum = seq * this.stepWh;
      let sig: string;
      try {
        sig = await this.payWithRetry({
          session,
          owner,
          guestAta: g.guestAta,
          amountMicro: this.stepMicro,
          seq,
          whCum,
          sid: this.sid,
          createOwnerAta: seq === 1,
        });
      } catch (e) {
        this.emitError(e, false);
        // Usually a race with the guest (revoke / spent funds): label it from fresh chain state.
        return (await this.classifyFailedPull(g)) ?? 'error';
      }
      this.seq = seq;
      this.totalMicro += this.stepMicro;
      this.emit('payment', { seq, sig, amountMicro: this.stepMicro, whCum, totalMicro: this.totalMicro });

      try {
        await charger.deliver(this.stepWh);
      } catch (e) {
        this.emitError(e, true);
        return 'error';
      }
      this.whDelivered += this.stepWh;
      this.emit('delivered', { seq, wh: this.stepWh, whDelivered: this.whDelivered });
    }
  }

  /** Retries once when a rebuilt tx cannot double-pay (expired blockhash / network); never on program errors. */
  private async payWithRetry(req: PayRequest): Promise<string> {
    try {
      return await this.opts.chain.pay(req);
    } catch (e) {
      if (!isRetryableChainError(e)) throw e;
      this.emitError(e, false);
      return await this.opts.chain.pay(req);
    }
  }

  private async classifyFailedPull(g: StartInfo): Promise<EndReason | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.sleep(1_000);
      try {
        const reason = this.allowanceStop(await this.opts.chain.getAllowance(g.guestAta), g);
        if (reason) return reason;
      } catch {
        // keep trying; fall back to 'error'
      }
    }
    return null;
  }

  private async endSession(g: StartInfo, reason: EndReason, problem: string | null): Promise<SessionResult> {
    this.setState('ENDING');
    let lastError: unknown;
    for (let attempt = 1; attempt <= END_ATTEMPTS; attempt++) {
      try {
        const { sig, refundLamports } = await this.opts.chain.end({
          session: this.opts.session,
          guest: g.guest,
          sid: this.sid,
          whTotal: this.whDelivered,
          totalMicro: this.totalMicro,
          reason,
        });
        return this.finish({ reason, endSig: sig, refundLamports, error: problem ?? undefined });
      } catch (e) {
        lastError = e;
        // Retrying is safe even after a program error: the refund is bounded by the key's balance.
        const final = attempt === END_ATTEMPTS;
        this.emitError(e, final);
        if (final) break;
        await this.sleep(1_500 * attempt);
      }
    }
    return this.finish({
      reason,
      endSig: null,
      refundLamports: null,
      error: `End transaction failed: ${errorMessage(lastError)}`,
    });
  }

  private finish(p: Pick<SessionResult, 'reason' | 'endSig' | 'refundLamports' | 'error'>): SessionResult {
    const result: SessionResult = {
      ...p,
      sid: this.sid,
      guest: this.guest?.guest ?? null,
      payments: this.seq,
      whDelivered: this.whDelivered,
      totalMicro: this.totalMicro,
    };
    if (result.error === undefined) delete result.error;
    this.endResult = result;
    this.setState('IDLE');
    this.emit('ended', result);
    return result;
  }

  private setState(next: ChargerState): void {
    if (next === this.currentState) return;
    this.currentState = next;
    this.emit('state', next);
  }

  private emitError(e: unknown, fatal: boolean): void {
    this.emit('error', { message: errorMessage(e), fatal, cause: e });
  }

  private emit<K extends keyof ChargerEvents>(event: K, ...args: ChargerEvents[K]): void {
    for (const cb of this.listeners.get(event) ?? []) {
      try {
        (cb as unknown as Listener<K>)(...args);
      } catch {
        // A faulty UI listener must never break the payment loop.
      }
    }
  }
}
