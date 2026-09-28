import { describe, expect, it } from 'vitest';
import { formatKwh, formatMicro, formatSol, formatUnits, parseEurToMicro, parseUnits, stepMicro } from './amounts.ts';

describe('spec examples', () => {
  it('parses, prices a step and formats with bigint only', () => {
    expect(parseEurToMicro('0.39')).toBe(390000n);
    expect(stepMicro(390000n, 100)).toBe(39000n);
    expect(formatMicro(39000n)).toBe('0.039');
  });

  it('default cap of 5 EURC covers 128 steps at 0.39 EUR/kWh', () => {
    const cap = parseEurToMicro('5');
    const step = stepMicro(parseEurToMicro('0.39'), 100);
    expect(cap / step).toBe(128n);
    expect(cap % step).toBe(8000n);
  });
});

describe('parseUnits / parseEurToMicro', () => {
  it('accepts common inputs', () => {
    expect(parseEurToMicro('5')).toBe(5_000_000n);
    expect(parseEurToMicro('0,39')).toBe(390000n); // German decimal comma
    expect(parseEurToMicro('.5')).toBe(500000n);
    expect(parseEurToMicro('10.')).toBe(10_000_000n);
    expect(parseEurToMicro(' 1.000001 ')).toBe(1_000_001n);
    expect(parseEurToMicro('0')).toBe(0n);
    expect(parseUnits('0.005', 9)).toBe(5_000_000n);
  });

  it('rejects invalid input instead of rounding', () => {
    for (const bad of ['', 'abc', '-1', '1e3', '1.2.3', '1.0000001', '0x10', '1 000']) {
      expect(() => parseEurToMicro(bad), bad).toThrow();
    }
  });
});

describe('formatUnits / formatMicro / formatSol', () => {
  it('trims trailing zeros unless minDecimals is given', () => {
    expect(formatMicro(390000n)).toBe('0.39');
    expect(formatMicro(5_000_000n)).toBe('5');
    expect(formatMicro(5_000_000n, 2)).toBe('5.00');
    expect(formatMicro(195000n, 2)).toBe('0.195');
    expect(formatMicro(0n)).toBe('0');
    expect(formatMicro(1n)).toBe('0.000001');
    expect(formatMicro(-39000n)).toBe('-0.039');
    expect(formatUnits(12345n, 0)).toBe('12345');
  });

  it('round-trips with parse', () => {
    for (const s of ['0.39', '5', '0.039', '123.456789', '0.000001']) expect(formatMicro(parseEurToMicro(s))).toBe(s);
  });

  it('formats lamports and kWh', () => {
    expect(formatSol(1_488_440n)).toBe('0.00148844');
    expect(formatSol(5_000_000n)).toBe('0.005');
    expect(formatKwh(1250)).toBe('1.25');
    expect(formatKwh(100, 1)).toBe('0.1');
  });
});

describe('stepMicro', () => {
  it('rounds down in the guest\'s favour', () => {
    expect(stepMicro(123456n, 100)).toBe(12345n);
    expect(stepMicro(390000n, 1000)).toBe(390000n);
    expect(stepMicro(0n, 100)).toBe(0n);
  });

  it('rejects invalid inputs', () => {
    expect(() => stepMicro(-1n, 100)).toThrow();
    expect(() => stepMicro(390000n, 0)).toThrow();
    expect(() => stepMicro(390000n, 0.5)).toThrow();
  });
});
