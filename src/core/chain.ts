// Thin wrappers over @solana/kit 8.3 + @solana-program/{token,memo,system}.
// - Pure instruction builders for the four session transactions (spec 5).
// - A throttled RPC client: confirmation by polling getSignatureStatuses (no WebSocket needed),
//   read-your-writes via minContextSlot, and chain-only history queries for the dashboards.
import { SUPPORTED_MEMO_PROGRAM_ADDRESSES, getAddMemoInstruction } from '@solana-program/memo';
import { getTransferSolInstruction } from '@solana-program/system';
import {
  TOKEN_PROGRAM_ADDRESS,
  fetchMaybeToken,
  findAssociatedTokenPda,
  getApproveCheckedInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getRevokeInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token';
import {
  SOLANA_ERROR__JSON_RPC__INVALID_PARAMS,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_VERIFICATION_FAILURE,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
  appendTransactionMessageInstructions,
  compileTransaction,
  createDefaultRpcTransport,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpcFromTransport,
  createTransactionMessage,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isSolanaError,
  isSome,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Base64EncodedWireTransaction,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type RpcTransport,
  type Signature,
  type SolanaRpcApi,
  type TransactionMessageBytesBase64,
  type TransactionSigner,
} from '@solana/kit';
import {
  FEE_DEPOSIT_LAMPORTS,
  MEMO_PROGRAM,
  RPC_MAX_REQUESTS_PER_SECOND,
  RPC_URL,
  SYSTEM_PROGRAM,
  TOKEN,
  TOKEN_PROGRAM,
  type TokenConfig,
} from './config.ts';
import { ChainError, errorMessage } from './errors.ts';
import { decodeMemo, encodeMemo, sidOf, type EndReason, type LtMemo } from './memo.ts';
import type { ChargerChain, EndRequest } from './session.ts';
import { createRateLimiter, sleep, withRetry } from './throttle.ts';

// ---------------------------------------------------------------------------------------------
// Types shared with the UI (WP2/WP3)
// ---------------------------------------------------------------------------------------------

export interface StartInfo {
  sig: string;
  guest: Address;
  /** The guest token account that approved the session key (normally the guest's ATA). */
  guestAta: Address;
  /** Approved amount from ApproveChecked (authoritative, not the memo claim). */
  capMicro: bigint;
  /** Price the guest agreed to, from the start memo. */
  priceMicroPerKWh: bigint;
  sid: string;
  /** SOL sent from the guest to the session key in the start tx. */
  depositLamports: bigint;
  blockTime: number | null;
}

export interface Allowance {
  delegate: Address | null;
  delegatedMicro: bigint;
  balanceMicro: bigint;
  /** false when the token account does not exist (then all amounts are 0). */
  exists: boolean;
  owner: Address | null;
}

export interface LtMemoEntry {
  sig: string;
  memo: LtMemo;
  blockTime: number | null;
  slot: bigint;
}

export interface Payment {
  sig: string;
  seq: number;
  whCum: number;
  amountMicro: bigint;
  blockTime: number | null;
  slot: bigint;
}

export interface SessionSummary {
  sid: string;
  payments: Payment[];
  paymentCount: number;
  /** Highest cumulative Wh claimed by the pay memos. */
  whTotal: number;
  totalMicro: bigint;
  firstBlockTime: number | null;
  lastBlockTime: number | null;
}

export interface SessionEnd {
  sig: string;
  whTotal: number;
  totalMicro: bigint;
  reason: EndReason;
  blockTime: number | null;
}

export interface PaymentVerification {
  sig: string;
  memo: LtMemo | null;
  /** Token amount the owner ATA actually received in this tx (post - pre balance). */
  receivedMicro: bigint;
  /** Owner of the token account that was debited, i.e. the guest wallet. */
  payer: Address | null;
  /** true when the tx succeeded, carries a pay memo and moved exactly the memo amount. */
  ok: boolean;
}

// ---------------------------------------------------------------------------------------------
// Instruction builders (pure; spec 5)
// ---------------------------------------------------------------------------------------------

/** Memo instruction on the classic Memo program (explorers parse it). */
export function buildMemoIx(text: string): Instruction {
  return getAddMemoInstruction({ memo: text }, { programAddress: MEMO_PROGRAM });
}

function assertSid(session: Address, sid: string): void {
  if (sidOf(session) !== sid) throw new Error(`sid ${sid} does not belong to session key ${session}`);
}

/** start (guest signs): SOL fee deposit -> session key, ApproveChecked(cap) to the session key, memo. */
export function buildStartIxs(p: {
  guest: TransactionSigner;
  guestAta: Address;
  session: Address;
  capMicro: bigint;
  sid: string;
  priceMicroPerKWh: bigint;
  depositLamports?: bigint;
  token?: TokenConfig;
}): Instruction[] {
  assertSid(p.session, p.sid);
  const token = p.token ?? TOKEN;
  return [
    getTransferSolInstruction({ source: p.guest, destination: p.session, amount: p.depositLamports ?? FEE_DEPOSIT_LAMPORTS }),
    getApproveCheckedInstruction({
      source: p.guestAta,
      mint: token.mint,
      delegate: p.session,
      owner: p.guest,
      amount: p.capMicro,
      decimals: token.decimals,
    }),
    buildMemoIx(encodeMemo({ kind: 'start', sid: p.sid, priceMicroPerKWh: p.priceMicroPerKWh, capMicro: p.capMicro })),
  ];
}

/** pay #n (session key signs): [CreateIdempotent owner ATA], TransferChecked as delegate, memo. */
export async function buildPayIxs(p: {
  session: KeyPairSigner;
  guestAta: Address;
  owner: Address;
  ownerAta: Address;
  amountMicro: bigint;
  seq: number;
  whCum: number;
  sid: string;
  createOwnerAta: boolean;
  token?: TokenConfig;
}): Promise<Instruction[]> {
  assertSid(p.session.address, p.sid);
  const token = p.token ?? TOKEN;
  const [expectedAta] = await findAssociatedTokenPda({ owner: p.owner, mint: token.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  if (expectedAta !== p.ownerAta) throw new Error(`ownerAta ${p.ownerAta} is not the ${token.symbol} ATA of ${p.owner}`);
  const ixs: Instruction[] = [];
  if (p.createOwnerAta) {
    ixs.push(getCreateAssociatedTokenIdempotentInstruction({ payer: p.session, ata: p.ownerAta, owner: p.owner, mint: token.mint }));
  }
  ixs.push(
    getTransferCheckedInstruction({
      source: p.guestAta,
      mint: token.mint,
      destination: p.ownerAta,
      authority: p.session,
      amount: p.amountMicro,
      decimals: token.decimals,
    }),
    buildMemoIx(encodeMemo({ kind: 'pay', sid: p.sid, seq: p.seq, whCum: p.whCum, amountMicro: p.amountMicro })),
  );
  return ixs;
}

/** stop (guest signs, optional): Revoke + memo. */
export function buildStopIxs(p: { guest: TransactionSigner; guestAta: Address; sid: string }): Instruction[] {
  return [getRevokeInstruction({ source: p.guestAta, owner: p.guest }), buildMemoIx(encodeMemo({ kind: 'stop', sid: p.sid }))];
}

/** end (session key signs): memo + transfer of `lamports` (normally the whole balance minus the fee) to the guest. */
export function buildEndIxs(p: {
  session: KeyPairSigner;
  guest: Address;
  lamports: bigint;
  sid: string;
  whTotal: number;
  totalMicro: bigint;
  reason: EndReason;
}): Instruction[] {
  assertSid(p.session.address, p.sid);
  const ixs: Instruction[] = [
    buildMemoIx(encodeMemo({ kind: 'end', sid: p.sid, whTotal: p.whTotal, totalMicro: p.totalMicro, reason: p.reason })),
  ];
  if (p.lamports > 0n) ixs.push(getTransferSolInstruction({ source: p.session, destination: p.guest, amount: p.lamports }));
  return ixs;
}

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

/** New per-session key from 32 random bytes; keep `secret` (e.g. localStorage) until the session ended. */
export async function generateSessionKey(): Promise<{ signer: KeyPairSigner; secret: Uint8Array }> {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  return { signer: await createKeyPairSignerFromPrivateKeyBytes(secret), secret };
}

export const sessionKeyFromSecret = (secret: Uint8Array): Promise<KeyPairSigner> =>
  createKeyPairSignerFromPrivateKeyBytes(secret);

// ---------------------------------------------------------------------------------------------
// RPC client
// ---------------------------------------------------------------------------------------------

export type SolanaRpc = Rpc<SolanaRpcApi>;

export interface ChainClientOptions {
  rpcUrl?: string;
  maxRequestsPerSecond?: number;
  token?: TokenConfig;
  /** Give up waiting for a confirmation after this long (the blockhash normally expires first). */
  confirmTimeoutMs?: number;
}

export interface ChainClient {
  readonly rpc: SolanaRpc;
  readonly token: TokenConfig;
  /** Signs with all signers in the instructions, sends, and resolves once confirmed. */
  sendIxs(feePayer: TransactionSigner, ixs: readonly Instruction[]): Promise<Signature>;
  estimateFee(feePayer: TransactionSigner, ixs: readonly Instruction[]): Promise<bigint>;
  getSolBalance(address: Address): Promise<bigint>;
  getRentExemptMinimum(bytes: number): Promise<bigint>;
  /** Associated token account of `owner` for the configured token. */
  findAta(owner: Address): Promise<Address>;
  getAllowance(tokenAccount: Address): Promise<Allowance>;
  findStartTx(session: Address): Promise<StartInfo | null>;
  /** end tx: memo + sweep of the whole session-key balance (minus the fee) back to the guest. */
  sendEnd(req: EndRequest): Promise<{ sig: Signature; refundLamports: bigint }>;
  /** Successful txs touching `address` that carry an LT1 memo, newest first. */
  listLtMemos(address: Address, opts?: { max?: number }): Promise<LtMemoEntry[]>;
  listSessionPayments(tokenAccount: Address, sid: string): Promise<Payment[]>;
  listOwnerSessions(owner: Address): Promise<SessionSummary[]>;
  /** Looks for `LT1|end|<sid>` on an address (e.g. the guest wallet). */
  findSessionEnd(address: Address, sid: string): Promise<SessionEnd | null>;
  verifyPayment(sig: string, ownerAta: Address): Promise<PaymentVerification>;
}

const CONFIRM_POLL_MS = 1_000;
const REBROADCAST_MS = 2_500;
const DEFAULT_CONFIRM_TIMEOUT_MS = 120_000;

const bigintJson = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

function isRetryableTransportError(e: unknown): boolean {
  if (isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
    const status = e.context.statusCode;
    return status === 429 || status >= 500;
  }
  return e instanceof TypeError; // fetch() network failure
}

function retryAfterMs(e: unknown): number | undefined {
  if (!isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) return undefined;
  const seconds = Number(e.context.headers?.get?.('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/** HTTP transport limited to `maxRps` requests per second with backoff on 429 / 5xx / network errors. */
export function createThrottledTransport(url: string, maxRps: number): RpcTransport {
  const base = createDefaultRpcTransport({ url });
  const limiter = createRateLimiter({ ratePerSecond: maxRps });
  const transport = <TResponse>(config: Parameters<RpcTransport>[0]): Promise<TResponse> =>
    withRetry(
      async () => {
        await limiter.acquire();
        return await base<TResponse>(config);
      },
      { retries: 6, baseDelayMs: 500, maxDelayMs: 10_000, isRetryable: isRetryableTransportError, retryAfterMs },
    );
  return transport as RpcTransport;
}

const toNumberOrNull = (v: unknown): number | null =>
  typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : null;

function toBigIntOrNull(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  return null;
}

/** `parsed.info` of a jsonParsed instruction of `programId` and `type`, or null. */
function parsedInfo(ix: unknown, programId: Address, type: string): Record<string, unknown> | null {
  if (!ix || typeof ix !== 'object') return null;
  const { programId: pid, parsed } = ix as { programId?: unknown; parsed?: unknown };
  if (pid !== programId || !parsed || typeof parsed !== 'object') return null;
  const { type: t, info } = parsed as { type?: unknown; info?: unknown };
  return t === type && info && typeof info === 'object' ? (info as Record<string, unknown>) : null;
}

function memoTextOf(ix: unknown): string | null {
  if (!ix || typeof ix !== 'object') return null;
  const { programId, parsed } = ix as { programId?: unknown; parsed?: unknown };
  const isMemo = (SUPPORTED_MEMO_PROGRAM_ADDRESSES as readonly unknown[]).includes(programId);
  return isMemo && typeof parsed === 'string' ? parsed : null;
}

export function createChainClient(opts: ChainClientOptions = {}): ChainClient {
  const token = opts.token ?? TOKEN;
  const rpc: SolanaRpc = createSolanaRpcFromTransport(
    createThrottledTransport(opts.rpcUrl ?? RPC_URL, opts.maxRequestsPerSecond ?? RPC_MAX_REQUESTS_PER_SECOND),
  );
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  const rentCache = new Map<number, Promise<bigint>>();
  const ataCache = new Map<Address, Promise<Address>>();
  /** Highest slot of our own confirmed txs; reads use it as minContextSlot (read-your-writes). */
  let seenSlot = 0n;
  const noteSlot = (slot: bigint | undefined) => {
    if (slot !== undefined && slot > seenSlot) seenSlot = slot;
  };

  /** Retries a read while the load-balanced RPC node lags behind our last confirmed slot. */
  async function fresh<T>(read: (minContextSlot: bigint | undefined) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await read(seenSlot > 0n ? seenSlot : undefined);
      } catch (e) {
        if (attempt >= 8 || !isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED)) throw e;
        await sleep(400);
      }
    }
  }

  async function buildMessage(feePayer: TransactionSigner, ixs: readonly Instruction[]) {
    const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    return pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    );
  }

  async function estimateFee(feePayer: TransactionSigner, ixs: readonly Instruction[]): Promise<bigint> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const compiled = compileTransaction(await buildMessage(feePayer, ixs));
      const message = getBase64Decoder().decode(compiled.messageBytes) as TransactionMessageBytesBase64;
      const { value } = await rpc.getFeeForMessage(message, { commitment: 'confirmed' }).send();
      if (value !== null) return value;
    }
    throw new ChainError('network', 'Could not estimate the transaction fee');
  }

  async function confirm(sig: Signature, wire: Base64EncodedWireTransaction, lastValidBlockHeight: bigint): Promise<void> {
    const startedAt = Date.now();
    let lastBroadcast = startedAt;
    for (let poll = 1; ; poll++) {
      await sleep(poll === 1 ? 500 : CONFIRM_POLL_MS);
      try {
        const [status] = (await rpc.getSignatureStatuses([sig]).send()).value;
        if (status?.err) {
          throw new ChainError('program', `Transaction ${sig} failed: ${bigintJson(status.err)}`, { signature: sig });
        }
        if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
          noteSlot(status.slot);
          return;
        }
        if (poll % 4 === 0) {
          const height = await rpc.getBlockHeight({ commitment: 'confirmed' }).send();
          if (height > lastValidBlockHeight) {
            // The blockhash expired: the tx can never land now, unless it already has.
            const [last] = (await rpc.getSignatureStatuses([sig], { searchTransactionHistory: true }).send()).value;
            if (last?.err) throw new ChainError('program', `Transaction ${sig} failed: ${bigintJson(last.err)}`, { signature: sig });
            if (last && last.confirmationStatus !== 'processed') {
              noteSlot(last.slot);
              return;
            }
            throw new ChainError('expired', `Transaction ${sig} expired before it was confirmed`, { signature: sig });
          }
        }
        if (Date.now() - lastBroadcast >= REBROADCAST_MS) {
          lastBroadcast = Date.now();
          // Same signed bytes, so a rebroadcast can never double-spend. Errors are irrelevant here.
          await rpc
            .sendTransaction(wire, { encoding: 'base64', skipPreflight: true, maxRetries: 0n })
            .send()
            .catch(() => undefined);
        }
      } catch (e) {
        if (e instanceof ChainError) throw e;
        // Transient read failure: keep polling until the deadline below.
      }
      if (Date.now() - startedAt > confirmTimeoutMs) {
        throw new ChainError('unknown', `Could not confirm ${sig} within ${confirmTimeoutMs / 1000} s`, { signature: sig });
      }
    }
  }

  async function sendIxs(feePayer: TransactionSigner, ixs: readonly Instruction[]): Promise<Signature> {
    const message = await buildMessage(feePayer, ixs);
    const signed = await signTransactionMessageWithSigners(message);
    const sig = getSignatureFromTransaction(signed);
    const wire = getBase64EncodedWireTransaction(signed);
    try {
      await rpc.sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' }).send();
    } catch (e) {
      if (isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)) {
        const logs = e.context.logs ?? undefined;
        if (isSolanaError(e.cause, SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND)) {
          throw new ChainError('expired', 'Blockhash not found during simulation', { signature: sig, logs, cause: e });
        }
        const detail = logs?.filter((l) => /error|failed|insufficient/i.test(l)).slice(-2).join(' | ');
        throw new ChainError('program', `Simulation failed: ${errorMessage(e.cause ?? e)}${detail ? ` (${detail})` : ''}`, {
          signature: sig,
          logs,
          cause: e,
        });
      }
      if (
        isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_SIGNATURE_VERIFICATION_FAILURE) ||
        isSolanaError(e, SOLANA_ERROR__JSON_RPC__INVALID_PARAMS)
      ) {
        throw new ChainError('program', `Transaction rejected: ${errorMessage(e)}`, { signature: sig, cause: e });
      }
      // Transport or server hiccup: the tx may or may not have been forwarded. confirm() rebroadcasts
      // the same bytes until it lands or its blockhash expires, so this is safe.
    }
    await confirm(sig, wire, message.lifetimeConstraint.lastValidBlockHeight);
    return sig;
  }

  const getSolBalance = (address: Address): Promise<bigint> =>
    fresh(async (minContextSlot) => (await rpc.getBalance(address, { commitment: 'confirmed', minContextSlot }).send()).value);

  function getRentExemptMinimum(bytes: number): Promise<bigint> {
    let cached = rentCache.get(bytes);
    if (!cached) {
      cached = rpc.getMinimumBalanceForRentExemption(BigInt(bytes)).send();
      cached.catch(() => rentCache.delete(bytes));
      rentCache.set(bytes, cached);
    }
    return cached;
  }

  function findAta(owner: Address): Promise<Address> {
    let cached = ataCache.get(owner);
    if (!cached) {
      cached = findAssociatedTokenPda({ owner, mint: token.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }).then(([ata]) => ata);
      ataCache.set(owner, cached);
    }
    return cached;
  }

  async function getAllowance(tokenAccount: Address): Promise<Allowance> {
    const account = await fresh((minContextSlot) => fetchMaybeToken(rpc, tokenAccount, { commitment: 'confirmed', minContextSlot }));
    if (!account.exists) return { delegate: null, delegatedMicro: 0n, balanceMicro: 0n, exists: false, owner: null };
    const { data } = account;
    const delegate = isSome(data.delegate) ? data.delegate.value : null;
    return {
      delegate,
      delegatedMicro: delegate ? data.delegatedAmount : 0n,
      balanceMicro: data.amount,
      exists: true,
      owner: data.owner,
    };
  }

  async function getSignatures(address: Address, max: number) {
    const out: Awaited<ReturnType<ReturnType<SolanaRpc['getSignaturesForAddress']>['send']>>[number][] = [];
    let before: Signature | undefined;
    while (out.length < max) {
      const limit = Math.min(1000, max - out.length);
      const page = before
        ? await rpc.getSignaturesForAddress(address, { limit, before, commitment: 'confirmed' }).send()
        : await rpc.getSignaturesForAddress(address, { limit, commitment: 'confirmed' }).send();
      out.push(...page);
      if (page.length < limit) break;
      before = page[page.length - 1].signature;
    }
    return out;
  }

  async function listLtMemos(address: Address, o: { max?: number } = {}): Promise<LtMemoEntry[]> {
    const entries: LtMemoEntry[] = [];
    for (const s of await getSignatures(address, o.max ?? 1000)) {
      if (s.err) continue;
      const memo = decodeMemo(s.memo);
      if (memo) entries.push({ sig: s.signature, memo, blockTime: toNumberOrNull(s.blockTime), slot: s.slot });
    }
    return entries;
  }

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
    const summaries = [...bySid.entries()].map(([sid, payments]): SessionSummary => {
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
    });
    return summaries.sort((a, b) => (b.lastBlockTime ?? 0) - (a.lastBlockTime ?? 0));
  }

  async function findSessionEnd(address: Address, sid: string): Promise<SessionEnd | null> {
    for (const e of await listLtMemos(address, { max: 200 })) {
      if (e.memo.kind === 'end' && e.memo.sid === sid) {
        return { sig: e.sig, whTotal: e.memo.whTotal, totalMicro: e.memo.totalMicro, reason: e.memo.reason, blockTime: e.blockTime };
      }
    }
    return null;
  }

  const getParsedTx = (sig: string) =>
    rpc
      .getTransaction(sig as Signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
      .send();

  async function parseStartTx(sig: string, session: Address): Promise<StartInfo | null> {
    const tx = await getParsedTx(sig);
    if (!tx || !tx.meta || tx.meta.err) return null;
    let approve: Record<string, unknown> | null = null;
    let memo: LtMemo | null = null;
    const deposits: { source: unknown; lamports: bigint }[] = [];
    for (const ix of tx.transaction.message.instructions) {
      const approveInfo = parsedInfo(ix, TOKEN_PROGRAM, 'approveChecked');
      if (approveInfo && approveInfo.delegate === session) approve = approveInfo;
      const transfer = parsedInfo(ix, SYSTEM_PROGRAM, 'transfer');
      const lamports = toBigIntOrNull(transfer?.lamports);
      if (transfer && transfer.destination === session && lamports !== null) deposits.push({ source: transfer.source, lamports });
      const text = memoTextOf(ix);
      if (text !== null) memo ??= decodeMemo(text);
    }
    if (!approve || !memo || memo.kind !== 'start' || memo.sid !== sidOf(session)) return null;
    const tokenAmount = approve.tokenAmount as { amount?: unknown; decimals?: unknown } | undefined;
    const capMicro = toBigIntOrNull(tokenAmount?.amount);
    if (approve.mint !== token.mint || toNumberOrNull(tokenAmount?.decimals) !== token.decimals || capMicro === null) return null;
    if (typeof approve.owner !== 'string' || typeof approve.source !== 'string') return null;
    const guest = approve.owner as Address;
    const depositLamports = deposits.filter((d) => d.source === guest).reduce((sum, d) => sum + d.lamports, 0n);
    return {
      sig,
      guest,
      guestAta: approve.source as Address,
      capMicro,
      priceMicroPerKWh: memo.priceMicroPerKWh,
      sid: memo.sid,
      depositLamports,
      blockTime: toNumberOrNull(tx.blockTime),
    };
  }

  async function findStartTx(session: Address): Promise<StartInfo | null> {
    const sid = sidOf(session);
    const candidates = (await getSignatures(session, 25))
      .filter((s) => !s.err)
      .filter((s) => {
        const m = decodeMemo(s.memo);
        return m?.kind === 'start' && m.sid === sid;
      })
      .reverse(); // oldest first: the first valid start tx wins
    for (const s of candidates) {
      const info = await parseStartTx(s.signature, session);
      if (info) return info;
    }
    return null;
  }

  async function sendEnd(req: EndRequest): Promise<{ sig: Signature; refundLamports: bigint }> {
    const balance = await getSolBalance(req.session.address);
    // The fee depends only on the signature count, so estimate it with a placeholder amount.
    const fee = await estimateFee(req.session, buildEndIxs({ ...req, lamports: 1n }));
    const refundLamports = balance - fee;
    if (refundLamports < 0n) {
      throw new ChainError('program', `Session key balance ${balance} cannot pay the end tx fee ${fee}`);
    }
    const sig = await sendIxs(req.session, buildEndIxs({ ...req, lamports: refundLamports }));
    return { sig, refundLamports };
  }

  async function verifyPayment(sig: string, ownerAta: Address): Promise<PaymentVerification> {
    const tx = await getParsedTx(sig);
    const memo = tx ? tx.transaction.message.instructions.map(memoTextOf).map(decodeMemo).find((m) => m !== null) ?? null : null;
    if (!tx || !tx.meta || tx.meta.err) return { sig, memo, receivedMicro: 0n, payer: null, ok: false };
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
    const ownerIndex = keys.indexOf(ownerAta);
    const amountAt = (list: typeof tx.meta.preTokenBalances, index: number): bigint =>
      toBigIntOrNull(list?.find((b) => b.accountIndex === index && b.mint === token.mint)?.uiTokenAmount.amount) ?? 0n;
    const receivedMicro = ownerIndex < 0 ? 0n : amountAt(tx.meta.postTokenBalances, ownerIndex) - amountAt(tx.meta.preTokenBalances, ownerIndex);
    let payer: Address | null = null;
    for (const pre of tx.meta.preTokenBalances ?? []) {
      if (pre.mint !== token.mint || pre.accountIndex === ownerIndex) continue;
      if (amountAt(tx.meta.postTokenBalances, pre.accountIndex) < amountAt(tx.meta.preTokenBalances, pre.accountIndex)) {
        payer = pre.owner ?? null;
      }
    }
    const ok = memo?.kind === 'pay' && memo.amountMicro === receivedMicro && receivedMicro > 0n;
    return { sig, memo, receivedMicro, payer, ok };
  }

  return {
    rpc,
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
  };
}

