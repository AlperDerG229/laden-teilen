// Kiosk lifecycle around the core ChargerSession (spec 6.2):
//   new session key (persisted first) -> QR -> WAITING_FOR_GUEST -> CHARGING -> ENDING -> new key.
// The secret stays in storage until the end tx confirmed, so a reload never strands the guest's
// deposit: on boot the controller resumes the charging session, finishes a pending end, or keeps
// waiting with the same key (the QR stays valid).
//
// Not React: the screens subscribe via getSnapshot/subscribe (useSyncExternalStore).
import { createKeyPairSignerFromPrivateKeyBytes, type Address, type KeyPairSigner } from '@solana/kit';
import { stepMicro } from '../../core/amounts.ts';
import type { Payment, StartInfo } from '../../core/chain.ts';
import { STEP_WH } from '../../core/config.ts';
import { errorMessage } from '../../core/errors.ts';
import { sidOf, type EndReason } from '../../core/memo.ts';
import { ChargerSession, type ChargerChain, type ChargerState, type ResumeState } from '../../core/session.ts';
import { sleep as defaultSleep, type Sleep } from '../../core/throttle.ts';
import type { ChargerSim } from '../../sim/charger-sim.ts';
import type { AppChain, ChainKind } from '../chain/types.ts';
import { nsKey, readJson, writeJson, type KeyValueStorage } from '../storage.ts';

export interface KioskConfig {
  owner: Address;
  priceEur: string;
  priceMicroPerKWh: bigint;
  name: string;
  capEur: string;
}

export interface KioskPayment {
  seq: number;
  sig: string;
  amountMicro: bigint;
  whCum: number;
  /** ms since epoch */
  at: number;
}

export interface KioskLastSession {
  sid: string;
  reason: EndReason;
  payments: number;
  whDelivered: number;
  totalMicro: bigint;
  endSig: string | null;
  refundLamports: bigint | null;
  guest: Address | null;
  error?: string;
  endedAt: number;
  feed: KioskPayment[];
}

export interface KioskSnapshot {
  /** locked: another tab of this browser runs the kiosk. */
  status: 'booting' | 'running' | 'locked';
  state: ChargerState;
  config: KioskConfig | null;
  session: { address: Address; sid: string } | null;
  stepMicro: bigint | null;
  guest: StartInfo | null;
  /** Current session, newest first. */
  payments: KioskPayment[];
  totalMicro: bigint;
  resumed: boolean;
  last: KioskLastSession | null;
  /** Latest non-fatal problem (RPC hiccup, retry, ...). */
  notice: string | null;
  /** A problem that needs attention (e.g. the refund is still pending). */
  error: string | null;
  /** New settings wait for the running session to end. */
  pendingConfig: boolean;
}

interface KioskRecord {
  v: 1;
  secret: number[];
  config: KioskConfig;
  createdAt: number;
  guest: StartInfo | null;
  payments: number;
  totalMicro: bigint;
  whDelivered: number;
  /** seq of a pull that was sent but not confirmed when the page went away. */
  payPending: number | null;
  endPending: { reason: EndReason; whTotal: number; totalMicro: bigint } | null;
}

export interface KioskDeps {
  chain: AppChain;
  sim: ChargerSim;
  storage: KeyValueStorage;
  mode: ChainKind;
  now?: () => number;
  sleep?: Sleep;
  randomBytes?: (n: number) => Uint8Array;
  /** Web Locks (navigator.locks): one running kiosk per browser and mode. */
  locks?: Pick<LockManager, 'request'>;
  pollIntervalMs?: number;
  /** How long to wait for an in-flight pull to show up after a reload. */
  pendingPayWaitMs?: number;
}

export const sameConfig = (a: KioskConfig | null, b: KioskConfig | null): boolean =>
  !!a && !!b && a.owner === b.owner && a.priceMicroPerKWh === b.priceMicroPerKWh && a.name === b.name && a.capEur === b.capEur;

const INITIAL: KioskSnapshot = {
  status: 'booting',
  state: 'IDLE',
  config: null,
  session: null,
  stepMicro: null,
  guest: null,
  payments: [],
  totalMicro: 0n,
  resumed: false,
  last: null,
  notice: null,
  error: null,
  pendingConfig: false,
};

type Plan =
  | { kind: 'waiting' }
  | { kind: 'ended'; endSig: string; whTotal: number; totalMicro: bigint; reason: EndReason }
  | { kind: 'end-pending'; start: StartInfo }
  | { kind: 'charging'; resume: ResumeState; feed: KioskPayment[] };

