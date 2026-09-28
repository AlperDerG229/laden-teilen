import { describe, expect, it } from 'vitest';
import { createRateLimiter, withRetry } from './throttle.ts';

/** A fake clock whose sleep() advances time instantly. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe('createRateLimiter', () => {
  it('allows a burst, then spaces requests at the configured rate', async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ ratePerSecond: 5, now: clock.now, sleep: clock.sleep });
    const times: number[] = [];
    for (let i = 0; i < 8; i++) {
      await limiter.acquire();
      times.push(clock.now());
    }
    expect(times.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(times[5]).toBe(200);
    expect(times[6]).toBe(400);
    expect(times[7]).toBe(600);
  });

  it('never exceeds the rate over a long run', async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ ratePerSecond: 5, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 55; i++) await limiter.acquire();
    // 5 burst tokens + 50 refilled at 5/s -> at least 10 s.
    expect(clock.now()).toBeGreaterThanOrEqual(10_000);
  });
});

describe('withRetry', () => {
  const noSleep = async () => {};

  it('retries retryable errors and eventually succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        if (++calls < 3) throw new Error('429');
        return 'ok';
      },
      { retries: 5, isRetryable: () => true, sleep: noSleep },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up after the retry budget', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('down');
        },
        { retries: 2, isRetryable: () => true, sleep: noSleep },
      ),
    ).rejects.toThrow('down');
    expect(calls).toBe(3);
  });

  it('does not retry non-retryable errors', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('program error');
        },
        { retries: 5, isRetryable: () => false, sleep: noSleep },
      ),
    ).rejects.toThrow('program error');
    expect(calls).toBe(1);
  });
});
