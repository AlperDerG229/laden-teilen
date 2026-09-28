import { generateKeyPairSigner, type Address, type KeyPairSigner } from '@solana/kit';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Allowance, StartInfo } from './chain.ts';
import { ChainError } from './errors.ts';
import { sidOf } from './memo.ts';
import {
  ChargerSession,
  type ChargerChain,
  type ChargerSessionOptions,
  type ChargerState,
  type EndRequest,
  type PayRequest,
} from './session.ts';

const PRICE = 390_000n; // 0.39 EURC/kWh
const STEP = 39_000n; // 0.039 EURC per 100 Wh
const RENT0 = 650_240n;
const RENT165 = 1_488_440n;
const FEE = 5_000n;
const noSleep = async () => {};

let sessionKey: KeyPairSigner;
let guest: Address;
let guestAta: Address;
let owner: Address;

beforeAll(async () => {
  sessionKey = await generateKeyPairSigner();
  guest = (await generateKeyPairSigner()).address;
  guestAta = (await generateKeyPairSigner()).address;
  owner = (await generateKeyPairSigner()).address;
});

/** In-memory chain that emulates the SPL Token delegate rules and the session key's SOL. */
class MockChain implements ChargerChain {
  readonly log: string[] = [];
  readonly pays: PayRequest[] = [];
  readonly ends: EndRequest[] = [];
  start: StartInfo | null;
  /** findStartTx returns null for this many polls first. */
  startAfterPolls = 0;
  polls = 0;
  onPoll?: (poll: number) => void;
  delegate: Address | null;
  delegated: bigint;
  balance: bigint;
  sol: bigint;
  ownerAtaExists = false;
  /** Errors thrown by the next pay() calls (before any state change). */
  payErrors: ChainError[] = [];
  onPay?: (req: PayRequest) => void;
  endErrors: Error[] = [];

  constructor(init: { cap?: bigint; balance?: bigint; sol?: bigint; start?: Partial<StartInfo> | null } = {}) {
    const cap = init.cap ?? 5_000_000n;
    this.delegate = sessionKey.address;
    this.delegated = cap;
    this.balance = init.balance ?? 1_000_000n;
    this.sol = init.sol ?? 5_000_000n;
    this.start =
      init.start === null
        ? null
        : {
            sig: 'sig-start',
            guest,
            guestAta,
            capMicro: cap,
            priceMicroPerKWh: PRICE,
            sid: sidOf(sessionKey.address),
            depositLamports: 5_000_000n,
            blockTime: null,
            ...init.start,
          };
  }

  async findStartTx(): Promise<StartInfo | null> {
    this.polls++;
    this.onPoll?.(this.polls);
    return this.polls > this.startAfterPolls ? this.start : null;
  }

  async getAllowance(): Promise<Allowance> {
    return { delegate: this.delegate, delegatedMicro: this.delegate ? this.delegated : 0n, balanceMicro: this.balance, exists: true, owner: guest };
  }

  async getSolBalance(): Promise<bigint> {
    return this.sol;
  }

  async getRentExemptMinimum(bytes: number): Promise<bigint> {
    return bytes === 0 ? RENT0 : RENT165;
  }

  async pay(req: PayRequest): Promise<string> {
    this.log.push(`pay#${req.seq}`);
    const err = this.payErrors.shift();
    if (err) throw err;
    this.onPay?.(req);
    if (this.delegate !== req.session.address || this.delegated < req.amountMicro) throw new ChainError('program', 'owner does not match');
    if (this.balance < req.amountMicro) throw new ChainError('program', 'insufficient funds');
    this.delegated -= req.amountMicro;
    this.balance -= req.amountMicro;
    if (this.delegated === 0n) this.delegate = null; // token program clears an exhausted delegate
    this.sol -= FEE + (req.createOwnerAta && !this.ownerAtaExists ? RENT165 : 0n);
    if (req.createOwnerAta) this.ownerAtaExists = true;
    this.pays.push(req);
    return `sig-pay-${req.seq}`;
  }

  async end(req: EndRequest): Promise<{ sig: string; refundLamports: bigint }> {
    this.log.push(`end:${req.reason}`);
    const err = this.endErrors.shift();
    if (err) throw err;
    this.ends.push(req);
    const refundLamports = this.sol - FEE;
    this.sol = 0n;
    return { sig: 'sig-end', refundLamports };
  }
}

/** Charger that records deliveries into the shared log and runs a hook after each step. */
function mockCharger(chain: MockChain, afterStep?: (step: number, session: ChargerSession) => void) {
  let steps = 0;
  const holder: { session?: ChargerSession } = {};
  return {
    holder,
    charger: {
      async deliver(wh: number) {
        steps++;
        chain.log.push(`deliver#${steps}`);
        expect(wh).toBe(100);
        afterStep?.(steps, holder.session!);
      },
    },
  };
}

