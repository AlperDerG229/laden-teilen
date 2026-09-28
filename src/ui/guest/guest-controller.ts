// Guest side of one charging session (spec 6.3): checks -> start (one approval) -> live view ->
// stop & revoke (second approval) -> receipt. Everything it shows is read from the chain; the
// only local state is a small record per session key so the guest can close the tab and return.
//
// Not React: screens subscribe via getSnapshot/subscribe.
import type { Address, TransactionSigner } from '@solana/kit';
import { parseEurToMicro, stepMicro as priceStep } from '../../core/amounts.ts';
import { buildStartIxs, buildStopIxs, type StartInfo } from '../../core/chain.ts';
import { CAP_CHOICES_EUR, FEE_DEPOSIT_LAMPORTS, POLL_INTERVAL_MS, STEP_WH } from '../../core/config.ts';
import { errorMessage } from '../../core/errors.ts';
import { sidOf, type EndReason } from '../../core/memo.ts';
import { sleep as defaultSleep, type Sleep } from '../../core/throttle.ts';
import type { AppChain, ChainKind } from '../chain/types.ts';
import type { GuestParams } from '../links.ts';
import { nsKey, readJson, writeJson, type KeyValueStorage } from '../storage.ts';

/** Spec 6.3: SOL >= 0.006 (0.005 deposit + fees) and at least one step of EURC. */
export const MIN_GUEST_LAMPORTS = 6_000_000n;

export type GuestPhase = 'checking' | 'ready' | 'busy' | 'starting' | 'live' | 'stopping' | 'receipt';

export interface GuestWallet {
  kind: 'demo' | 'standard';
  address: Address;
  /** null while a standard wallet is not connected (read-only view of a running session). */
  signer: TransactionSigner | null;
  label: string;
}

export interface GuestBalances {
  lamports: bigint;
  tokenMicro: bigint;
  ataExists: boolean;
  delegate: Address | null;
  delegatedMicro: bigint;
}

export interface GuestPayment {
  seq: number;
  sig: string;
  whCum: number;
  amountMicro: bigint;
  blockTime: number | null;
}

export interface GuestEnd {
  sig: string;
  whTotal: number;
  totalMicro: bigint;
  reason: EndReason;
  refundLamports: bigint | null;
  blockTime: number | null;
}

export interface GuestSnapshot {
  phase: GuestPhase;
  sid: string;
  stepMicro: bigint;
  wallet: Omit<GuestWallet, 'signer'> & { canSign: boolean } | null;
  balances: GuestBalances | null;
  capEur: string;
  /** Problems that block "Start charging" (empty when ready). */
  blockers: ('no-wallet' | 'no-sol' | 'no-token-account' | 'no-token' | 'no-signer' | 'owner-wallet')[];
  /** The guest token account already has another delegate that the start tx would replace. */
  replacesDelegate: Address | null;
  busyBy: Address | null;
  startSig: string | null;
  stopSig: string | null;
  payments: GuestPayment[];
  whTotal: number;
  paidMicro: bigint;
  /** Remaining allowance for this session key (0 once revoked or used up). */
  allowanceMicro: bigint;
  delegateActive: boolean;
  end: GuestEnd | null;
  /** The action currently waiting for the wallet or the chain. */
  pending: 'start' | 'stop' | 'revoke' | null;
  /** Open the "Get test funds" panel: the wallet just chosen cannot pay for a start yet. */
  fundsPrompt: boolean;
  error: string | null;
  notice: string | null;
}

interface GuestRecord {
  v: 1;
  wallet: Address;
  walletKind: GuestWallet['kind'];
  startSig: string;
  capMicro: bigint;
  stopSig: string | null;
}

export interface GuestDeps {
  chain: AppChain;
  storage: KeyValueStorage;
  mode: ChainKind;
  params: GuestParams;
  pollIntervalMs?: number;
  sleep?: Sleep;
}

export function friendlyError(e: unknown): string {
  const msg = errorMessage(e);
  if (/reject|declin|denied|cancel/i.test(msg)) return 'The wallet request was declined. Nothing was sent.';
  if (/insufficient funds for fee|no record of a prior credit/i.test(msg)) return 'Not enough SOL for the network fee. Add devnet SOL and try again.';
  if (/0x1\b|insufficient funds/i.test(msg)) return 'Not enough EURC for this step. Add test EURC and try again.';
  if (/429|Too many requests/i.test(msg)) return 'The public devnet RPC is rate limiting requests. Wait a few seconds and try again.';
  return msg.length > 220 ? `${msg.slice(0, 220)}…` : msg;
}