/** Adapter for ChargerSession (session.ts) backed by a real chain client. */
export function createChargerChain(client: ChainClient): ChargerChain {
  return {
    findStartTx: (session) => client.findStartTx(session),
    getAllowance: (guestAta) => client.getAllowance(guestAta),
    getSolBalance: (address) => client.getSolBalance(address),
    getRentExemptMinimum: (bytes) => client.getRentExemptMinimum(bytes),
    async pay(req) {
      const ownerAta = await client.findAta(req.owner);
      return client.sendIxs(req.session, await buildPayIxs({ ...req, ownerAta, token: client.token }));
    },
    end: (req) => client.sendEnd(req),
  };
}

// ---------------------------------------------------------------------------------------------
// Default client + the free functions of the spec 8 contract
// ---------------------------------------------------------------------------------------------

let defaultClient: ChainClient | undefined;

/** Lazily created client for RPC_URL and TOKEN from config.ts (one shared throttle per tab). */
export function getChain(): ChainClient {
  return (defaultClient ??= createChainClient());
}

export const sendIxs = (feePayer: TransactionSigner, ixs: readonly Instruction[]): Promise<Signature> =>
  getChain().sendIxs(feePayer, ixs);
export const findStartTx = (session: Address): Promise<StartInfo | null> => getChain().findStartTx(session);
export const getAllowance = (tokenAccount: Address): Promise<Allowance> => getChain().getAllowance(tokenAccount);
export const listOwnerSessions = (owner: Address): Promise<SessionSummary[]> => getChain().listOwnerSessions(owner);
export const listSessionPayments = (tokenAccount: Address, sid: string): Promise<Payment[]> =>
  getChain().listSessionPayments(tokenAccount, sid);