export class KioskController {
  private snap: KioskSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private readonly deps: KioskDeps;
  private readonly storageKey: string;
  private readonly now: () => number;
  private readonly sleep: Sleep;
  private desired: KioskConfig | null = null;
  private configWaiters: (() => void)[] = [];
  private current: ChargerSession | null = null;
  private started = false;
  private disposed = false;
  private readonly wake = new AbortController();

  constructor(deps: KioskDeps) {
    this.deps = deps;
    this.storageKey = nsKey(deps.mode, 'kiosk:v1');
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  getSnapshot = (): KioskSnapshot => this.snap;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get sim(): ChargerSim {
    return this.deps.sim;
  }

  /** Sets the wallbox settings. A waiting session with other settings is replaced at once. */
  configure(config: KioskConfig): void {
    this.desired = config;
    for (const w of this.configWaiters.splice(0)) w();
    const active = this.snap.config;
    const differs = !!active && !sameConfig(active, config);
    if (differs && this.current?.state === 'WAITING_FOR_GUEST') this.current.stop('user');
    this.patch({ pendingConfig: differs && this.snap.state !== 'WAITING_FOR_GUEST' });
  }

  /** Starts the kiosk loop once (idempotent). */
  start(): void {
    if (this.started) return;
    this.started = true;
    const { locks } = this.deps;
    if (!locks) {
      void this.run();
      return;
    }
    const name = `laden-teilen-kiosk-${this.deps.mode}`;
    void locks.request(name, { ifAvailable: true }, async (lock) => {
      if (lock) return this.run();
      this.patch({ status: 'locked' });
      // Queue up: take over as soon as the other tab closes.
      return locks.request(name, () => this.run());
    });
  }

  /** Kiosk "Stop" button. */
  stopSession(): void {
    this.current?.stop('user');
  }

  /** "Car full" / unplug from the simulator. Only a charging session is affected. */
  carFull(): void {
    if (this.current?.state === 'CHARGING') this.current.stop('full');
  }

  /** Stops the loop. The current session ends normally (with refund). */
  dispose(): void {
    this.disposed = true;
    this.wake.abort();
    this.current?.stop('user');
    for (const w of this.configWaiters.splice(0)) w();
  }

  // -------------------------------------------------------------------------------------------

  private async run(): Promise<void> {
    this.patch({ status: 'running' });
    this.deps.sim.onFull = () => this.carFull();
    while (!this.disposed) {
      try {
        await this.runOne();
      } catch (e) {
        this.patch({ error: `Kiosk error: ${errorMessage(e)}. Retrying…` });
        await this.sleep(5_000, this.wake.signal);
      }
    }
  }

  private async runOne(): Promise<void> {
    let rec = this.loadRecord();
    const fresh = !rec;
    if (!rec) {
      const config = await this.waitForConfig();
      if (!config || this.disposed) return;
      rec = this.createRecord(config);
    }
    const signer = await createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(rec.secret));
    const sid = sidOf(signer.address);
    const config = rec.config;
    this.patch({
      session: { address: signer.address, sid },
      config,
      stepMicro: stepMicro(config.priceMicroPerKWh, STEP_WH),
      guest: rec.guest,
      payments: [],
      totalMicro: 0n,
      resumed: !fresh,
      error: null,
      notice: null,
      pendingConfig: !!this.desired && !sameConfig(config, this.desired),
    });

    const plan: Plan = fresh ? { kind: 'waiting' } : await this.plan(signer, rec);
    if (plan.kind === 'ended') {
      this.clearRecord();
      this.patch({
        last: {
          sid,
          reason: plan.reason,
          payments: rec.payments,
          whDelivered: plan.whTotal,
          totalMicro: plan.totalMicro,
          endSig: plan.endSig,
          refundLamports: null,
          guest: rec.guest?.guest ?? null,
          endedAt: this.now(),
          feed: [],
        },
        session: null,
        guest: null,
      });
      return;
    }
    if (plan.kind === 'end-pending') {
      await this.finishPendingEnd(signer, rec, plan.start);
      return;
    }

    let resume: ResumeState | undefined;
    if (plan.kind === 'charging') {
      resume = plan.resume;
      this.patch({ guest: resume.start, payments: plan.feed, totalMicro: resume.totalMicro });
      // Energy that was paid for but not delivered before the reload is delivered first.
      const owed = resume.payments * STEP_WH - resume.whDelivered;
      this.deps.sim.resetSession(resume.whDelivered);
      if (owed > 0) {
        this.patch({ notice: `Delivering ${owed} Wh that were already paid before the restart` });
        await this.deps.sim.deliver(owed);
        resume = { ...resume, whDelivered: resume.whDelivered + owed };
        this.saveRecord({ whDelivered: resume.whDelivered });
      }
    } else {
      this.deps.sim.resetSession(0);
    }
    await this.runSession(signer, config, resume);
  }

