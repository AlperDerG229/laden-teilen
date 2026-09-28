// Display formatting. Money stays bigint (micro-EURC, lamports) until it becomes a string.
import { formatMicro, formatSol } from '../core/amounts.ts';

/** 39000n -> "0.039", 5000000n -> "5.00" */
export const eur = (micro: bigint): string => formatMicro(micro, 2);

/** Wh -> kWh with fixed decimals: 600 -> "0.6" (1 decimal = one payment step). */
export const kwh = (wh: number, decimals = 1): string => (Math.max(0, wh) / 1000).toFixed(decimals);

/** Lamports -> SOL, at most 6 decimals, no trailing zeros: 3265000n -> "0.003265" */
export function sol(lamports: bigint): string {
  const rounded = (lamports / 1_000n) * 1_000n; // 6 decimals
  return formatSol(rounded);
}

export const shortAddr = (a: string, n = 4): string => (a.length <= n * 2 + 1 ? a : `${a.slice(0, n)}…${a.slice(-n)}`);

export const shortSig = (s: string): string => `${s.slice(0, 8)}…`;

export function clockTime(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return '—';
  return new Date(unixSeconds * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function dateTime(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return '—';
  const d = new Date(unixSeconds * 1000);
  return `${d.toLocaleDateString('en-CA')} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

export const END_REASON_TEXT: Record<string, string> = {
  user: 'Stopped at the wallbox',
  revoked: 'Guest stopped and revoked',
  cap: 'Spending cap used up',
  funds: 'Guest balance too low',
  full: 'Car full or unplugged',
  sol: 'Fee deposit used up',
  error: 'Stopped after an error',
};
