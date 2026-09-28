import { generateKeyPairSigner, type Address, type KeyPairSigner } from '@solana/kit';
import { beforeAll, describe, expect, it } from 'vitest';
import { ChargerSession, type ChargerChain } from '../src/core/session.ts';
import type { Sleep } from '../src/core/throttle.ts';
import { MeteredCharger, withMeteredEnd, type MeteredChargerOptions } from './metered.ts';
import { MockChain, type MockChainOptions } from './mock-chain.ts';
import { SimPort, type SimPortOptions } from './ports/sim.ts';
import type { ChargerPort, ChargerReading } from './ports/types.ts';

const PRICE = 390_000n; // 0.39 EURC/kWh
const STEP = 39_000n; // 0.039 EURC per 100 Wh
const POLL = 2_000;

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

/** Deterministic clock: every sleep advances simulated time instantly. */
function fakeClock() {
  let t = 1_000_000;
  const now = () => t;
  const sleep: Sleep = async (ms, signal) => {
    if (signal?.aborted) return;
    t += Math.max(0, ms);
  };
  return { now, sleep };
}

interface Setup {
  capSteps?: number;
  sim?: SimPortOptions;
  chain?: Partial<MockChainOptions>;
  metered?: Partial<MeteredChargerOptions>;
  port?: (sim: SimPort) => ChargerPort;
  wrapChain?: (chain: ChargerChain) => ChargerChain;
  onReading?: (r: ChargerReading, m: MeteredCharger) => void;
}

function setup(s: Setup = {}) {
  const clock = fakeClock();
  const log: string[] = [];
  const readings: { metered: number; paid: number; phase: 'charging' | 'ending' }[] = [];
  let phase: 'charging' | 'ending' = 'charging';
  const sim = new SimPort({ now: clock.now, powerW: 11_000, ...s.sim });
  const port = s.port ? s.port(sim) : sim;
  const chain = new MockChain({
    session: sessionKey.address,
    guest,
    guestAta,
    priceMicroPerKWh: PRICE,
    capMicro: STEP * BigInt(s.capSteps ?? 50),
    latencyMs: 1_500,
    startAfterMs: 4_000,
    sleep: clock.sleep,
    now: clock.now,
    onEvent: (e) => {
      if (e.type === 'pay') log.push(`pay#${e.req.seq}@${Math.round(metered.meteredWh)}Wh`);
      else if (e.type === 'end') log.push(`end:${e.req.reason}:${e.req.whTotal}Wh`);
      else if (e.type === 'guest-revoke') log.push('revoke');
    },
    ...s.chain,
  });
  const metered: MeteredCharger = new MeteredCharger({
    port,
    stepWh: 100,
    pollMs: POLL,
    sleep: clock.sleep,
    now: clock.now,
    onEvent: (e) => {
      if (e.type === 'reading') {
        readings.push({ metered: e.meteredWh, paid: e.paidWh, phase });
        s.onReading?.(e.reading, metered);
      } else if (e.type === 'stop-request') {
        phase = 'ending';
        log.push(`stop:${e.reason}`);
      } else if (e.type === 'drain') {
        phase = 'ending';
        log.push('drain');
      } else if (e.type === 'off') {
        phase = 'ending';
        log.push(e.ok ? 'off' : 'off-failed');
      } else if (e.type === 'on') log.push('on');
      else if (e.type === 'warning') log.push(`warning:${e.message}`);
    },
    ...s.metered,
  });
  const base: ChargerChain = s.wrapChain ? s.wrapChain(chain) : chain;
  const session = new ChargerSession({
    session: sessionKey,
    owner,
    priceMicroPerKWh: PRICE,
    chain: withMeteredEnd(base, metered),
    charger: metered,
    sleep: clock.sleep,
    pollIntervalMs: POLL,
  });
  metered.bindSession(session);
  return { clock, sim, chain, metered, session, log, readings };
}

/** Pull before deliver: while charging, the metered energy never exceeds the paid energy. */
function expectPaidAhead(readings: { metered: number; paid: number; phase: string }[]) {
  const charging = readings.filter((r) => r.phase === 'charging');
  expect(charging.length).toBeGreaterThan(10);
  for (const r of charging) expect(r.metered).toBeLessThanOrEqual(r.paid);
}