  private async plan(signer: KeyPairSigner, rec: KioskRecord): Promise<Plan> {
    const sid = sidOf(signer.address);
    const { chain } = this.deps;
    const start = await this.retrying(() => chain.findStartTx(signer.address));
    if (!start) return { kind: 'waiting' };
    const end = await this.retrying(() => chain.findSessionEnd(signer.address, sid));
    if (end) return { kind: 'ended', endSig: end.sig, whTotal: end.whTotal, totalMicro: end.totalMicro, reason: end.reason };
    if (rec.endPending) return { kind: 'end-pending', start };

    let payments = await this.retrying(() => chain.listSessionPayments(start.guestAta, sid));
    const lastSeq = (list: Payment[]) => (list.length ? list[list.length - 1].seq : 0);
    if (rec.payPending !== null && rec.payPending > lastSeq(payments)) {
      // A pull was in flight when the page went away. Wait until it shows up or cannot land any more,
      // so the same step is never pulled twice.
      this.patch({ notice: 'Checking whether the last payment landed…' });
      const deadline = this.now() + (this.deps.pendingPayWaitMs ?? 75_000);
      while (this.now() < deadline && lastSeq(payments) < rec.payPending && !this.disposed) {
        await this.sleep(3_000, this.wake.signal);
        payments = await this.retrying(() => chain.listSessionPayments(start.guestAta, sid));
      }
      this.patch({ notice: null });
    }
    const chainSeq = lastSeq(payments);
    const seq = Math.max(chainSeq, rec.payments);
    const totalMicro = seq === chainSeq ? payments.reduce((sum, p) => sum + p.amountMicro, 0n) : rec.totalMicro;
    const whDelivered = Math.min(Math.max(0, rec.whDelivered), seq * STEP_WH);
    const feed = payments
      .map((p): KioskPayment => ({ seq: p.seq, sig: p.sig, amountMicro: p.amountMicro, whCum: p.whCum, at: (p.blockTime ?? 0) * 1000 }))
      .reverse();
    this.saveRecord({ guest: start, payments: seq, totalMicro, whDelivered, payPending: null });
    return { kind: 'charging', resume: { start, payments: seq, whDelivered, totalMicro }, feed };
  }

  private async runSession(signer: KeyPairSigner, config: KioskConfig, resume: ResumeState | undefined): Promise<void> {
    const base = this.deps.chain.charger();
    const chain: ChargerChain = {
      ...base,
      pay: async (req) => {
        this.saveRecord({ payPending: req.seq });
        return base.pay(req);
      },
      end: async (req) => {
        this.saveRecord({ endPending: { reason: req.reason, whTotal: req.whTotal, totalMicro: req.totalMicro } });
        return base.end(req);
      },
    };
    const session = new ChargerSession({
      session: signer,
      owner: config.owner,
      priceMicroPerKWh: config.priceMicroPerKWh,
      chain,
      charger: this.deps.sim,
      resume,
      pollIntervalMs: this.deps.pollIntervalMs,
      sleep: this.deps.sleep,
    });
    this.current = session;
    session.on('state', (state) => this.patch({ state }));
    session.on('guest', (guest) => {
      this.saveRecord({ guest });
      this.patch({ guest, notice: null });
      // Owner paying owner is an SPL self-transfer: it never uses up the allowance. End and refund.
      if (guest.guest === config.owner) {
        this.patch({ notice: 'The guest wallet is the payout wallet. Ending the session and refunding the deposit.' });
        session.stop('error');
      }
    });
    session.on('payment', (p) => {
      this.saveRecord({ payments: p.seq, totalMicro: p.totalMicro, payPending: null });
      const row: KioskPayment = { seq: p.seq, sig: p.sig, amountMicro: p.amountMicro, whCum: p.whCum, at: this.now() };
      this.patch({ payments: [row, ...this.snap.payments], totalMicro: p.totalMicro, notice: null });
    });
    session.on('delivered', (d) => this.saveRecord({ whDelivered: d.whDelivered }));
    session.on('error', (e) => this.patch(e.fatal ? { error: e.message } : { notice: e.message }));

    // Settings changed while this key was waiting (e.g. after a reload): replace it now.
    if (!resume && this.desired && !sameConfig(config, this.desired)) session.stop('user');
    if (this.disposed) session.stop('user');

    const result = await session.start();
    this.current = null;
    if (result.endSig !== null || result.guest === null) {
      this.clearRecord();
      const feed = this.snap.payments;
      this.patch({
        ...(result.guest
          ? {
              last: {
                sid: result.sid,
                reason: result.reason,
                payments: result.payments,
                whDelivered: result.whDelivered,
                totalMicro: result.totalMicro,
                endSig: result.endSig,
                refundLamports: result.refundLamports,
                guest: result.guest,
                error: result.error,
                endedAt: this.now(),
                feed,
              },
            }
          : {}),
        session: null,
        guest: null,
        payments: [],
        totalMicro: 0n,
        error: result.error && result.guest ? result.error : null,
      });
    } else {
      // The end tx failed three times; the record keeps the key and endPending. Retry soon.
      this.patch({ error: `The refund has not been sent yet (${result.error ?? 'unknown error'}). Retrying…` });
      await this.sleep(10_000, this.wake.signal);
    }
  }

