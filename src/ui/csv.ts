// Owner dashboard CSV export (bookkeeping). Pure, unit-tested.
import { formatMicro } from '../core/amounts.ts';
import type { SessionSummary } from '../core/chain.ts';

const esc = (v: string | number | null | undefined): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const iso = (t: number | null): string => (t ? new Date(t * 1000).toISOString() : '');

export const CSV_HEADER = [
  'session_id',
  'start_utc',
  'end_utc',
  'duration_s',
  'energy_kwh',
  'amount_eurc',
  'payments',
  'guest_wallet',
  'first_tx',
  'last_tx',
  'cluster',
  'token_mint',
] as const;

export function sessionsCsv(
  sessions: readonly SessionSummary[],
  opts: { guests?: ReadonlyMap<string, string | null>; cluster: string; mint: string },
): string {
  const rows = sessions.map((s) => {
    const first = s.payments[0];
    const last = s.payments[s.payments.length - 1];
    const duration = s.firstBlockTime && s.lastBlockTime ? s.lastBlockTime - s.firstBlockTime : '';
    return [
      s.sid,
      iso(s.firstBlockTime),
      iso(s.lastBlockTime),
      duration,
      (s.whTotal / 1000).toFixed(1),
      formatMicro(s.totalMicro, 2),
      s.paymentCount,
      opts.guests?.get(s.sid) ?? '',
      first?.sig ?? '',
      last?.sig ?? '',
      opts.cluster,
      opts.mint,
    ]
      .map(esc)
      .join(',');
  });
  return [CSV_HEADER.join(','), ...rows].join('\r\n') + '\r\n';
}
