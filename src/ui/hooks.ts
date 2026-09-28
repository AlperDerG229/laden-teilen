import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

interface Store<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

export const useStore = <T,>(store: Store<T>): T => useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

/**
 * Runs `fn` now and every `intervalMs` while mounted (and `enabled`). Pauses in hidden tabs.
 * Returns the latest value and error.
 */
export function usePolling<T>(fn: () => Promise<T>, intervalMs: number, deps: readonly unknown[], enabled = true) {
  const [state, setState] = useState<{ data: T | undefined; error: unknown; at: number }>({ data: undefined, error: undefined, at: 0 });
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!alive) return;
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        try {
          const data = await fnRef.current();
          if (alive) setState({ data, error: undefined, at: Date.now() });
        } catch (error) {
          if (alive) setState((s) => ({ ...s, error, at: Date.now() }));
        }
      }
      if (alive) timer = setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [...deps, intervalMs, enabled, nonce]);
  return { ...state, refresh: () => setNonce((n) => n + 1) };
}

/** Current time, re-rendering every `ms`. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