function makeSession(chain: MockChain, afterStep?: (step: number, s: ChargerSession) => void, extra: Partial<ChargerSessionOptions> = {}) {
  const { holder, charger } = mockCharger(chain, afterStep);
  const session = new ChargerSession({
    session: sessionKey,
    owner,
    priceMicroPerKWh: PRICE,
    chain,
    charger,
    sleep: noSleep,
    ...extra,
  });
  holder.session = session;
  const states: ChargerState[] = [];
  session.on('state', (s) => states.push(s));
  return { session, states };
}

const stopAfter = (n: number, reason: 'user' | 'full' = 'user') => (step: number, s: ChargerSession) => {
  if (step === n) s.stop(reason);
};

describe('ChargerSession', () => {
  it('pulls before it delivers every step, then ends on a user stop', async () => {
    const chain = new MockChain();
    const { session, states } = makeSession(chain, stopAfter(3));
    const payments: number[] = [];
    session.on('payment', (p) => payments.push(p.seq));

    const result = await session.start();

    expect(chain.log).toEqual(['pay#1', 'deliver#1', 'pay#2', 'deliver#2', 'pay#3', 'deliver#3', 'end:user']);
    expect(payments).toEqual([1, 2, 3]);
    expect(states).toEqual(['WAITING_FOR_GUEST', 'CHARGING', 'ENDING', 'IDLE']);
    expect(result).toMatchObject({ reason: 'user', payments: 3, whDelivered: 300, totalMicro: 3n * STEP, endSig: 'sig-end', guest });
    expect(chain.ends[0]).toMatchObject({ reason: 'user', whTotal: 300, totalMicro: 117_000n, guest, sid: session.sid });
    // pay #1 creates the owner ATA, the others don't; memo fields are cumulative
    expect(chain.pays.map((p) => [p.seq, p.whCum, p.amountMicro, p.createOwnerAta])).toEqual([
      [1, 100, STEP, true],
      [2, 200, STEP, false],
      [3, 300, STEP, false],
    ]);
    expect(session.state).toBe('IDLE');
  });

  it('never delivers a step whose payment failed', async () => {
    const chain = new MockChain();
    chain.onPay = (req) => {
      if (req.seq === 2) throw new ChainError('program', 'custom program error: 0x1');
    };
    const { session } = makeSession(chain);
    const errors: string[] = [];
    session.on('error', (e) => errors.push(e.message));

    const result = await session.start();

    expect(chain.log).toEqual(['pay#1', 'deliver#1', 'pay#2', 'end:error']);
    expect(result).toMatchObject({ reason: 'error', payments: 1, whDelivered: 100, totalMicro: STEP });
    expect(errors[0]).toContain('custom program error');
  });

  it('ends with "revoked" when the guest revokes the allowance', async () => {
    const chain = new MockChain();
    const { session } = makeSession(chain, (step) => {
      if (step === 2) chain.delegate = null; // guest's Revoke landed
    });
    const result = await session.start();
    expect(result).toMatchObject({ reason: 'revoked', payments: 2, whDelivered: 200 });
    expect(chain.log.at(-1)).toBe('end:revoked');
  });

  it('ends with "cap" when the remaining allowance is below one step', async () => {
    const chain = new MockChain({ cap: 2n * STEP + 22_000n });
    const { session } = makeSession(chain);
    const result = await session.start();
    expect(chain.delegated).toBe(22_000n);
    expect(result).toMatchObject({ reason: 'cap', payments: 2, totalMicro: 2n * STEP });
  });

  it('labels an exactly used-up allowance "cap", although the token program cleared the delegate', async () => {
    const chain = new MockChain({ cap: 2n * STEP });
    const { session } = makeSession(chain);
    const result = await session.start();
    expect(chain.delegate).toBeNull();
    expect(result).toMatchObject({ reason: 'cap', payments: 2 });
  });

  it('ends with "funds" when the guest balance is below one step', async () => {
    const chain = new MockChain({ balance: 100_000n });
    const { session } = makeSession(chain);
    const result = await session.start();
    expect(result).toMatchObject({ reason: 'funds', payments: 2, totalMicro: 78_000n });
  });

  it('ends with "full" when the car is full', async () => {
    const chain = new MockChain();
    const { session } = makeSession(chain, stopAfter(4, 'full'));
    const result = await session.start();
    expect(result).toMatchObject({ reason: 'full', payments: 4, whDelivered: 400 });
    expect(chain.log.filter((l) => l.startsWith('pay')).length).toBe(4);
  });

  it('ends with "sol" when the session key fee budget runs low', async () => {
    // Spendable = balance - rent-exempt reserve. Pay #1 also needs the owner ATA rent.
    const chain = new MockChain({ sol: RENT0 + RENT165 + 35_000n });
    const { session } = makeSession(chain);
    const result = await session.start();
    // budget after each pull: 30k, 25k, 20k, 15k (< 20k) -> 4 pulls
    expect(result).toMatchObject({ reason: 'sol', payments: 4 });
    expect(chain.ends).toHaveLength(1);
  });

  it('does not start pulling when the deposit cannot cover the owner ATA rent', async () => {
    const chain = new MockChain({ sol: RENT0 + 30_000n });
    const { session } = makeSession(chain);
    const result = await session.start();
    expect(result).toMatchObject({ reason: 'sol', payments: 0, endSig: 'sig-end' });
    expect(chain.log).toEqual(['end:sol']);
  });

  it('polls until the guest start tx appears', async () => {
    const chain = new MockChain();
    chain.startAfterPolls = 2;
    const { session, states } = makeSession(chain, stopAfter(1));
    const guests: string[] = [];
    session.on('guest', (g) => guests.push(g.sig));
    await session.start();
    expect(chain.polls).toBe(3);
    expect(guests).toEqual(['sig-start']);
    expect(states.slice(0, 2)).toEqual(['WAITING_FOR_GUEST', 'CHARGING']);
  });

  it('stopping before a guest arrived needs no end tx', async () => {
    const chain = new MockChain({ start: null });
    const { session, states } = makeSession(chain);
    chain.onPoll = (poll) => {
      if (poll === 2) session.stop();
    };
    const result = await session.start();
    expect(result).toMatchObject({ reason: 'user', payments: 0, endSig: null, guest: null });
    expect(chain.ends).toHaveLength(0);
    expect(states).toEqual(['WAITING_FOR_GUEST', 'IDLE']);
  });

  it('refunds a guest whose start tx landed just as the kiosk stopped', async () => {
    const chain = new MockChain();
    chain.startAfterPolls = 1;
    const { session } = makeSession(chain);
    chain.onPoll = (poll) => {
      if (poll === 1) session.stop();
    };
    const result = await session.start();
    expect(result).toMatchObject({ reason: 'user', payments: 0, endSig: 'sig-end', guest });
    expect(chain.log).toEqual(['end:user']);
  });

  it('retries a pull once after an expired blockhash, but not after a program error', async () => {
    const chain = new MockChain();
    chain.payErrors = [new ChainError('expired', 'blockhash expired')];
    const { session } = makeSession(chain, stopAfter(1));
    const result = await session.start();
    expect(chain.log).toEqual(['pay#1', 'pay#1', 'deliver#1', 'end:user']);
    expect(result).toMatchObject({ reason: 'user', payments: 1 });

    const chain2 = new MockChain();
    chain2.payErrors = [new ChainError('program', 'boom')];
    const { session: session2 } = makeSession(chain2);
    const result2 = await session2.start();
    expect(chain2.log).toEqual(['pay#1', 'end:error']);
    expect(result2).toMatchObject({ reason: 'error', payments: 0 });
  });

  it('relabels a failed pull caused by a concurrent revoke as "revoked"', async () => {
    const chain = new MockChain();
    chain.onPay = (req) => {
      if (req.seq === 3) chain.delegate = null; // the revoke lands between our check and the pull
    };
    const { session } = makeSession(chain);
    const result = await session.start();
    expect(chain.log).toEqual(['pay#1', 'deliver#1', 'pay#2', 'deliver#2', 'pay#3', 'end:revoked']);
    expect(result).toMatchObject({ reason: 'revoked', payments: 2 });
  });

  it('refuses a start tx with a different price and refunds the deposit', async () => {
    const chain = new MockChain({ start: { priceMicroPerKWh: 400_000n } });
    const { session } = makeSession(chain);
    const result = await session.start();
    expect(result).toMatchObject({ reason: 'error', payments: 0, endSig: 'sig-end' });
    expect(result.error).toContain('price');
    expect(chain.pays).toHaveLength(0);
  });

  it('refuses a start tx whose cap is below one step', async () => {
    const chain = new MockChain({ cap: STEP - 1n });
    const { session } = makeSession(chain);
    const result = await session.start();
    expect(result).toMatchObject({ reason: 'error', payments: 0 });
    expect(result.error).toContain('cap');
  });

  it('resumes after a reload with the restored progress', async () => {
    const chain = new MockChain();
    chain.ownerAtaExists = true;
    const { session, states } = makeSession(chain, stopAfter(1), {
      resume: { start: new MockChain().start!, payments: 2, whDelivered: 200, totalMicro: 2n * STEP },
    });
    const result = await session.start();
    expect(chain.pays.map((p) => [p.seq, p.whCum, p.createOwnerAta])).toEqual([[3, 300, false]]);
    expect(result).toMatchObject({ reason: 'user', payments: 3, whDelivered: 300, totalMicro: 3n * STEP });
    expect(states[0]).toBe('CHARGING');
  });

  it('retries the end tx so the deposit is refunded', async () => {
    const chain = new MockChain();
    chain.endErrors = [new ChainError('expired', 'blockhash expired')];
    const { session } = makeSession(chain, stopAfter(1));
    const result = await session.start();
    expect(chain.log).toEqual(['pay#1', 'deliver#1', 'end:user', 'end:user']);
    expect(result.endSig).toBe('sig-end');
  });

  it('is single use', async () => {
    const chain = new MockChain();
    const { session } = makeSession(chain, stopAfter(1));
    await session.start();
    await expect(session.start()).rejects.toThrow('single use');
  });
});
