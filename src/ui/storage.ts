// Namespaced, failure-tolerant localStorage. MOCK and devnet state never share keys, so a MOCK
// session key or demo wallet can never show up in devnet mode (and vice versa).
import type { ChainKind } from './chain/types.ts';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const nsKey = (mode: ChainKind, name: string): string => `lt:${mode}:${name}`;

/** A storage that never throws (private mode, quota, SSR). */
export function safeStorage(backend: () => KeyValueStorage | undefined): KeyValueStorage {
  return {
    getItem(key) {
      try {
        return backend()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        backend()?.setItem(key, value);
      } catch {
        // ignore (quota / private mode)
      }
    },
    removeItem(key) {
      try {
        backend()?.removeItem(key);
      } catch {
        // ignore
      }
    },
  };
}

export const browserStorage: KeyValueStorage = safeStorage(() => (typeof localStorage === 'undefined' ? undefined : localStorage));

export function memoryStorage(): KeyValueStorage & { dump(): Record<string, string> } {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    dump: () => Object.fromEntries(m),
  };
}

/** JSON with bigints as {"$big": "..."}. */
export const toJson = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? { $big: v.toString() } : v));

export function fromJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text, (_k, v: unknown) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const o = v as Record<string, unknown>;
        if (Object.keys(o).length === 1 && typeof o.$big === 'string') return BigInt(o.$big);
      }
      return v;
    }) as T;
  } catch {
    return null;
  }
}

export const readJson = <T>(s: KeyValueStorage, key: string): T | null => fromJson<T>(s.getItem(key));
export const writeJson = (s: KeyValueStorage, key: string, value: unknown): void => s.setItem(key, toJson(value));
