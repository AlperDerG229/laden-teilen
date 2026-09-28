import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../core/chain.ts';
import { sessionsCsv } from './csv.ts';

const pay = (seq: number, t: number) => ({ sig: `sig${seq}`, seq, whCum: seq * 100, amountMicro: 39_000n, blockTime: t, slot: BigInt(seq) });

describe('sessionsCsv', () => {
  it('writes one row per session with kWh, EURC, duration and tx ids', () => {
    const s: SessionSummary = {
      sid: 'Ab12Cd34',
      payments: [pay(1, 1_790_000_000), pay(2, 1_790_000_006), pay(3, 1_790_000_012)],
      paymentCount: 3,
      whTotal: 300,
      totalMicro: 117_000n,
      firstBlockTime: 1_790_000_000,
      lastBlockTime: 1_790_000_012,
    };
    const csv = sessionsCsv([s], { guests: new Map([['Ab12Cd34', 'Guest111']]), cluster: 'devnet', mint: 'Mint111' });
    const [header, row, end] = csv.split('\r\n');
    expect(header).toBe('session_id,start_utc,end_utc,duration_s,energy_kwh,amount_eurc,payments,guest_wallet,first_tx,last_tx,cluster,token_mint');
    expect(row).toBe('Ab12Cd34,2026-09-21T14:13:20.000Z,2026-09-21T14:13:32.000Z,12,0.3,0.117,3,Guest111,sig1,sig3,devnet,Mint111');
    expect(end).toBe('');
  });

  it('escapes commas and quotes', () => {
    const s: SessionSummary = { sid: 'Ab12Cd34', payments: [], paymentCount: 0, whTotal: 0, totalMicro: 0n, firstBlockTime: null, lastBlockTime: null };
    const csv = sessionsCsv([s], { guests: new Map([['Ab12Cd34', 'a,"b"']]), cluster: 'devnet', mint: 'M' });
    expect(csv.split('\r\n')[1]).toBe('Ab12Cd34,,,,0.0,0.00,0,"a,""b""",,,devnet,M');
  });
});
