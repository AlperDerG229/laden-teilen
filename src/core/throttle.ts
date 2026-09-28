// Client-side RPC budget: a FIFO token-bucket rate limiter plus exponential backoff.

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** setTimeout-based sleep that resolves early when `signal` aborts. */
export const sleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });

export interface RateLimiter {
  /** Resolves when the caller may issue one request. Callers are served in FIFO order. */
  acquire(): Promise<void>;
}

export function createRateLimiter(opts: {
  ratePerSecond: number;
  burst?: number;
  now?: () => number;
  sleep?: Sleep;
}): RateLimiter {
  const { ratePerSecond } = opts;
  const burst = opts.burst ?? ratePerSecond;
  const now = opts.now ?? Date.now;
  const wait = opts.sleep ?? sleep;
  if (!(ratePerSecond > 0) || !(burst >= 1)) throw new Error('Invalid rate limiter settings');
  let tokens = burst;
  let last = now();
  let queue: Promise<void> = Promise.resolve();

  const take = async (): Promise<void> => {
    for (;;) {
      const t = now();
      tokens = Math.min(burst, tokens + ((t - last) / 1000) * ratePerSecond);
      last = t;
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      await wait(Math.ceil(((1 - tokens) / ratePerSecond) * 1000));
    }
  };

  return {
    acquire() {
      const turn = queue.then(take);
      queue = turn.catch(() => undefined);
      return turn;
    },
  };
}

export interface RetryOptions {
  retries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  isRetryable: (e: unknown) => boolean;
  /** Optional server hint (e.g. HTTP Retry-After) in ms. */
  retryAfterMs?: (e: unknown) => number | undefined;
  sleep?: Sleep;
  onRetry?: (e: unknown, attempt: number, delayMs: number) => void;
}

/** Runs `fn`, retrying retryable failures with exponential backoff and jitter. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 8_000;
  const wait = opts.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= opts.retries || !opts.isRetryable(e)) throw e;
      const backoff = Math.min(max, base * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      const delay = Math.max(backoff, opts.retryAfterMs?.(e) ?? 0);
      opts.onRetry?.(e, attempt + 1, delay);
      await wait(delay);
    }
  }
}