describe('MeteredCharger + ChargerSession (continuous charger)', () => {
  it('pays step 1 before switching on, stays one step ahead, and drains the paid energy on a cap stop', async () => {
    const t = setup({ capSteps: 3 });
    const result = await t.session.start();
    expect(result.reason).toBe('cap');
    expect(result.payments).toBe(3);
    // pay #1 confirms before the charger is switched on; pay #2 follows at once (one step ahead);
    // pay #3 when step 1 is metered. The cap then ends the session and the paid 300 Wh are delivered.
    expect(t.log.slice(0, 4)).toEqual(['pay#1@0Wh', 'on', 'pay#2@0Wh', expect.stringMatching(/^pay#3@1\d\dWh$/)]);
    expect(t.log.slice(4, 6)).toEqual(['drain', 'off']);
    expectPaidAhead(t.readings);
    const final = t.metered.meteredWh;
    expect(final).toBeGreaterThanOrEqual(300);
    expect(final).toBeLessThan(300 + (11_000 * POLL) / 3_600_000 + 1);
    // The end memo carries the metered energy, not the step count; the guest got all 300 paid Wh.
    expect(t.chain.ends[0]).toMatchObject({ reason: 'cap', whTotal: Math.floor(final), totalMicro: 3n * STEP });
    expect(t.log.at(-1)).toBe(`end:cap:${Math.floor(final)}Wh`);
    expect((await t.sim.read()).enabled).toBe(false);
    expect(t.sim.calls).toEqual(['start', 'stop']);
    expect(t.chain.sessionLamports).toBe(0n);
  });

  it('an operator stop still delivers the energy already paid for, then switches off', async () => {
    const t = setup({
      onReading: (_r, m) => {
        if (m.meteredWh >= 150) m.requestStop('user', 'operator pressed Ctrl+C', { drain: true });
      },
    });
    const result = await t.session.start();
    expect(result.reason).toBe('user');
    expect(t.log.filter((l) => l.startsWith('stop:'))).toEqual(['stop:user']);
    expect(t.log).toContain('drain');
    expect(t.metered.paidWh).toBe(300); // two steps were paid ahead of the meter at the stop
    const final = t.metered.meteredWh;
    expect(final).toBeGreaterThanOrEqual(300);
    expect(t.chain.ends[0]).toMatchObject({ reason: 'user', whTotal: Math.floor(final), totalMicro: 3n * STEP });
    expectPaidAhead(t.readings);
  });

  it('skipDrain() (second Ctrl+C) switches off at once; the memo reports the metered energy', async () => {
    const t = setup({
      onReading: (_r, m) => {
        if (m.meteredWh >= 150) {
          m.requestStop('user', 'operator pressed Ctrl+C', { drain: true });
          m.skipDrain();
        }
      },
    });
    const result = await t.session.start();
    expect(result.reason).toBe('user');
    const final = t.metered.meteredWh;
    expect(final).toBeGreaterThanOrEqual(150);
    expect(final).toBeLessThan(170);
    expect(t.chain.ends[0]).toMatchObject({ reason: 'user', whTotal: Math.floor(final), totalMicro: 3n * STEP });
  });

  it('a stop that arrives while pay #1 confirms still switches on and delivers the paid step', async () => {
    const ref: { metered?: MeteredCharger } = {};
    const t = setup({
      chain: {
        onEvent: (e) => {
          if (e.type === 'pay' && e.req.seq === 1) ref.metered?.requestStop('user', 'operator stop', { drain: true });
        },
      },
    });
    ref.metered = t.metered;
    const result = await t.session.start();
    expect(result).toMatchObject({ reason: 'user', payments: 1 });
    expect(t.sim.calls).toEqual(['start', 'stop']);
    expect(t.metered.meteredWh).toBeGreaterThanOrEqual(100);
    expect(t.chain.ends[0].whTotal).toBe(Math.floor(t.metered.meteredWh));
  });

  it('delivers the paid energy after the guest revokes, then ends with revoked', async () => {
    const t = setup({ chain: { revokeAfterPayments: 3 } });
    const result = await t.session.start();
    expect(result.reason).toBe('revoked');
    expect(result.payments).toBe(3);
    expect(t.log).toContain('drain');
    expect(t.metered.meteredWh).toBeGreaterThanOrEqual(300);
    expect(t.chain.ends[0].whTotal).toBe(Math.floor(t.metered.meteredWh));
    expectPaidAhead(t.readings);
  });

  it('ends with full when the car is unplugged (two consecutive reads), without draining', async () => {
    const t = setup({
      onReading: (_r, m) => {
        if (m.meteredWh >= 120) t.sim.unplug();
      },
    });
    const result = await t.session.start();
    expect(result.reason).toBe('full');
    expect(t.log).toContain('stop:full');
    expect(t.log).not.toContain('drain');
    expect(t.metered.stopCause?.message).toBe('vehicle unplugged');
    expect(t.metered.meteredWh).toBeLessThan(130);
  });

  it('ends with full when the car stops taking energy for the idle timeout', async () => {
    const t = setup({ sim: { fullAtWh: 150 }, metered: { idleTimeoutMs: 60_000 } });
    const result = await t.session.start();
    expect(result.reason).toBe('full');
    expect(t.metered.stopCause?.message).toContain('no energy for 60 s');
    expect(t.metered.meteredWh).toBeCloseTo(150, 5);
    expect(t.chain.ends[0].whTotal).toBe(150);
  });

  it('ends with user when charging is switched off outside the bridge (evcc UI)', async () => {
    let externallyOff = false;
    const t = setup({
      port: (sim) => ({
        label: 'wrapped sim',
        start: () => sim.start(),
        stop: () => sim.stop(),
        readSessionWh: () => sim.readSessionWh(),
        read: async () => ({ ...(await sim.read()), ...(externallyOff ? { enabled: false } : {}) }),
      }),
      onReading: (_r, m) => {
        if (m.meteredWh >= 50) externallyOff = true;
      },
    });
    const result = await t.session.start();
    expect(result.reason).toBe('user');
    expect(t.metered.stopCause?.message).toContain('outside the bridge');
  });

  it('ends with error after repeated charger read failures, still switches off and refunds', async () => {
    let failing = false;
    const stops: string[] = [];
    const t = setup({
      port: (sim) => ({
        label: 'flaky sim',
        start: () => sim.start(),
        stop: async () => {
          stops.push('stop');
          await sim.stop();
        },
        readSessionWh: () => sim.readSessionWh(),
        read: async () => {
          if (failing) throw new Error('connect ECONNREFUSED');
          const r = await sim.read();
          if (r.sessionWh >= 60) failing = true;
          return r;
        },
      }),
    });
    const result = await t.session.start();
    expect(result.reason).toBe('error');
    expect(t.metered.stopCause?.message).toContain('charger unreachable after 5 attempts');
    expect(stops).toEqual(['stop']);
    expect(result.endSig).toBe('mock:end');
    expect(result.refundLamports).toBeGreaterThan(0n);
  });

  it('ends with error when the charger cannot be switched on, and still tries to switch it off', async () => {
    const calls: string[] = [];
    const t = setup({
      port: (sim) => ({
        label: 'broken sim',
        start: async () => {
          calls.push('start');
          throw new Error('HTTP 500');
        },
        stop: async () => {
          calls.push('stop');
          await sim.stop();
        },
        readSessionWh: () => sim.readSessionWh(),
        read: () => sim.read(),
      }),
    });
    const result = await t.session.start();
    expect(result.reason).toBe('error');
    expect(calls).toEqual(['start', 'start', 'start', 'stop']);
    expect(t.chain.ends[0].whTotal).toBe(0);
  });

  it('never switches the charger on when stopped before a guest paid', async () => {
    const t = setup({ chain: { startAfterMs: 60_000 } });
    const run = t.session.start();
    t.metered.requestStop('user', 'operator stop');
    const result = await run;
    expect(result).toMatchObject({ reason: 'user', endSig: null, payments: 0 });
    expect(t.sim.calls).toEqual([]);
    expect(t.chain.ends).toEqual([]);
  });

  it('with lead 0, pulls exactly at the step boundaries', async () => {
    const t = setup({ capSteps: 3, metered: { leadWh: 0 } });
    const result = await t.session.start();
    expect(result.reason).toBe('cap');
    const pays = t.log.filter((l) => l.startsWith('pay#'));
    expect(pays[0]).toBe('pay#1@0Wh');
    expect(pays[1]).toMatch(/^pay#2@1\d\dWh$/);
    expect(pays[2]).toMatch(/^pay#3@2\d\dWh$/);
  });

  it('runs the energy shutdown once even when the end tx is retried', async () => {
    let endFailures = 1;
    const t = setup({
      capSteps: 2,
      wrapChain: (chain) => ({
        ...bind(chain),
        async end(req) {
          if (endFailures-- > 0) throw new Error('RPC hiccup');
          return chain.end(req);
        },
      }),
    });
    const result = await t.session.start();
    expect(result.reason).toBe('cap');
    expect(result.endSig).toBe('mock:end');
    expect(t.sim.calls.filter((c) => c === 'stop')).toHaveLength(1);
  });
});

describe('MeteredCharger safety warnings', () => {
  it('warns when the charger keeps charging after it was switched off, and still settles the session', async () => {
    // Like evcc's fixed-value `demo-charger` template: energy keeps flowing whatever the mode says.
    const t = setup({
      capSteps: 2,
      metered: { settleTimeoutMs: 10_000 },
      port: (sim) => ({
        label: 'stuck charger',
        start: () => sim.start(),
        stop: async () => {},
        readSessionWh: () => sim.readSessionWh(),
        read: () => sim.read(),
      }),
    });
    const result = await t.session.start();
    expect(result.reason).toBe('cap');
    expect(result.endSig).toBe('mock:end');
    expect(t.log).toContain('warning:stuck charger still reports charging after it was switched off; check the charger');
  });
});

function bind(chain: ChargerChain): ChargerChain {
  return {
    findStartTx: (s) => chain.findStartTx(s),
    getAllowance: (a) => chain.getAllowance(a),
    getSolBalance: (a) => chain.getSolBalance(a),
    getRentExemptMinimum: (b) => chain.getRentExemptMinimum(b),
    pay: (r) => chain.pay(r),
    end: (r) => chain.end(r),
  };
}
