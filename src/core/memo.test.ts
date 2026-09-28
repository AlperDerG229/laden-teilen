import { describe, expect, it } from 'vitest';
import { decodeMemo, encodeMemo, sidOf, splitRpcMemo, type LtMemo } from './memo.ts';

/** Formats memo text the way getSignaturesForAddress returns it: "[<byteLength>] <text>". */
const rpc = (text: string) => `[${new TextEncoder().encode(text).length}] ${text}`;

const SID = 'Ab12Cd34';
const samples: LtMemo[] = [
  { kind: 'start', sid: SID, priceMicroPerKWh: 390000n, capMicro: 5000000n },
  { kind: 'pay', sid: SID, seq: 3, whCum: 300, amountMicro: 39000n },
  { kind: 'stop', sid: SID },
  { kind: 'end', sid: SID, whTotal: 500, totalMicro: 195000n, reason: 'revoked' },
];

describe('encodeMemo', () => {
  it('encodes every kind in the LT1 wire format', () => {
    expect(samples.map(encodeMemo)).toEqual([
      'LT1|start|Ab12Cd34|390000|5000000',
      'LT1|pay|Ab12Cd34|3|300|39000',
      'LT1|stop|Ab12Cd34',
      'LT1|end|Ab12Cd34|500|195000|revoked',
    ]);
  });

  it('rejects invalid fields', () => {
    expect(() => encodeMemo({ kind: 'stop', sid: 'Ab12|d34' })).toThrow();
    expect(() => encodeMemo({ kind: 'stop', sid: 'Ab12Cd3' })).toThrow();
    expect(() => encodeMemo({ kind: 'stop', sid: 'Ab12Cd30' })).toThrow(); // '0' is not base58
    expect(() => encodeMemo({ kind: 'pay', sid: SID, seq: 0, whCum: 0, amountMicro: 1n })).toThrow();
    expect(() => encodeMemo({ kind: 'pay', sid: SID, seq: 1.5, whCum: 0, amountMicro: 1n })).toThrow();
    expect(() => encodeMemo({ kind: 'start', sid: SID, priceMicroPerKWh: -1n, capMicro: 1n })).toThrow();
    expect(() => encodeMemo({ kind: 'end', sid: SID, whTotal: 0, totalMicro: 0n, reason: 'nope' as 'user' })).toThrow();
  });
});

describe('decodeMemo', () => {
  it('round-trips every kind', () => {
    for (const m of samples) expect(decodeMemo(encodeMemo(m))).toEqual(m);
  });

  it('round-trips every end reason', () => {
    for (const reason of ['user', 'revoked', 'cap', 'funds', 'full', 'sol', 'error'] as const) {
      const m: LtMemo = { kind: 'end', sid: SID, whTotal: 0, totalMicro: 0n, reason };
      expect(decodeMemo(rpc(encodeMemo(m)))).toEqual(m);
    }
  });

  it('strips the RPC "[len] " prefix', () => {
    expect(rpc('LT1|pay|Ab12Cd34|3|300|39000')).toBe('[28] LT1|pay|Ab12Cd34|3|300|39000');
    for (const m of samples) expect(decodeMemo(rpc(encodeMemo(m)))).toEqual(m);
  });

  it('finds the LT1 memo among several memos joined by "; "', () => {
    const joined = `${rpc('hello')}; ${rpc(encodeMemo(samples[1]))}`;
    expect(decodeMemo(joined)).toEqual(samples[1]);
  });

  it('splits by UTF-8 byte length, so foreign memos containing "; [n] " cannot shift the boundaries', () => {
    const foreign = 'Grüße; [5] hi';
    const joined = `${rpc(foreign)}; ${rpc(encodeMemo(samples[0]))}`;
    expect(splitRpcMemo(joined)).toEqual([foreign, encodeMemo(samples[0])]);
    expect(decodeMemo(joined)).toEqual(samples[0]);
  });

  it('ignores foreign memos', () => {
    expect(decodeMemo('[38] Game=2 Room=2 Player=7 Score=1200')).toBeNull();
    expect(decodeMemo('[32] 40c3d70113a248e3bef21a6876616548')).toBeNull();
    expect(decodeMemo('hello world')).toBeNull();
    expect(decodeMemo('[13] (unparseable)')).toBeNull();
    expect(decodeMemo('')).toBeNull();
    expect(decodeMemo(null)).toBeNull();
    expect(decodeMemo(undefined)).toBeNull();
  });

  it('rejects malformed LT1 memos', () => {
    const bad = [
      'LT2|stop|Ab12Cd34', // unknown version
      'LT1|stop', // missing sid
      'LT1|stop|Ab12Cd34|x', // extra field
      'LT1|pay|Ab12Cd34|3|300', // missing amount
      'LT1|pay|Ab12Cd34|0|300|39000', // seq starts at 1
      'LT1|pay|Ab12Cd34|3|300|039000', // non-canonical number
      'LT1|pay|Ab12Cd34|3|-300|39000', // negative
      'LT1|pay|Ab12Cd34|3|3e2|39000', // exponent
      'LT1|pay|Ab12Cd3O|3|300|39000', // 'O' is not base58
      'LT1|end|Ab12Cd34|500|195000|bored', // unknown reason
      'LT1|refund|Ab12Cd34', // unknown kind
    ];
    for (const raw of bad) expect(decodeMemo(raw), raw).toBeNull();
  });

  it('tolerates surrounding whitespace', () => {
    expect(decodeMemo(' LT1|stop|Ab12Cd34 ')).toEqual(samples[2]);
  });

  it('keeps large amounts exact (bigint)', () => {
    const m: LtMemo = { kind: 'start', sid: SID, priceMicroPerKWh: 1n, capMicro: 18446744073709551615n };
    expect(decodeMemo(encodeMemo(m))).toEqual(m);
  });
});

describe('sidOf', () => {
  it('takes the first 8 base58 characters of the session key', () => {
    expect(sidOf('gnjANn6HJYbphXyT8fUkG4AUUNueykpzJ3VuWf1EMRD')).toBe('gnjANn6H');
    expect(() => sidOf('0000000000')).toThrow();
  });
});
