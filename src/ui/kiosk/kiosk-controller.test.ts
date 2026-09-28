import { generateKeyPairSigner, type Address, type KeyPairSigner } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { buildStartIxs, buildStopIxs } from '../../core/chain.ts';
import { sidOf } from '../../core/memo.ts';
import { ChargerSim } from '../../sim/charger-sim.ts';
import { createMemoryLedgerStore, createMockChain } from '../../sim/mock-chain.ts';
import type { AppChain } from '../chain/types.ts';
import { memoryStorage } from '../storage.ts';
import { KioskController, type KioskConfig, type KioskSnapshot } from './kiosk-controller.ts';

const PRICE = 390_000n;
const STEP = 39_000n;

function config(owner: Address, patch: Partial<KioskConfig> = {}): KioskConfig {
  return { owner, priceEur: '0.39', priceMicroPerKWh: PRICE, name: 'Test box', capEur: '5', ...patch };
}

async function until(k: KioskController, pred: (s: KioskSnapshot) => boolean, what: string, ms = 5_000): Promise<KioskSnapshot> {
  const t0 = Date.now();
  for (;;) {
    const s = k.getSnapshot();
    if (pred(s)) return s;
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify({ state: s.state, payments: s.payments.length, error: s.error, notice: s.notice })}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function env() {
  const chain = createMockChain({ store: createMemoryLedgerStore(), sendLatencyMs: [0, 0], readLatencyMs: [0, 0] });
  const [guest, owner] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  await chain.requestTestFunds(guest.address);
  const guestAta = await chain.findAta(guest.address);
  const storage = memoryStorage();
  return { chain, guest, owner, guestAta, storage };
}

function kiosk(chain: AppChain, storage: ReturnType<typeof memoryStorage>, sim = new ChargerSim({ speed: 36_000, tickMs: 1 })) {
  return new KioskController({ chain, sim, storage, mode: 'mock', pollIntervalMs: 5, pendingPayWaitMs: 200 });
}

async function guestStarts(chain: AppChain, guest: KeyPairSigner, guestAta: Address, session: Address, cap = 5_000_000n) {
  return chain.sendIxs(guest, buildStartIxs({ guest, guestAta, session, capMicro: cap, sid: sidOf(session), priceMicroPerKWh: PRICE }));
}

describe('KioskController', () => {
  it('shows a persisted session key, charges the guest, ends on Stop and rotates the key', async () => {
    const { chain, guest, owner, guestAta, storage } = await env();
    const k = kiosk(chain, storage);
    k.configure(config(owner.address));
    k.start();
    const waiting = await until(k, (s) => s.state === 'WAITING_FOR_GUEST' && s.session !== null, 'waiting');
    const session1 = waiting.session!.address;
    // The secret is persisted before the QR is shown.
    expect(Object.keys(storage.dump())).toContain('lt:mock:kiosk:v1');

    await guestStarts(chain, guest, guestAta, session1);
    await until(k, (s) => s.state === 'CHARGING' && s.payments.length >= 3, '3 payments');
    k.stopSession();
    const after = await until(k, (s) => s.last !== null && s.session !== null && s.session.address !== session1, 'a new key');

    expect(after.last).toMatchObject({ reason: 'user', guest: guest.address });
    expect(after.last!.payments).toBeGreaterThanOrEqual(3);
    expect(after.last!.totalMicro).toBe(BigInt(after.last!.payments) * STEP);
    expect(after.last!.feed.map((p) => p.seq)).toEqual([...Array(after.last!.payments).keys()].map((i) => after.last!.payments - i));
    expect(await chain.getSolBalance(session1)).toBe(0n); // deposit swept back
    const end = await chain.findSessionEnd(guest.address, sidOf(session1));
    expect(end?.reason).toBe('user');
    k.dispose();
  });

  it('resumes after a crash mid-session and continues with the next sequence number', async () => {
    const { chain, guest, owner, guestAta, storage } = await env();
    // Kiosk A "crashes": its charger hangs forever after the 2nd paid step.
    let delivered = 0;
    const hangingSim = new ChargerSim({ speed: 36_000, tickMs: 1 });
    const realDeliver = hangingSim.deliver.bind(hangingSim);
    hangingSim.deliver = async (wh: number) => {
      delivered++;
      if (delivered >= 2) return new Promise<void>(() => {}); // never resolves: page gone
      return realDeliver(wh);
    };
    const a = kiosk(chain, storage, hangingSim);
    a.configure(config(owner.address));
    a.start();
    const w = await until(a, (s) => s.session !== null, 'key');
    const session = w.session!.address;
    await guestStarts(chain, guest, guestAta, session);
    await until(a, (s) => s.payments.length === 2, '2 payments');

    // Kiosk B = the reloaded page: same storage, same chain.
    const b = kiosk(chain, storage);
    b.configure(config(owner.address));
    b.start();
    const resumed = await until(b, (s) => s.state === 'CHARGING' && s.payments.length >= 4, 'resumed payments');
    expect(resumed.resumed).toBe(true);
    expect(resumed.session?.address).toBe(session);
    // Step 2 was paid but not delivered before the crash: B delivers it first, then pulls #3, #4...
    const seqs = resumed.payments.map((p) => p.seq).reverse();
    expect(seqs.slice(0, 4)).toEqual([1, 2, 3, 4]);
    b.stopSession();
    const done = await until(b, (s) => s.last !== null, 'end');
    const ownerAta = await chain.findAta(owner.address);
    const payments = await chain.listSessionPayments(ownerAta, sidOf(session));
    expect(new Set(payments.map((p) => p.seq)).size).toBe(payments.length); // no step pulled twice
    expect(done.last!.whDelivered).toBe(payments.length * 100);
    b.dispose();
  });

  it('after a reload, finds an already ended session and starts a fresh key', async () => {
    const { chain, guest, owner, guestAta, storage } = await env();
    const a = kiosk(chain, storage);
    a.configure(config(owner.address));
    a.start();
    const session = (await until(a, (s) => s.session !== null, 'key')).session!.address;
    await guestStarts(chain, guest, guestAta, session, 2n * STEP);
    const ended = await until(a, (s) => s.last !== null, 'cap end');
    expect(ended.last?.reason).toBe('cap');
    a.dispose();

    const b = kiosk(chain, storage);
    b.configure(config(owner.address));
    b.start();
    const s = await until(b, (x) => x.state === 'WAITING_FOR_GUEST' && x.session !== null, 'new key');
    expect(s.session!.address).not.toBe(session);
    b.dispose();
  });

  it('replaces a waiting key when the settings change, and ends on a guest revoke', async () => {
    const { chain, guest, owner, guestAta, storage } = await env();
    const k = kiosk(chain, storage);
    k.configure(config(owner.address));
    k.start();
    const first = (await until(k, (s) => s.state === 'WAITING_FOR_GUEST' && s.session !== null, 'key')).session!.address;
    k.configure(config(owner.address, { priceEur: '0.45', priceMicroPerKWh: 450_000n }));
    const second = await until(k, (s) => s.session !== null && s.session.address !== first && s.state === 'WAITING_FOR_GUEST', 'replaced key');
    expect(second.config?.priceMicroPerKWh).toBe(450_000n);
    expect(second.last).toBeNull(); // no guest, nothing to report

    const session = second.session!.address;
    await chain.sendIxs(
      guest,
      buildStartIxs({ guest, guestAta, session, capMicro: 5_000_000n, sid: sidOf(session), priceMicroPerKWh: 450_000n }),
    );
    await until(k, (s) => s.payments.length >= 2, 'payments');
    await chain.sendIxs(guest, buildStopIxs({ guest, guestAta, sid: sidOf(session) }));
    const done = await until(k, (s) => s.last !== null, 'revoked');
    expect(done.last?.reason).toBe('revoked');
    expect(done.last?.refundLamports).toBeGreaterThan(0n);
    k.dispose();
  });

  it('ends at once and refunds when the guest wallet is the payout wallet (self-transfer)', async () => {
    const { chain, storage } = await env();
    const ownerSigner = await generateKeyPairSigner();
    await chain.requestTestFunds(ownerSigner.address);
    const ownerAta = await chain.findAta(ownerSigner.address);
    const k = kiosk(chain, storage);
    k.configure(config(ownerSigner.address));
    k.start();
    const session = (await until(k, (s) => s.session !== null, 'key')).session!.address;
    await guestStarts(chain, ownerSigner, ownerAta, session);
    const done = await until(k, (s) => s.last !== null, 'error end');
    expect(done.last).toMatchObject({ reason: 'error', payments: 0 });
    expect(await chain.getSolBalance(session)).toBe(0n);
    k.dispose();
  });

  it('refuses a start tx with another price and refunds the deposit', async () => {
    const { chain, guest, owner, guestAta, storage } = await env();
    const k = kiosk(chain, storage);
    k.configure(config(owner.address));
    k.start();
    const session = (await until(k, (s) => s.session !== null, 'key')).session!.address;
    const before = await chain.getSolBalance(guest.address);
    await chain.sendIxs(
      guest,
      buildStartIxs({ guest, guestAta, session, capMicro: 5_000_000n, sid: sidOf(session), priceMicroPerKWh: 1n * PRICE - 1_000n }),
    );
    const done = await until(k, (s) => s.last !== null, 'error end');
    expect(done.last).toMatchObject({ reason: 'error', payments: 0 });
    // Deposit back: the guest is out of pocket only the start fee and the end fee.
    expect(await chain.getSolBalance(guest.address)).toBe(before - 10_000n);
    k.dispose();
  });
});
