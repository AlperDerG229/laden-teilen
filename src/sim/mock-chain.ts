// MOCK mode only: an in-memory implementation of the core ChainClient on top of mock-ledger.ts.
// Transactions are built and signed with Kit exactly like on devnet (so a missing signer fails
// here too), then executed by the ledger instead of being sent anywhere. Nothing touches the
// network. The UI enables this only via `?mock=1` and always shows a MOCK banner.
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  parseCreateAssociatedTokenIdempotentInstruction,
} from '@solana-program/token';
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase58Decoder,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type AccountMeta,
  type Address,
  type Blockhash,
  type Instruction,
  type ReadonlyUint8Array,
  type Signature,
  type TransactionSigner,
} from '@solana/kit';
import {
  buildEndIxs,
  createChargerChain,
  type Allowance,
  type LtMemoEntry,
  type Payment,
  type PaymentVerification,
  type SessionEnd,
  type SessionSummary,
  type SolanaRpc,
  type StartInfo,
} from '../core/chain.ts';
import { ATA_PROGRAM, TOKEN, type TokenConfig } from '../core/config.ts';
import { ChainError } from '../core/errors.ts';
import { decodeMemo, sidOf } from '../core/memo.ts';
import type { EndRequest } from '../core/session.ts';
import { sleep } from '../core/throttle.ts';
import type { AppChain } from '../ui/chain/types.ts';
import {
  LAMPORTS_PER_SIGNATURE,
  MockTxError,
  applyTransaction,
  deserializeLedger,
  emptyLedger,
  mintTestFunds,
  rentExemptMinimum,
  rpcMemoField,
  serializeLedger,
  txsForAddress,
  type MockLedgerState,
  type MockTx,
} from './mock-ledger.ts';

/** Where the MOCK ledger lives. `read` must always return the latest state (other tabs may write). */
export interface MockLedgerStore {
  read(): MockLedgerState;
  write(state: MockLedgerState): void;
}

export function createMemoryLedgerStore(initial: MockLedgerState = emptyLedger()): MockLedgerStore {
  let state = initial;
  return {
    read: () => state,
    write: (next) => {
      state = next;
    },
  };
}

export const MOCK_LEDGER_STORAGE_KEY = 'lt:mock:ledger:v1';

/** Persists the ledger as one JSON snapshot in localStorage: survives reloads, shared by tabs. */
export function createLocalStorageLedgerStore(storage: Storage, key = MOCK_LEDGER_STORAGE_KEY): MockLedgerStore {
  return {
    read: () => deserializeLedger(storage.getItem(key)),
    write: (state) => storage.setItem(key, serializeLedger(state)),
  };
}

export interface MockChainOptions {
  store?: MockLedgerStore;
  token?: TokenConfig;
  /** Artificial confirmation delay for sent txs, [min, max] ms. Default [350, 800]. */
  sendLatencyMs?: readonly [number, number];
  /** Artificial delay for reads, [min, max] ms. Default [15, 60]. */
  readLatencyMs?: readonly [number, number];
  now?: () => number;
  /** MOCK faucet amounts. */
  faucetLamports?: bigint;
  faucetTokenMicro?: bigint;
}

const randomBlockhash = (): Blockhash => getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32))) as Blockhash;
const randomSig = (): string => getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(64)));

const unavailableRpc = new Proxy({} as SolanaRpc, {
  get(_t, prop) {
    if (prop === 'then') return undefined; // not a thenable
    throw new Error(`rpc.${String(prop)} is not available in MOCK mode`);
  },
});

