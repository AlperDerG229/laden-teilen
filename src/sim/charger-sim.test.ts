import { describe, expect, it } from 'vitest';
import { ChargerSim, parseSpeed, stepDurationMs } from './charger-sim.ts';

/** Manual clock: sleep() advances time instantly. */
function clock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe('ChargerSim', () => {
  it('speed=60 means 1 kWh per minute: 100 Wh take 6 s', () => {
    expect(stepDurationMs(100, 60)).toBe(6_000);
    expect(stepDurationMs(100, 11)).toBeCloseTo(32_727, 0); // real time at 11 kW
  });

  it('parses ?speed= defensively', () => {
    expect(parseSpeed('600')).toBe(600);
    expect(parseSpeed('0')).toBe(60);
    expect(parseSpeed('-1')).toBe(60);
    expect(parseSpeed('abc')).toBe(60);
    expect(parseSpeed(null)).toBe(60);
  });

  it('delivers exactly the requested energy and animates in between', async () => {
    const c = clock();
    const sim = new ChargerSim({ speed: 60, now: c.now, sleep: c.sleep, tickMs: 1_000 });
    const seen: number[] = [];
    sim.subscribe(() => seen.push(sim.getSnapshot().sessionWh));
    const t0 = c.now();
    await sim.deliver(100);
    expect(c.now() - t0).toBe(6_000);
    expect(sim.getSnapshot()).toMatchObject({ sessionWh: 100, delivering: false });
    expect(seen.some((wh) => wh > 0 && wh < 100)).toBe(true);
  });

  it('keeps the step cadence by subtracting the payment time from the next step', async () => {
    const c = clock();
    const sim = new ChargerSim({ speed: 60, now: c.now, sleep: c.sleep, tickMs: 500 });
    await sim.deliver(100);
    c.advance(2_000); // pay #2 took 2 s
    const t1 = c.now();
    await sim.deliver(100);
    expect(c.now() - t1).toBe(4_000);
    c.advance(10_000); // a very slow payment: still animate at least 30%
    const t2 = c.now();
    await sim.deliver(100);
    expect(c.now() - t2).toBe(6_000); // gap >= nominal -> full nominal duration
    expect(sim.getSnapshot().sessionWh).toBe(300);
  });

  it('reports "car full" on the button and on unplug during a session, not before energy flowed', async () => {
    const c = clock();
    const sim = new ChargerSim({ speed: 36_000, now: c.now, sleep: c.sleep });
    let full = 0;
    sim.onFull = () => full++;
    sim.setPlugged(false); // waiting for a guest: just unplugged, no session to end
    expect(full).toBe(0);
    sim.setPlugged(true);
    expect(sim.getSnapshot().full).toBe(false);
    await sim.deliver(100);
    sim.setPlugged(false); // mid-session: counts as full
    expect(full).toBe(1);
    sim.setFull(); // every press notifies; the kiosk ignores it unless charging
    expect(full).toBe(2);
    expect(sim.getSnapshot()).toMatchObject({ plugged: false, full: true });
    // A paid step never hangs on a missing plug once the session is ending.
    await sim.deliver(100);
    expect(sim.getSnapshot().sessionWh).toBe(200);
  });

  it('waits for the car to be plugged in before delivering a paid step', async () => {
    const c = clock();
    const sim = new ChargerSim({ plugged: false, speed: 600, now: c.now, sleep: c.sleep });
    const p = sim.deliver(100);
    // The first wait happens synchronously up to the first sleep; plug in afterwards.
    await Promise.resolve();
    const waited = sim.getSnapshot().waitingForPlug;
    sim.setPlugged(true);
    await p;
    expect(waited).toBe(true);
    expect(sim.getSnapshot().sessionWh).toBe(100);
  });

  it('resumes the session meter at a given energy', () => {
    const sim = new ChargerSim();
    sim.resetSession(700);
    expect(sim.getSnapshot().sessionWh).toBe(700);
  });
});
