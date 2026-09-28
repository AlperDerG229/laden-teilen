// On-chain memo format "LT1|<kind>|<sid>|...". Pure and unit-tested.
// Memos are claims written by whoever signs the tx; money movements must be verified separately
// (see verifyPayment in chain.ts).

export const MEMO_VERSION = 'LT1';

/** Why a session ended. 'error' (program/charger failure) extends the spec's list. */
export const END_REASONS = ['user', 'revoked', 'cap', 'funds', 'full', 'sol', 'error'] as const;
export type EndReason = (typeof END_REASONS)[number];

export type LtMemo =
  | { kind: 'start'; sid: string; priceMicroPerKWh: bigint; capMicro: bigint }
  | { kind: 'pay'; sid: string; seq: number; whCum: number; amountMicro: bigint }
  | { kind: 'stop'; sid: string }
  | { kind: 'end'; sid: string; whTotal: number; totalMicro: bigint; reason: EndReason };

const SID_RE = /^[1-9A-HJ-NP-Za-km-z]{8}$/; // 8 base58 characters
const UINT_RE = /^(0|[1-9]\d*)$/; // canonical unsigned integer, no leading zeros

/** Session id: the first 8 base58 characters of the session public key. */
export function sidOf(sessionAddress: string): string {
  const sid = sessionAddress.slice(0, 8);
  if (!SID_RE.test(sid)) throw new Error(`Not a base58 address: ${sessionAddress}`);
  return sid;
}

export const isEndReason = (value: string): value is EndReason => (END_REASONS as readonly string[]).includes(value);

function assertUint(value: bigint | number, name: string, min = 0): string {
  const ok = typeof value === 'bigint' ? value >= BigInt(min) : Number.isSafeInteger(value) && value >= min;
  if (!ok) throw new Error(`Invalid memo field ${name}: ${String(value)}`);
  return value.toString();
}

/** encodeMemo({ kind: 'pay', sid: 'Ab12Cd34', seq: 3, whCum: 300, amountMicro: 39000n }) -> 'LT1|pay|Ab12Cd34|3|300|39000' */
export function encodeMemo(m: LtMemo): string {
  if (!SID_RE.test(m.sid)) throw new Error(`Invalid session id: ${m.sid}`);
  const head = [MEMO_VERSION, m.kind, m.sid];
  switch (m.kind) {
    case 'start':
      return [...head, assertUint(m.priceMicroPerKWh, 'priceMicroPerKWh'), assertUint(m.capMicro, 'capMicro')].join('|');
    case 'pay':
      return [...head, assertUint(m.seq, 'seq', 1), assertUint(m.whCum, 'whCum'), assertUint(m.amountMicro, 'amountMicro')].join('|');
    case 'stop':
      return head.join('|');
    case 'end':
      if (!isEndReason(m.reason)) throw new Error(`Invalid end reason: ${String(m.reason)}`);
      return [...head, assertUint(m.whTotal, 'whTotal'), assertUint(m.totalMicro, 'totalMicro'), m.reason].join('|');
  }
}

/**
 * Splits the RPC `memo` field of getSignaturesForAddress into memo texts. The RPC formats each
 * memo as "[<byteLength>] <text>" and joins several memos with "; ". Plain text (no prefix) is
 * returned as-is, so decoding also works on raw memo instruction data.
 */
export function splitRpcMemo(raw: string): string[] {
  const bytes = new TextEncoder().encode(raw);
  const decoder = new TextDecoder();
  const fallback = [raw.replace(/^\[\d+\] /, '')];
  const parts: string[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    if (bytes[pos] !== 0x5b /* [ */) return fallback;
    let i = pos + 1;
    let len = 0;
    while (i < bytes.length && i - pos <= 7 && bytes[i] >= 0x30 && bytes[i] <= 0x39) len = len * 10 + (bytes[i++] - 0x30);
    if (i === pos + 1 || bytes[i] !== 0x5d /* ] */ || bytes[i + 1] !== 0x20) return fallback;
    const start = i + 2;
    const end = start + len;
    if (end > bytes.length) return fallback;
    parts.push(decoder.decode(bytes.subarray(start, end)));
    pos = end;
    if (pos < bytes.length) {
      if (bytes[pos] !== 0x3b /* ; */ || bytes[pos + 1] !== 0x20) return fallback;
      pos += 2;
    }
  }
  return parts.length > 0 ? parts : fallback;
}

function toUint(field: string | undefined, min = 0): number | null {
  if (field === undefined || !UINT_RE.test(field)) return null;
  const n = Number(field);
  return Number.isSafeInteger(n) && n >= min ? n : null;
}

const toBig = (field: string | undefined): bigint | null =>
  field !== undefined && UINT_RE.test(field) ? BigInt(field) : null;

function decodeSingle(text: string): LtMemo | null {
  const f = text.trim().split('|');
  if (f[0] !== MEMO_VERSION || f[2] === undefined || !SID_RE.test(f[2])) return null;
  const sid = f[2];
  switch (f[1]) {
    case 'start': {
      const priceMicroPerKWh = toBig(f[3]);
      const capMicro = toBig(f[4]);
      if (f.length !== 5 || priceMicroPerKWh === null || capMicro === null) return null;
      return { kind: 'start', sid, priceMicroPerKWh, capMicro };
    }
    case 'pay': {
      const seq = toUint(f[3], 1);
      const whCum = toUint(f[4]);
      const amountMicro = toBig(f[5]);
      if (f.length !== 6 || seq === null || whCum === null || amountMicro === null) return null;
      return { kind: 'pay', sid, seq, whCum, amountMicro };
    }
    case 'stop':
      return f.length === 3 ? { kind: 'stop', sid } : null;
    case 'end': {
      const whTotal = toUint(f[3]);
      const totalMicro = toBig(f[4]);
      const reason = f[5];
      if (f.length !== 6 || whTotal === null || totalMicro === null || reason === undefined || !isEndReason(reason)) return null;
      return { kind: 'end', sid, whTotal, totalMicro, reason };
    }
    default:
      return null;
  }
}

/**
 * Decodes an LT1 memo. Tolerant of the RPC "[len] " prefix and of several memos in one tx.
 * Returns null for foreign or malformed memos (and for null/undefined input).
 */
export function decodeMemo(raw: string | null | undefined): LtMemo | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  for (const part of splitRpcMemo(raw)) {
    const memo = decodeSingle(part);
    if (memo) return memo;
  }
  return null;
}