export class GuestController {
  private snap: GuestSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly deps: GuestDeps;
  private readonly key: string;
  private readonly sleep: Sleep;
  private wake = new AbortController();
  private wallet: GuestWallet | null = null;
  private guestAta: Address | null = null;
  private disposed = false;
  private polling = false;
  private stoppedWaitingSince: number | null = null;

  constructor(deps: GuestDeps) {
    this.deps = deps;
    this.key = nsKey(deps.mode, `guest:${deps.params.session}`);
    this.sleep = deps.sleep ?? defaultSleep;
    this.snap = {
      phase: 'checking',
      sid: sidOf(deps.params.session),
      stepMicro: priceStep(deps.params.priceMicroPerKWh, STEP_WH),
      wallet: null,
      balances: null,
      capEur: deps.params.capEur,
      blockers: ['no-wallet'],
      replacesDelegate: null,
      busyBy: null,
      startSig: null,
      stopSig: null,
      payments: [],
      whTotal: 0,
      paidMicro: 0n,
      allowanceMicro: 0n,
      delegateActive: false,
      end: null,
      pending: null,
      fundsPrompt: false,
      error: null,
      notice: null,
    };
  }

  getSnapshot = (): GuestSnapshot => this.snap;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The wallet the guest chose last for this session (so the page can restore it). */
  get recordedWallet(): { address: Address; kind: GuestWallet['kind'] } | null {
    const rec = this.loadRecord();
    return rec ? { address: rec.wallet, kind: rec.walletKind } : null;
  }

  /** Initial check: a saved session for this key, a busy key, or ready for a new start. */
  async init(): Promise<void> {
    // Restartable: React StrictMode mounts, unmounts and mounts again.
    this.disposed = false;
    if (this.wake.signal.aborted) this.wake = new AbortController();
    const rec = this.loadRecord();
    if (rec) {
      this.patch({ phase: rec.stopSig ? 'stopping' : 'live', startSig: rec.startSig, stopSig: rec.stopSig });
      // Refresh once before returning, so a returning guest sees the current state immediately.
      let done = false;
      try {
        done = await this.pollOnce();
      } catch (e) {
        this.patch({ notice: `Live view is retrying (${friendlyError(e)}).` });
      }
      if (!done) this.startPolling();
      return;
    }
    try {
      const start = await this.deps.chain.findStartTx(this.deps.params.session);
      if (start) {
        this.patch({ phase: 'busy', busyBy: start.guest });
        return;
      }
    } catch (e) {
      this.patch({ notice: `Could not check the session yet (${friendlyError(e)}).` });
    }
    this.patch({ phase: 'ready' });
  }

  async setWallet(wallet: GuestWallet | null): Promise<void> {
    this.wallet = wallet;
    this.guestAta = wallet ? await this.deps.chain.findAta(wallet.address) : null;
    this.patch({ wallet: wallet ? { kind: wallet.kind, address: wallet.address, label: wallet.label, canSign: wallet.signer !== null } : null, error: null });
    if (this.snap.phase === 'busy' && wallet && this.snap.busyBy === wallet.address) {
      // The guest's own session (local record lost): reattach to the live view.
      const start = await this.deps.chain.findStartTx(this.deps.params.session).catch(() => null);
      if (start) this.adopt(start, wallet);
    }
    await this.refreshBalances();
    if (wallet && this.wallet === wallet && this.snap.phase === 'ready') {
      const needsFunds = this.snap.blockers.some((b) => b === 'no-sol' || b === 'no-token-account' || b === 'no-token');
      this.patch({ fundsPrompt: needsFunds });
    }
  }

  /** The guest closed the "Get test funds" panel. */
  dismissFundsPrompt(): void {
    this.patch({ fundsPrompt: false });
  }

  setCap(capEur: string): void {
    if ((CAP_CHOICES_EUR as readonly string[]).includes(capEur)) this.patch({ capEur });
  }

