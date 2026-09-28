import { generateKeyPairSigner, type Address } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { buildStartIxs } from '../../core/chain.ts';
import { sidOf } from '../../core/memo.ts';
import { ChargerSim } from '../../sim/charger-sim.ts';
import { createMemoryLedgerStore, createMockChain } from '../../sim/mock-chain.ts';
import { KioskController } from '../kiosk/kiosk-controller.ts';
import type { GuestParams } from '../links.ts';
import { memoryStorage } from '../storage.ts';
import { GuestController, friendlyError, type GuestSnapshot } from './guest-controller.ts';

const PRICE = 390_000n;

async function until<T>(get: () => T, pred: (v: T) => boolean, what: string, ms = 5_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = get();
    if (pred(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? `${x}n` : x)).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function world() {
  const chain = createMockChain({ store: createMemoryLedgerStore(), sendLatencyMs: [0, 0], readLatencyMs: [0, 0] });
  const owner = await generateKeyPairSigner();
  const storage = memoryStorage();
  const kiosk = new KioskController({ chain, sim: new ChargerSim({ speed: 36_000, tickMs: 1 }), storage, mode: 'mock', pollIntervalMs: 5 });
  kiosk.configure({ owner: owner.address, priceEur: '0.39', priceMicroPerKWh: PRICE, name: 'Garage', capEur: '5' });
  kiosk.start();
  const s = await until(kiosk.getSnapshot, (x) => x.state === 'WAITING_FOR_GUEST' && x.session !== null, 'kiosk waiting');
  const params: GuestParams = { session: s.session!.address, owner: owner.address, priceEur: '0.39', priceMicroPerKWh: PRICE, name: 'Garage', capEur: '5' };
  const guest = (p = params) => new GuestController({ chain, storage, mode: 'mock', params: p, pollIntervalMs: 5 });
  return { chain, owner, kiosk, params, guest };
}

describe('GuestController', () => {
  it('blocks the start until the wallet has SOL, a token account and one step of EURC', async () => {
    const { chain, guest, kiosk } = await world();
    const g = guest();
    await g.init();
    expect(g.getSnapshot().phase).toBe('ready');
    const w = await generateKeyPairSigner();
    await g.setWallet({ kind: 'demo', address: w.address, signer: w, label: 'Demo wallet' });
    expect(g.getSnapshot().blockers).toEqual(['no-sol', 'no-token-account']);
    await chain.requestTestFunds(w.address);
    await g.refreshBalances();
    expect(g.getSnapshot().blockers).toEqual([]);
    g.dispose();
    kiosk.dispose();
  });

  it('runs a whole session with the kiosk: start, live payments, stop & revoke, receipt with refund', async () => {
    const { chain, guest, kiosk, params } = await world();
    const g = guest();
    await g.init();
    const w = await generateKeyPairSigner();
    await chain.requestTestFunds(w.address);
    await g.setWallet({ kind: 'demo', address: w.address, signer: w, label: 'Demo wallet' });
    g.setCap('2');
    await g.start();
    expect(g.getSnapshot()).toMatchObject({ phase: 'live', delegateActive: true, error: null });

    await until(kiosk.getSnapshot, (s) => s.state === 'CHARGING', 'kiosk charging');
    const live = await until(g.getSnapshot, (s: GuestSnapshot) => s.payments.length >= 3, 'guest sees 3 payments');
    expect(live.allowanceMicro).toBeLessThan(2_000_000n);
    expect(live.payments[0].seq).toBeGreaterThan(live.payments[1].seq); // newest first

    await g.stopAndRevoke();
    const receipt = await until(g.getSnapshot, (s: GuestSnapshot) => s.phase === 'receipt' && s.end?.refundLamports != null, 'receipt');
    expect(receipt.end).toMatchObject({ reason: 'revoked' });
    expect(receipt.end!.refundLamports!).toBeGreaterThan(0n);
    expect(receipt.delegateActive).toBe(false);
    expect(receipt.whTotal).toBe(receipt.end!.whTotal);
    expect(receipt.paidMicro).toBe(receipt.end!.totalMicro);

    // The receipt survives a reload (new controller, same storage).
    const again = guest();
    await again.init();
    await until(again.getSnapshot, (s: GuestSnapshot) => s.phase === 'receipt', 'receipt after reload');

    // Someone else scanning the same (now used) QR is told it is busy.
    const other = guest(params);
    await other.init();
    expect(other.getSnapshot()).toMatchObject({ phase: 'receipt' }); // same browser: has the record
    const stranger = new GuestController({ chain, storage: memoryStorage(), mode: 'mock', params, pollIntervalMs: 5 });
    await stranger.init();
    expect(stranger.getSnapshot()).toMatchObject({ phase: 'busy', busyBy: w.address });
    g.dispose();
    again.dispose();
    other.dispose();
    stranger.dispose();
    kiosk.dispose();
  });

  it('warns when the token account already has another delegate', async () => {
    const { chain, guest, kiosk } = await world();
    const w = await generateKeyPairSigner();
    await chain.requestTestFunds(w.address);
    const ata = await chain.findAta(w.address);
    const elsewhere = (await generateKeyPairSigner()).address;
    await chain.sendIxs(w, buildStartIxs({ guest: w, guestAta: ata, session: elsewhere, capMicro: 1_000_000n, sid: sidOf(elsewhere), priceMicroPerKWh: PRICE }));
    const g = guest();
    await g.init();
    await g.setWallet({ kind: 'demo', address: w.address, signer: w, label: 'Demo wallet' });
    expect(g.getSnapshot().replacesDelegate).toBe(elsewhere as Address);
    g.dispose();
    kiosk.dispose();
  });

  it('turns wallet and RPC errors into plain sentences', () => {
    expect(friendlyError(new Error('User rejected the request.'))).toMatch(/declined/);
    expect(friendlyError(new Error('Simulation failed: insufficient funds for fee'))).toMatch(/SOL/);
    expect(friendlyError(new Error('HTTP error (429): Too Many Requests'))).toMatch(/rate limiting/);
  });
});