  private async finishPendingEnd(signer: KeyPairSigner, rec: KioskRecord, start: StartInfo): Promise<void> {
    const sid = sidOf(signer.address);
    const pending = rec.endPending!;
    this.patch({ state: 'ENDING', guest: start, notice: 'Finishing the previous session (refund pending)…' });
    for (let attempt = 0; !this.disposed; attempt++) {
      try {
        const landed = await this.deps.chain.findSessionEnd(signer.address, sid);
        const done = landed
          ? { sig: landed.sig, refundLamports: null }
          : await this.deps.chain.charger().end({ session: signer, guest: start.guest, sid, ...pending });
        this.clearRecord();
        this.patch({
          state: 'IDLE',
          last: {
            sid,
            reason: pending.reason,
            payments: rec.payments,
            whDelivered: pending.whTotal,
            totalMicro: pending.totalMicro,
            endSig: done.sig,
            refundLamports: done.refundLamports,
            guest: start.guest,
            endedAt: this.now(),
            feed: [],
          },
          session: null,
          guest: null,
          notice: null,
          error: null,
        });
        return;
      } catch (e) {
        this.patch({ error: `The refund has not been sent yet (${errorMessage(e)}). Retrying…` });
        await this.sleep(Math.min(60_000, 5_000 * 2 ** attempt), this.wake.signal);
      }
    }
  }

  private async retrying<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (attempt >= 4 || this.disposed) throw e;
        this.patch({ notice: `Network problem (${errorMessage(e)}). Retrying…` });
        await this.sleep(1_000 * 2 ** attempt, this.wake.signal);
      }
    }
  }

  private waitForConfig(): Promise<KioskConfig | null> {
    if (this.desired || this.disposed) return Promise.resolve(this.desired);
    return new Promise((resolve) => this.configWaiters.push(() => resolve(this.desired)));
  }

  // -------------------------------------------------------------------------------------------
  // Persistence

  private loadRecord(): KioskRecord | null {
    const rec = readJson<KioskRecord>(this.deps.storage, this.storageKey);
    if (!rec || rec.v !== 1 || !Array.isArray(rec.secret) || rec.secret.length !== 32 || !rec.config) return null;
    return rec;
  }

  private createRecord(config: KioskConfig): KioskRecord {
    const secret = (this.deps.randomBytes ?? ((n) => crypto.getRandomValues(new Uint8Array(n))))(32);
    const rec: KioskRecord = {
      v: 1,
      secret: [...secret],
      config,
      createdAt: this.now(),
      guest: null,
      payments: 0,
      totalMicro: 0n,
      whDelivered: 0,
      payPending: null,
      endPending: null,
    };
    writeJson(this.deps.storage, this.storageKey, rec); // persisted before the QR is shown
    return rec;
  }

  private saveRecord(patch: Partial<KioskRecord>): void {
    const rec = this.loadRecord();
    if (rec) writeJson(this.deps.storage, this.storageKey, { ...rec, ...patch });
  }

  private clearRecord(): void {
    this.deps.storage.removeItem(this.storageKey);
  }

  private patch(p: Partial<KioskSnapshot>): void {
    this.snap = { ...this.snap, ...p };
    for (const l of this.listeners) l();
  }
}