  async refreshBalances(): Promise<GuestBalances | null> {
    const w = this.wallet;
    if (!w || !this.guestAta) {
      this.patch({ balances: null, blockers: ['no-wallet'], replacesDelegate: null });
      return null;
    }
    try {
      const [lamports, acc] = await Promise.all([this.deps.chain.getSolBalance(w.address), this.deps.chain.getAllowance(this.guestAta)]);
      if (this.wallet !== w) return null;
      const balances: GuestBalances = {
        lamports,
        tokenMicro: acc.balanceMicro,
        ataExists: acc.exists,
        delegate: acc.delegate,
        delegatedMicro: acc.delegatedMicro,
      };
      const blockers: GuestSnapshot['blockers'] = [];
      // Paying yourself would be an SPL self-transfer, which never uses up the allowance.
      if (w.address === this.deps.params.owner) blockers.push('owner-wallet');
      if (!w.signer) blockers.push('no-signer');
      if (lamports < MIN_GUEST_LAMPORTS) blockers.push('no-sol');
      if (!acc.exists) blockers.push('no-token-account');
      else if (acc.balanceMicro < this.snap.stepMicro) blockers.push('no-token');
      const replacesDelegate = acc.delegate && acc.delegate !== this.deps.params.session ? acc.delegate : null;
      this.patch({ balances, blockers, replacesDelegate });
      return balances;
    } catch (e) {
      this.patch({ notice: `Could not read balances (${friendlyError(e)}).` });
      return null;
    }
  }

  /** "Start charging": one wallet approval (SOL deposit + ApproveChecked(cap) + memo). */
  async start(): Promise<void> {
    const w = this.wallet;
    if (!w?.signer || !this.guestAta || this.snap.pending) return;
    this.patch({ pending: 'start', error: null, notice: null });
    try {
      const balances = await this.refreshBalances();
      if (!balances || this.snap.blockers.length > 0) {
        this.patch({
          pending: null,
          error: this.snap.blockers.includes('owner-wallet')
            ? "This is the wallbox's payout wallet. Charge with another wallet."
            : 'Add test funds first (SOL for the fee deposit and EURC for at least one step).',
        });
        return;
      }
      const { session, priceMicroPerKWh } = this.deps.params;
      const taken = await this.deps.chain.findStartTx(session);
      if (taken) {
        this.patch({ pending: null, phase: 'busy', busyBy: taken.guest });
        return;
      }
      const capMicro = parseEurToMicro(this.snap.capEur);
      this.patch({ phase: 'starting' });
      const sig = await this.deps.chain.sendIxs(
        w.signer,
        buildStartIxs({ guest: w.signer, guestAta: this.guestAta, session, capMicro, sid: this.snap.sid, priceMicroPerKWh }),
      );
      writeJson(this.deps.storage, this.key, {
        v: 1,
        wallet: w.address,
        walletKind: w.kind,
        startSig: sig,
        capMicro,
        stopSig: null,
      } satisfies GuestRecord);
      this.patch({ phase: 'live', startSig: sig, pending: null, allowanceMicro: capMicro, delegateActive: true });
      this.startPolling();
    } catch (e) {
      this.patch({ phase: 'ready', pending: null, error: friendlyError(e) });
    }
  }

  /** "Stop & revoke": second approval (Revoke + memo). The wallbox then ends and refunds. */
  async stopAndRevoke(): Promise<void> {
    await this.revoke('stop');
  }

  /** Receipt: revoke an allowance that is still active (session ended by the wallbox). */
  async revokeLeftover(): Promise<void> {
    await this.revoke('revoke');
  }

  dispose(): void {
    this.disposed = true;
    this.wake.abort();
  }

  // -------------------------------------------------------------------------------------------

  private async revoke(kind: 'stop' | 'revoke'): Promise<void> {
    const w = this.wallet;
    if (this.snap.pending) return;
    if (!w?.signer || !this.guestAta) {
      this.patch({ error: 'Connect the wallet that started this session to sign the revoke.' });
      return;
    }
    const rec = this.loadRecord();
    if (rec && rec.wallet !== w.address) {
      this.patch({ error: `This session was started by ${rec.wallet.slice(0, 4)}…${rec.wallet.slice(-4)}. Connect that wallet to stop it.` });
      return;
    }
    this.patch({ pending: kind, error: null });
    try {
      const sig = await this.deps.chain.sendIxs(w.signer, buildStopIxs({ guest: w.signer, guestAta: this.guestAta, sid: this.snap.sid }));
      if (rec) writeJson(this.deps.storage, this.key, { ...rec, stopSig: sig });
      this.stoppedWaitingSince = Date.now();
      this.patch({ stopSig: sig, pending: null, phase: this.snap.phase === 'receipt' ? 'receipt' : 'stopping', delegateActive: false, allowanceMicro: 0n });
      this.startPolling();
    } catch (e) {
      this.patch({ pending: null, error: friendlyError(e) });
    }
  }