export function createMockChain(opts: MockChainOptions = {}): AppChain {
  const token = opts.token ?? TOKEN;
  const store = opts.store ?? createMemoryLedgerStore();
  const now = opts.now ?? Date.now;
  const [sendMin, sendMax] = opts.sendLatencyMs ?? [350, 800];
  const [readMin, readMax] = opts.readLatencyMs ?? [15, 60];
  const mintDecimals = { [token.mint]: token.decimals };
  const ataCache = new Map<string, Promise<Address>>();

  const delay = async (min: number, max: number) => {
    if (max <= 0) return;
    await sleep(min + Math.random() * Math.max(0, max - min));
  };
  const read = async <T>(fn: (s: MockLedgerState) => T): Promise<T> => {
    await delay(readMin, readMax);
    return fn(store.read());
  };

  function findAta(owner: Address): Promise<Address> {
    let cached = ataCache.get(owner);
    if (!cached) {
      cached = findAssociatedTokenPda({ owner, mint: token.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }).then(([ata]) => ata);
      ataCache.set(owner, cached);
    }
    return cached;
  }

  /** The ledger cannot derive PDAs synchronously, so ATA addresses are checked before applying. */
  async function checkAtaDerivations(ixs: readonly Instruction[]): Promise<void> {
    for (const ix of ixs) {
      if (ix.programAddress !== ATA_PROGRAM || !ix.accounts || !ix.data) continue;
      const p = parseCreateAssociatedTokenIdempotentInstruction(ix as Instruction & { accounts: readonly AccountMeta[]; data: ReadonlyUint8Array });
      const [expected] = await findAssociatedTokenPda({
        owner: p.accounts.owner.address,
        mint: p.accounts.mint.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      if (expected !== p.accounts.ata.address) {
        throw new ChainError('program', `Simulation failed: ${p.accounts.ata.address} is not the associated token account`);
      }
    }
  }

  async function sendIxs(feePayer: TransactionSigner, ixs: readonly Instruction[]): Promise<Signature> {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: randomBlockhash(), lastValidBlockHeight: 1_000_000n }, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    );
    // Real Kit signing: every required signer must be present, exactly as on devnet.
    const signed = await signTransactionMessageWithSigners(message);
    const sig = getSignatureFromTransaction(signed);
    await checkAtaDerivations(ixs);
    await delay(sendMin, sendMax);
    try {
      const { state } = applyTransaction(store.read(), {
        sig,
        feePayer: feePayer.address,
        signers: Object.keys(signed.signatures),
        instructions: ixs,
        blockTime: Math.floor(now() / 1000),
        mintDecimals,
      });
      store.write(state);
    } catch (e) {
      if (e instanceof MockTxError) {
        throw new ChainError('program', `Simulation failed: ${e.message}`, { signature: sig, logs: e.logs });
      }
      throw e;
    }
    return sig;
  }

  const estimateFee = async (feePayer: TransactionSigner, ixs: readonly Instruction[]): Promise<bigint> => {
    const signers = new Set<string>([feePayer.address]);
    for (const ix of ixs) for (const meta of ix.accounts ?? []) if ('signer' in meta) signers.add(meta.address);
    return LAMPORTS_PER_SIGNATURE * BigInt(signers.size);
  };

  const getSolBalance = (address: Address) => read((s) => s.lamports[address] ?? 0n);
  const getRentExemptMinimum = async (bytes: number) => rentExemptMinimum(bytes);

  const getAllowance = (tokenAccount: Address): Promise<Allowance> =>
    read((s) => {
      const t = s.tokens[tokenAccount];
      if (!t) return { delegate: null, delegatedMicro: 0n, balanceMicro: 0n, exists: false, owner: null };
      return {
        delegate: (t.delegate as Address | null) ?? null,
        delegatedMicro: t.delegate ? t.delegatedAmount : 0n,
        balanceMicro: t.amount,
        exists: true,
        owner: t.owner as Address,
      };
    });

  const toEntry = (tx: MockTx): LtMemoEntry | null => {
    const memo = decodeMemo(rpcMemoField(tx.memos));
    return memo ? { sig: tx.sig, memo, blockTime: tx.blockTime, slot: BigInt(tx.slot) } : null;
  };

  const listLtMemos = (address: Address, o: { max?: number } = {}): Promise<LtMemoEntry[]> =>
    read((s) => txsForAddress(s, address, o.max ?? 1000).map(toEntry).filter((e): e is LtMemoEntry => e !== null));

  const toPayment = (e: LtMemoEntry): Payment | null =>
    e.memo.kind === 'pay'
      ? { sig: e.sig, seq: e.memo.seq, whCum: e.memo.whCum, amountMicro: e.memo.amountMicro, blockTime: e.blockTime, slot: e.slot }
      : null;

  async function listSessionPayments(tokenAccount: Address, sid: string): Promise<Payment[]> {
    return (await listLtMemos(tokenAccount))
      .filter((e) => e.memo.sid === sid)
      .map(toPayment)
      .filter((p): p is Payment => p !== null)
      .sort((a, b) => a.seq - b.seq);
  }

  async function listOwnerSessions(owner: Address): Promise<SessionSummary[]> {
    const bySid = new Map<string, Payment[]>();
    for (const e of await listLtMemos(await findAta(owner))) {
      const payment = toPayment(e);
      if (!payment) continue;
      const list = bySid.get(e.memo.sid) ?? [];
      list.push(payment);
      bySid.set(e.memo.sid, list);
    }
    return [...bySid.entries()]
      .map(([sid, payments]): SessionSummary => {
        payments.sort((a, b) => a.seq - b.seq);
        const times = payments.map((p) => p.blockTime).filter((t): t is number => t !== null);
        return {
          sid,
          payments,
          paymentCount: payments.length,
          whTotal: Math.max(0, ...payments.map((p) => p.whCum)),
          totalMicro: payments.reduce((sum, p) => sum + p.amountMicro, 0n),
          firstBlockTime: times.length ? Math.min(...times) : null,
          lastBlockTime: times.length ? Math.max(...times) : null,
        };
      })
      .sort((a, b) => (b.lastBlockTime ?? 0) - (a.lastBlockTime ?? 0));
  }

  async function findSessionEnd(address: Address, sid: string): Promise<SessionEnd | null> {
    for (const e of await listLtMemos(address, { max: 200 })) {
      if (e.memo.kind === 'end' && e.memo.sid === sid) {
        return { sig: e.sig, whTotal: e.memo.whTotal, totalMicro: e.memo.totalMicro, reason: e.memo.reason, blockTime: e.blockTime };
      }
    }
    return null;
  }

  async function findStartTx(session: Address): Promise<StartInfo | null> {
    const sid = sidOf(session);
    return read((s) => {
      const candidates = txsForAddress(s, session, 25)
        .filter((tx) => {
          const m = decodeMemo(rpcMemoField(tx.memos));
          return m?.kind === 'start' && m.sid === sid;
        })
        .reverse(); // oldest first: the first valid start tx wins
      for (const tx of candidates) {
        const memo = decodeMemo(rpcMemoField(tx.memos));
        const approve = tx.approves.find((a) => a.delegate === session);
        if (!approve || memo?.kind !== 'start') continue;
        if (approve.mint !== token.mint || approve.decimals !== token.decimals) continue;
        const guest = approve.owner as Address;
        const depositLamports = tx.transfers.filter((t) => t.from === guest && t.to === session).reduce((sum, t) => sum + t.lamports, 0n);
        return {
          sig: tx.sig,
          guest,
          guestAta: approve.source as Address,
          capMicro: approve.amount,
          priceMicroPerKWh: memo.priceMicroPerKWh,
          sid: memo.sid,
          depositLamports,
          blockTime: tx.blockTime,
        };
      }
      return null;
    });
  }

  async function sendEnd(req: EndRequest): Promise<{ sig: Signature; refundLamports: bigint }> {
    const balance = await getSolBalance(req.session.address);
    const fee = await estimateFee(req.session, buildEndIxs({ ...req, lamports: 1n }));
    const refundLamports = balance - fee;
    if (refundLamports < 0n) throw new ChainError('program', `Session key balance ${balance} cannot pay the end tx fee ${fee}`);
    const sig = await sendIxs(req.session, buildEndIxs({ ...req, lamports: refundLamports }));
    return { sig, refundLamports };
  }

  const verifyPayment = (sig: string, ownerAta: Address): Promise<PaymentVerification> =>
    read((s) => {
      const tx = s.txs.find((t) => t.sig === sig);
      const memo = tx ? decodeMemo(rpcMemoField(tx.memos)) : null;
      if (!tx) return { sig, memo, receivedMicro: 0n, payer: null, ok: false };
      const own = tx.tokenDeltas.find((d) => d.account === ownerAta && d.mint === token.mint);
      const receivedMicro = own ? own.post - own.pre : 0n;
      const debited = tx.tokenDeltas.find((d) => d.account !== ownerAta && d.mint === token.mint && d.post < d.pre);
      const ok = memo?.kind === 'pay' && memo.amountMicro === receivedMicro && receivedMicro > 0n;
      return { sig, memo, receivedMicro, payer: (debited?.owner as Address | undefined) ?? null, ok };
    });

  const getTransferredLamports = (sig: string, from: Address, to: Address) =>
    read((s) => {
      const tx = s.txs.find((t) => t.sig === sig);
      if (!tx) return null;
      return tx.transfers.filter((t) => t.from === from && t.to === to).reduce((sum, t) => sum + t.lamports, 0n);
    });

  async function requestTestFunds(address: Address): Promise<string> {
    const ata = await findAta(address);
    await delay(sendMin, sendMax);
    const sig = randomSig();
    const { state } = mintTestFunds(store.read(), {
      sig,
      blockTime: Math.floor(now() / 1000),
      owner: address,
      ata,
      mint: token.mint,
      lamports: opts.faucetLamports ?? 1_000_000_000n,
      tokenAmount: opts.faucetTokenMicro ?? 20_000_000n,
    });
    store.write(state);
    return sig;
  }

  const client: AppChain = {
    kind: 'mock',
    rpc: unavailableRpc,
    token,
    sendIxs,
    estimateFee,
    getSolBalance,
    getRentExemptMinimum,
    findAta,
    getAllowance,
    findStartTx,
    sendEnd,
    listLtMemos,
    listSessionPayments,
    listOwnerSessions,
    findSessionEnd,
    verifyPayment,
    charger: () => createChargerChain(client),
    getTransferredLamports,
    requestTestFunds,
    explorerTxUrl: () => null,
    explorerAddressUrl: () => null,
  };
  return client;
}
