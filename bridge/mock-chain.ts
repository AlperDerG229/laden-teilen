// In-memory ChargerChain for runs without devnet funds (bridge:smoke, unit tests).
// Emulates what matters for the charger loop: the guest's start tx (after a delay, like a guest
// scanning the QR and approving), the SPL Token delegate rules (allowance decremented per pull,
// delegate cleared at 0, revoke), the session key's SOL (fees, owner-ATA rent on pay #1) and the
// end sweep. Signatures are labelled `mock:` and are never shown as explorer links.
import type { Address } from '@solana/kit';
import type { Allowance, StartInfo } from '../src/core/chain.ts';
import { ChainError } from '../src/core/errors.ts';
import { sidOf } from '../src/core/memo.ts';
import type { ChargerChain, EndRequest, PayRequest } from '../src/core/session.ts';
import { sleep as defaultSleep, type Sleep } from '../src/core/throttle.ts';

const FEE_LAMPORTS = 5_000n;
const RENT_0 = 650_240n;
const RENT_TOKEN_ACCOUNT = 1_488_440n;

export type MockChainEvent =
  | { type: 'guest-start'; sig: string; capMicro: bigint }
  | { type: 'guest-revoke'; sig: string }
  | { type: 'pay'; req: PayRequest; sig: string }
  | { type: 'end'; req: EndRequest; sig: string; refundLamports: bigint };

export interface MockChainOptions {
  session: Address;
  guest: Address;
  guestAta: Address;
  priceMicroPerKWh: bigint;
  /** Allowance the scripted guest approves (ApproveChecked amount). */
  capMicro: bigint;
  /** Guest token balance (default 1 EURC). */
  balanceMicro?: bigint;
  depositLamports?: bigint;
  /** The scripted guest's start tx becomes visible this long after the first findStartTx poll. */
  startAfterMs?: number;
  /** Emulated confirmation time of pay / end txs. */
  latencyMs?: number;
  /** The scripted guest revokes ("Stop & revoke") right after this many confirmed payments. */
  revokeAfterPayments?: number;
  sleep?: Sleep;
  now?: () => number;
  onEvent?: (e: MockChainEvent) => void;
}

export class MockChain implements ChargerChain {
  readonly pays: PayRequest[] = [];
  readonly ends: EndRequest[] = [];
  delegate: Address | null = null;
  delegatedMicro = 0n;
  balanceMicro: bigint;
  /** Lamports held by the session key. */
  sessionLamports = 0n;
  ownerReceivedMicro = 0n;

  private readonly opts: MockChainOptions;
  private readonly sleep: Sleep;
  private readonly now: () => number;
  private firstPollAt: number | null = null;
  private startInfo: StartInfo | null = null;
  private ownerAtaExists = false;

  constructor(opts: MockChainOptions) {
    this.opts = opts;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    this.balanceMicro = opts.balanceMicro ?? 1_000_000n;
  }

  get started(): boolean {
    return this.startInfo !== null;
  }

  async findStartTx(session: Address): Promise<StartInfo | null> {
    if (this.startInfo) return this.startInfo;
    const t = this.now();
    this.firstPollAt ??= t;
    if (t - this.firstPollAt < (this.opts.startAfterMs ?? 0)) return null;
    // The scripted guest signs: SOL deposit + ApproveChecked(cap) + start memo.
    const deposit = this.opts.depositLamports ?? 5_000_000n;
    this.sessionLamports += deposit;
    this.delegate = session;
    this.delegatedMicro = this.opts.capMicro;
    this.startInfo = {
      sig: 'mock:start',
      guest: this.opts.guest,
      guestAta: this.opts.guestAta,
      capMicro: this.opts.capMicro,
      priceMicroPerKWh: this.opts.priceMicroPerKWh,
      sid: sidOf(session),
      depositLamports: deposit,
      blockTime: Math.floor(t / 1000),
    };
    this.emit({ type: 'guest-start', sig: 'mock:start', capMicro: this.opts.capMicro });
    return this.startInfo;
  }

  async getAllowance(): Promise<Allowance> {
    return {
      delegate: this.delegate,
      delegatedMicro: this.delegate ? this.delegatedMicro : 0n,
      balanceMicro: this.balanceMicro,
      exists: true,
      owner: this.opts.guest,
    };
  }

  async getSolBalance(address: Address): Promise<bigint> {
    return address === this.opts.session ? this.sessionLamports : 0n;
  }

  async getRentExemptMinimum(bytes: number): Promise<bigint> {
    return bytes === 0 ? RENT_0 : RENT_TOKEN_ACCOUNT;
  }

  async pay(req: PayRequest): Promise<string> {
    await this.sleep(this.opts.latencyMs ?? 0);
    // Same checks the token program applies to a delegate transfer.
    if (this.delegate !== req.session.address || this.delegatedMicro < req.amountMicro) {
      throw new ChainError('program', 'Simulation failed: owner does not match / insufficient delegated amount');
    }
    if (this.balanceMicro < req.amountMicro) throw new ChainError('program', 'Simulation failed: insufficient funds');
    this.delegatedMicro -= req.amountMicro;
    this.balanceMicro -= req.amountMicro;
    if (this.delegatedMicro === 0n) this.delegate = null; // an exhausted delegate is cleared
    this.ownerReceivedMicro += req.amountMicro;
    this.sessionLamports -= FEE_LAMPORTS + (req.createOwnerAta && !this.ownerAtaExists ? RENT_TOKEN_ACCOUNT : 0n);
    if (req.createOwnerAta) this.ownerAtaExists = true;
    this.pays.push(req);
    const sig = `mock:pay#${req.seq}`;
    this.emit({ type: 'pay', req, sig });
    if (this.opts.revokeAfterPayments !== undefined && this.pays.length === this.opts.revokeAfterPayments) {
      this.delegate = null;
      this.delegatedMicro = 0n;
      this.emit({ type: 'guest-revoke', sig: 'mock:stop' });
    }
    return sig;
  }

  async end(req: EndRequest): Promise<{ sig: string; refundLamports: bigint }> {
    await this.sleep(this.opts.latencyMs ?? 0);
    const refundLamports = this.sessionLamports - FEE_LAMPORTS;
    if (refundLamports < 0n) throw new ChainError('program', 'Session key cannot pay the end tx fee');
    this.sessionLamports = 0n;
    this.ends.push(req);
    const sig = 'mock:end';
    this.emit({ type: 'end', req, sig, refundLamports });
    return { sig, refundLamports };
  }

  private emit(e: MockChainEvent): void {
    try {
      this.opts.onEvent?.(e);
    } catch {
      // logging only
    }
  }
}