  private adopt(start: StartInfo, wallet: GuestWallet): void {
    writeJson(this.deps.storage, this.key, {
      v: 1,
      wallet: wallet.address,
      walletKind: wallet.kind,
      startSig: start.sig,
      capMicro: start.capMicro,
      stopSig: null,
    } satisfies GuestRecord);
    this.patch({ phase: 'live', startSig: start.sig, busyBy: null });
    this.startPolling();
  }

  private startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    void this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    const interval = this.deps.pollIntervalMs ?? POLL_INTERVAL_MS;
    while (!this.disposed) {
      try {
        const done = await this.pollOnce();
        if (done) break;
      } catch (e) {
        this.patch({ notice: `Live view is retrying (${friendlyError(e)}).` });
      }
      await this.sleep(interval, this.wake.signal);
    }
    this.polling = false;
  }

  /** One live-view refresh. Returns true once the receipt is complete. */
  private async pollOnce(): Promise<boolean> {
    const { chain, params } = this.deps;
    const sid = this.snap.sid;
    const rec = this.loadRecord();
    // The session key signs every pay and the end tx: one history query covers the session.
    const entries = await chain.listLtMemos(params.session, { max: 300 });
    const payments: GuestPayment[] = [];
    let endMemo: (typeof entries)[number] | null = null;
    for (const e of entries) {
      if (e.memo.sid !== sid) continue;
      if (e.memo.kind === 'pay') payments.push({ seq: e.memo.seq, sig: e.sig, whCum: e.memo.whCum, amountMicro: e.memo.amountMicro, blockTime: e.blockTime });
      else if (e.memo.kind === 'end' && !endMemo) endMemo = e;
    }
    payments.sort((a, b) => b.seq - a.seq);
    const whTotal = payments.reduce((m, p) => Math.max(m, p.whCum), 0);
    const paidMicro = payments.reduce((s, p) => s + p.amountMicro, 0n);

    const walletAddress = rec?.wallet ?? this.wallet?.address ?? null;
    const ata = walletAddress ? await chain.findAta(walletAddress) : null;
    const acc = ata ? await chain.getAllowance(ata) : null;
    const delegateActive = !!acc && acc.delegate === params.session;
    this.patch({ payments, whTotal, paidMicro, allowanceMicro: delegateActive ? acc!.delegatedMicro : 0n, delegateActive, notice: null });

    if (endMemo && endMemo.memo.kind === 'end') {
      let refund: bigint | null = this.snap.end?.refundLamports ?? null;
      if (refund === null && walletAddress) refund = await chain.getTransferredLamports(endMemo.sig, params.session, walletAddress).catch(() => null);
      const m = endMemo.memo;
      this.patch({
        phase: 'receipt',
        end: { sig: endMemo.sig, whTotal: m.whTotal, totalMicro: m.totalMicro, reason: m.reason, refundLamports: refund, blockTime: endMemo.blockTime },
      });
      // Keep watching only while an allowance is still active (the guest may revoke it here).
      return !delegateActive && refund !== null;
    }
    if (this.snap.phase === 'stopping' && this.stoppedWaitingSince && Date.now() - this.stoppedWaitingSince > 60_000) {
      this.patch({ notice: 'The wallbox has not sent the final receipt yet. Your allowance is revoked, so no further payments can be taken.' });
    }
    return false;
  }

  private loadRecord(): GuestRecord | null {
    const rec = readJson<GuestRecord>(this.deps.storage, this.key);
    return rec && rec.v === 1 && typeof rec.startSig === 'string' ? rec : null;
  }

  private patch(p: Partial<GuestSnapshot>): void {
    this.snap = { ...this.snap, ...p };
    for (const l of this.listeners) l();
  }
}

export const FEE_DEPOSIT_TEXT = `${Number(FEE_DEPOSIT_LAMPORTS) / 1e9} SOL`;
