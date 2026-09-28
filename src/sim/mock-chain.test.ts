import { getTransferCheckedInstruction } from '@solana-program/token';
import { createNoopSigner, generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { buildPayIxs, buildStartIxs, buildStopIxs } from '../core/chain.ts';
import { TOKEN } from '../core/config.ts';
import { ChainError } from '../core/errors.ts';
import { sidOf } from '../core/memo.ts';
import { ChargerSession } from '../core/session.ts';
import { createMemoryLedgerStore, createMockChain } from './mock-chain.ts';
import { deserializeLedger, rentExemptMinimum, serializeLedger } from './mock-ledger.ts';

const PRICE = 390_000n;
const STEP = 39_000n;
const fast = { sendLatencyMs: [0, 0] as const, readLatencyMs: [0, 0] as const };
const noSleep = async () => {};

async function setup(cap = 5_000_000n) {
  const store = createMemoryLedgerStore();
  const chain = createMockChain({ ...fast, store });
  const [guest, session, owner] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
  await chain.requestTestFunds(guest.address); // 1 SOL + 20 EURC (MOCK faucet)
  const guestAta = await chain.findAta(guest.address);
  const sid = sidOf(session.address);
  const start = () =>
    chain.sendIxs(guest, buildStartIxs({ guest, guestAta, session: session.address, capMicro: cap, sid, priceMicroPerKWh: PRICE }));
  return { store, chain, guest, session, owner, guestAta, sid, start };
}

describe('MOCK chain', () => {
  it('runs a full session with the real core ChargerSession: start, 3 pulls, guest revoke, end + refund', async () => {
    const { chain, guest, session, owner, guestAta, sid, start } = await setup();
    const startSig = await start();

    const info = await chain.findStartTx(session.address);
    expect(info).toMatchObject({ sig: startSig, guest: guest.address, guestAta, capMicro: 5_000_000n, priceMicroPerKWh: PRICE, sid, depositLamports: 5_000_000n });

    let kiosk: ChargerSession;
    const charger = {
      async deliver() {
        if (kiosk.progress.payments === 3) await chain.sendIxs(guest, buildStopIxs({ guest, guestAta, sid }));
      },
    };
    kiosk = new ChargerSession({ session, owner: owner.address, priceMicroPerKWh: PRICE, chain: chain.charger(), charger, sleep: noSleep });
    const result = await kiosk.start();

    expect(result).toMatchObject({ reason: 'revoked', payments: 3, whDelivered: 300, totalMicro: 3n * STEP });
    expect(result.endSig).toBeTruthy();
    // The session key is swept to exactly 0 and the guest got the refund.
    expect(await chain.getSolBalance(session.address)).toBe(0n);
    const refund = await chain.getTransferredLamports(result.endSig!, session.address, guest.address);
    expect(refund).toBe(result.refundLamports);
    // deposit - ATA rent - 4 tx fees (3 pulls + end)
    expect(refund).toBe(5_000_000n - rentExemptMinimum(165) - 4n * 5_000n);

    const ownerAta = await chain.findAta(owner.address);
    const allowance = await chain.getAllowance(guestAta);
    expect(allowance).toMatchObject({ delegate: null, balanceMicro: 20_000_000n - 3n * STEP });
    expect((await chain.getAllowance(ownerAta)).balanceMicro).toBe(3n * STEP);

    const payments = await chain.listSessionPayments(ownerAta, sid);
    expect(payments.map((p) => [p.seq, p.whCum, p.amountMicro])).toEqual([
      [1, 100, STEP],
      [2, 200, STEP],
      [3, 300, STEP],
    ]);
    // The guest and the session key see the same pay memos.
    expect((await chain.listSessionPayments(guestAta, sid)).length).toBe(3);
    expect((await chain.listLtMemos(session.address)).map((e) => e.memo.kind)).toEqual(['end', 'pay', 'pay', 'pay', 'start']);

    const sessions = await chain.listOwnerSessions(owner.address);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sid, paymentCount: 3, whTotal: 300, totalMicro: 3n * STEP });

    const end = await chain.findSessionEnd(guest.address, sid);
    expect(end).toMatchObject({ sig: result.endSig, whTotal: 300, totalMicro: 3n * STEP, reason: 'revoked' });

    const v = await chain.verifyPayment(payments[1].sig, ownerAta);
    expect(v).toMatchObject({ ok: true, receivedMicro: STEP, payer: guest.address });
  });

  it('ends with "cap" when the allowance is used up exactly (the token program clears the delegate)', async () => {
    const { chain, guestAta, session, owner, start } = await setup(2n * STEP);
    await start();
    const kiosk = new ChargerSession({
      session,
      owner: owner.address,
      priceMicroPerKWh: PRICE,
      chain: chain.charger(),
      charger: { deliver: async () => {} },
      sleep: noSleep,
    });
    const result = await kiosk.start();
    expect(result).toMatchObject({ reason: 'cap', payments: 2 });
    expect((await chain.getAllowance(guestAta)).delegate).toBeNull();
  });

  it('rejects a pull above the remaining allowance and a pull after revoke, without changing state', async () => {
    const { chain, store, guest, guestAta, session, owner, sid, start } = await setup(STEP + 1n);
    await start();
    const ownerAta = await chain.findAta(owner.address);
    const pay = (seq: number, createOwnerAta: boolean) =>
      buildPayIxs({ session, guestAta, owner: owner.address, ownerAta, amountMicro: STEP, seq, whCum: seq * 100, sid, createOwnerAta });

    await chain.sendIxs(session, await pay(1, true));
    const before = serializeLedger(store.read());
    await expect(chain.sendIxs(session, await pay(2, false))).rejects.toThrow(/allowance/);
    expect(serializeLedger(store.read())).toBe(before);

    await chain.sendIxs(guest, buildStopIxs({ guest, guestAta, sid }));
    const err = await chain.sendIxs(session, await pay(2, false)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainError);
    expect((err as ChainError).kind).toBe('program');
  });

  it('enforces signatures: only the owner can approve or revoke', async () => {
    const { chain, guest, guestAta, session, sid } = await setup();
    const stranger = await generateKeyPairSigner();
    await chain.requestTestFunds(stranger.address);
    // The stranger signs as "guest" for someone else's token account: owner mismatch.
    const ixs = buildStartIxs({ guest: stranger, guestAta, session: session.address, capMicro: STEP, sid, priceMicroPerKWh: PRICE });
    await expect(chain.sendIxs(stranger, ixs)).rejects.toThrow(/owner does not match/);
    await expect(chain.sendIxs(stranger, buildStopIxs({ guest: stranger, guestAta, sid }))).rejects.toThrow(/owner does not match/);
    // The real owner can.
    await expect(chain.sendIxs(guest, buildStopIxs({ guest, guestAta, sid }))).resolves.toBeTruthy();
  });

  it('does not decrement the allowance on a self-transfer', async () => {
    const { chain, guestAta, session, start } = await setup(100_000n);
    await start();
    const selfTransfer = getTransferCheckedInstruction({
      source: guestAta,
      mint: TOKEN.mint,
      destination: guestAta,
      authority: session,
      amount: 50_000n,
      decimals: TOKEN.decimals,
    });
    await chain.sendIxs(session, [selfTransfer]);
    expect((await chain.getAllowance(guestAta)).delegatedMicro).toBe(100_000n);
  });

  it('refuses to leave a system account below its rent-exempt minimum', async () => {
    const { chain, guest } = await setup();
    const fresh = await generateKeyPairSigner();
    const { getTransferSolInstruction } = await import('@solana-program/system');
    await expect(chain.sendIxs(guest, [getTransferSolInstruction({ source: guest, destination: fresh.address, amount: 1_000n })])).rejects.toThrow(
      /insufficient funds for rent/,
    );
  });

  it('fails like devnet when a required signature is missing', async () => {
    const { chain, guest, guestAta, sid } = await setup();
    // A no-op signer stands for "the wallet never signed": Kit refuses to produce a sendable tx.
    const unsigned = createNoopSigner(guest.address);
    await expect(chain.sendIxs(unsigned, buildStopIxs({ guest: unsigned, guestAta, sid }))).rejects.toThrow(/missing signatures/i);
    // An unfunded fee payer is rejected before any instruction runs.
    const broke: KeyPairSigner = await generateKeyPairSigner();
    await expect(chain.sendIxs(broke, buildStopIxs({ guest, guestAta, sid }))).rejects.toThrow(/insufficient funds for fee/);
  });

  it('persists as a JSON snapshot with bigints intact', async () => {
    const { store, start } = await setup();
    await start();
    const copy = deserializeLedger(serializeLedger(store.read()));
    expect(copy).toEqual(store.read());
    expect(deserializeLedger('not json')).toEqual({ slot: 1, lamports: {}, tokens: {}, txs: [] });
  });

  it('rejects an owner token account address that is not the ATA', async () => {
    const { chain, guestAta, session, owner, sid, start } = await setup();
    await start();
    const wrongAta = (await generateKeyPairSigner()).address;
    await expect(
      buildPayIxs({ session, guestAta, owner: owner.address, ownerAta: wrongAta, amountMicro: STEP, seq: 1, whCum: 100, sid, createOwnerAta: true }),
    ).rejects.toThrow(/not the EURC ATA/);
    expect(await chain.getSolBalance(owner.address)).toBe(0n);
  });
});
