// MOCK mode only: a tiny in-memory "ledger" that executes the exact Kit instructions built by
// src/core/chain.ts. It is pure and synchronous so it can be unit-tested and persisted as one
// JSON snapshot. Supported: System transfer, SPL Token ApproveChecked / TransferChecked / Revoke,
// Associated Token CreateIdempotent, Memo. Everything else is rejected.
//
// The SPL Token delegate rules follow the real program (see SPEC 4.2): approve overwrites the
// delegate, a delegate transfer decrements the allowance and clears the delegate at exactly 0,
// self-transfers do not decrement, only the owner can revoke. Rent and fees use the devnet
// numbers the charger loop budgets with (5,000 lamports per signature, 650,240 / 1,488,440 rent).
import { SUPPORTED_MEMO_PROGRAM_ADDRESSES, parseAddMemoInstruction } from '@solana-program/memo';
import { SystemInstruction, identifySystemInstruction, parseTransferSolInstruction } from '@solana-program/system';
import {
  AssociatedTokenInstruction,
  TokenInstruction,
  identifyAssociatedTokenInstruction,
  identifyTokenInstruction,
  parseApproveCheckedInstruction,
  parseCreateAssociatedTokenIdempotentInstruction,
  parseRevokeInstruction,
  parseTransferCheckedInstruction,
} from '@solana-program/token';
import type { AccountMeta, Instruction, ReadonlyUint8Array } from '@solana/kit';
import { ATA_PROGRAM, SYSTEM_PROGRAM, TOKEN_PROGRAM } from '../core/config.ts';

export const LAMPORTS_PER_SIGNATURE = 5_000n;
/** Rent-exempt minimum = (128 + data bytes) * 5,080 lamports (matches devnet on 28 Sep 2026). */
export const rentExemptMinimum = (bytes: number): bigint => BigInt(128 + bytes) * 5_080n;
const TOKEN_ACCOUNT_BYTES = 165;
/** Oldest transactions are dropped beyond this many (keeps the persisted snapshot small). */
const MAX_TXS = 3_000;

export interface MockTokenAccount {
  mint: string;
  owner: string;
  amount: bigint;
  delegate: string | null;
  delegatedAmount: bigint;
}

export interface MockTransfer {
  from: string;
  to: string;
  lamports: bigint;
}

export interface MockApprove {
  source: string;
  mint: string;
  delegate: string;
  owner: string;
  amount: bigint;
  decimals: number;
}

export interface MockTokenDelta {
  account: string;
  mint: string;
  owner: string;
  pre: bigint;
  post: bigint;
}

export interface MockTx {
  sig: string;
  slot: number;
  blockTime: number;
  feePayer: string;
  fee: bigint;
  /** Every account key of the tx (fee payer first, programs included), like RPC accountKeys. */
  accounts: string[];
  memos: string[];
  transfers: MockTransfer[];
  approves: MockApprove[];
  tokenDeltas: MockTokenDelta[];
}

export interface MockLedgerState {
  slot: number;
  lamports: Record<string, bigint>;
  tokens: Record<string, MockTokenAccount>;
  /** Oldest first. */
  txs: MockTx[];
}

export class MockTxError extends Error {
  readonly logs: string[];
  constructor(message: string, logs: string[] = []) {
    super(message);
    this.name = 'MockTxError';
    this.logs = logs;
  }
}

export const emptyLedger = (): MockLedgerState => ({ slot: 1, lamports: {}, tokens: {}, txs: [] });

export interface ApplyInput {
  sig: string;
  feePayer: string;
  /** Addresses that signed the transaction (fee payer included). */
  signers: readonly string[];
  instructions: readonly Instruction[];
  blockTime: number;
  /** Decimals per known mint. Token instructions for other mints fail. */
  mintDecimals: Readonly<Record<string, number>>;
}

type Meta = AccountMeta | undefined;
const addr = (meta: Meta, name: string): string => {
  if (!meta) throw new MockTxError(`Missing account: ${name}`);
  return meta.address;
};

function withAccountsAndData(ix: Instruction) {
  if (!ix.accounts || !ix.data) throw new MockTxError(`Instruction for ${ix.programAddress} has no accounts or data`);
  return ix as Instruction & { accounts: readonly AccountMeta[]; data: ReadonlyUint8Array };
}

/**
 * Applies one transaction atomically. Returns the new state and the recorded tx; throws
 * MockTxError (and leaves `state` untouched) when any check fails, like a failed preflight.
 */
export function applyTransaction(state: MockLedgerState, input: ApplyInput): { state: MockLedgerState; tx: MockTx } {
  const lamports: Record<string, bigint> = { ...state.lamports };
  const tokens: Record<string, MockTokenAccount> = {};
  for (const [k, v] of Object.entries(state.tokens)) tokens[k] = { ...v };
  const signers = new Set(input.signers);
  const logs: string[] = [];
  const bal = (a: string) => lamports[a] ?? 0n;
  const touched = new Set<string>();
  const credit = (a: string, n: bigint) => {
    lamports[a] = bal(a) + n;
    touched.add(a);
  };
  const debit = (a: string, n: bigint, what: string) => {
    if (bal(a) < n) throw new MockTxError(`${what}: insufficient lamports ${bal(a)}, need ${n}`, logs);
    lamports[a] = bal(a) - n;
    touched.add(a);
  };
  const requireSigner = (a: string, role: string) => {
    if (!signers.has(a)) throw new MockTxError(`Missing required signature for ${role} ${a}`, logs);
  };
  const tokenAccount = (a: string, role: string): MockTokenAccount => {
    const t = tokens[a];
    if (!t) throw new MockTxError(`${role} token account ${a} does not exist (invalid account data)`, logs);
    return t;
  };
  const checkMint = (t: MockTokenAccount, mint: string, decimals: number) => {
    if (t.mint !== mint) throw new MockTxError('custom program error: 0x3 (mint mismatch)', logs);
    if (input.mintDecimals[mint] !== decimals) throw new MockTxError('custom program error: 0x12 (decimals mismatch)', logs);
  };

  const accountKeys: string[] = [input.feePayer];
  const noteKey = (a: string) => {
    if (!accountKeys.includes(a)) accountKeys.push(a);
  };
  const memos: string[] = [];
  const transfers: MockTransfer[] = [];
  const approves: MockApprove[] = [];
  const preToken = new Map<string, bigint>();
  const notePreToken = (a: string) => {
    if (!preToken.has(a) && tokens[a]) preToken.set(a, tokens[a].amount);
  };

  // Fee first (the fee payer must be able to pay it even if every instruction succeeds).
  const fee = LAMPORTS_PER_SIGNATURE * BigInt(Math.max(1, signers.size));
  if (!signers.has(input.feePayer)) throw new MockTxError('The fee payer did not sign', logs);
  if (bal(input.feePayer) < fee) throw new MockTxError('Attempt to debit an account but found no record of a prior credit (insufficient funds for fee)', logs);
  debit(input.feePayer, fee, 'fee');

  input.instructions.forEach((raw, index) => {
    const program = raw.programAddress;
    for (const meta of raw.accounts ?? []) noteKey(meta.address);
    noteKey(program);
    logs.push(`Program ${program} invoke [1]`);
    try {
      if (program === SYSTEM_PROGRAM) {
        const ix = withAccountsAndData(raw);
        if (identifySystemInstruction(ix) !== SystemInstruction.TransferSol) throw new MockTxError('Unsupported System instruction', logs);
        const p = parseTransferSolInstruction(ix);
        const from = addr(p.accounts.source, 'source');
        const to = addr(p.accounts.destination, 'destination');
        requireSigner(from, 'transfer source');
        debit(from, p.data.amount, `Transfer: from ${from}`);
        credit(to, p.data.amount);
        transfers.push({ from, to, lamports: p.data.amount });
      } else if (program === TOKEN_PROGRAM) {
        const ix = withAccountsAndData(raw);
        const kind = identifyTokenInstruction(ix);
        if (kind === TokenInstruction.ApproveChecked) {
          const p = parseApproveCheckedInstruction(ix);
          const source = addr(p.accounts.source, 'source');
          const mint = addr(p.accounts.mint, 'mint');
          const delegate = addr(p.accounts.delegate, 'delegate');
          const owner = addr(p.accounts.owner, 'owner');
          const t = tokenAccount(source, 'Source');
          checkMint(t, mint, p.data.decimals);
          if (t.owner !== owner) throw new MockTxError('custom program error: 0x4 (owner does not match)', logs);
          requireSigner(owner, 'token owner');
          t.delegate = delegate;
          t.delegatedAmount = p.data.amount;
          approves.push({ source, mint, delegate, owner, amount: p.data.amount, decimals: p.data.decimals });
          logs.push('Program log: Instruction: ApproveChecked');
        } else if (kind === TokenInstruction.TransferChecked) {
          const p = parseTransferCheckedInstruction(ix);
          const source = addr(p.accounts.source, 'source');
          const mint = addr(p.accounts.mint, 'mint');
          const destination = addr(p.accounts.destination, 'destination');
          const authority = addr(p.accounts.authority, 'authority');
          const from = tokenAccount(source, 'Source');
          const to = tokenAccount(destination, 'Destination');
          checkMint(from, mint, p.data.decimals);
          checkMint(to, mint, p.data.decimals);
          requireSigner(authority, 'transfer authority');
          const amount = p.data.amount;
          const selfTransfer = source === destination;
          if (authority === from.owner) {
            // owner transfer
          } else if (from.delegate === authority) {
            if (from.delegatedAmount < amount) throw new MockTxError('custom program error: 0x1 (insufficient funds: allowance)', logs);
            if (!selfTransfer) {
              from.delegatedAmount -= amount;
              if (from.delegatedAmount === 0n) from.delegate = null;
            }
          } else {
            throw new MockTxError('custom program error: 0x4 (owner does not match)', logs);
          }
          if (from.amount < amount) throw new MockTxError('custom program error: 0x1 (insufficient funds)', logs);
          notePreToken(source);
          notePreToken(destination);
          if (!selfTransfer) {
            from.amount -= amount;
            to.amount += amount;
          }
          logs.push('Program log: Instruction: TransferChecked');
        } else if (kind === TokenInstruction.Revoke) {
          const p = parseRevokeInstruction(ix);
          const source = addr(p.accounts.source, 'source');
          const owner = addr(p.accounts.owner, 'owner');
          const t = tokenAccount(source, 'Source');
          if (t.owner !== owner) throw new MockTxError('custom program error: 0x4 (owner does not match)', logs);
          requireSigner(owner, 'token owner');
          t.delegate = null;
          t.delegatedAmount = 0n;
          logs.push('Program log: Instruction: Revoke');
        } else {
          throw new MockTxError(`Unsupported SPL Token instruction ${TokenInstruction[kind] ?? kind}`, logs);
        }
      } else if (program === ATA_PROGRAM) {
        const ix = withAccountsAndData(raw);
        if (identifyAssociatedTokenInstruction(ix) !== AssociatedTokenInstruction.CreateAssociatedTokenIdempotent) {
          throw new MockTxError('Unsupported Associated Token instruction', logs);
        }
        const p = parseCreateAssociatedTokenIdempotentInstruction(ix);
        const payer = addr(p.accounts.payer, 'payer');
        const ata = addr(p.accounts.ata, 'ata');
        const owner = addr(p.accounts.owner, 'owner');
        const mint = addr(p.accounts.mint, 'mint');
        const existing = tokens[ata];
        if (existing) {
          if (existing.owner !== owner || existing.mint !== mint) throw new MockTxError('Provided owner is not allowed (illegal owner)', logs);
        } else {
          if (input.mintDecimals[mint] === undefined) throw new MockTxError(`Unknown mint ${mint}`, logs);
          requireSigner(payer, 'ATA payer');
          const rent = rentExemptMinimum(TOKEN_ACCOUNT_BYTES);
          debit(payer, rent, `Create token account: payer ${payer}`);
          lamports[ata] = rent;
          tokens[ata] = { mint, owner, amount: 0n, delegate: null, delegatedAmount: 0n };
          preToken.set(ata, 0n);
        }
      } else if ((SUPPORTED_MEMO_PROGRAM_ADDRESSES as readonly string[]).includes(program)) {
        if (!raw.data) throw new MockTxError('Memo instruction without data', logs);
        const text = parseAddMemoInstruction(raw as Instruction & { data: ReadonlyUint8Array }).data.memo;
        for (const meta of raw.accounts ?? []) requireSigner(meta.address, 'memo signer');
        memos.push(text);
        logs.push(`Program log: Memo (len ${new TextEncoder().encode(text).length}): ${JSON.stringify(text)}`);
      } else {
        throw new MockTxError(`Unsupported program ${program}`, logs);
      }
      logs.push(`Program ${program} success`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logs.push(`Program ${program} failed: ${message}`);
      throw new MockTxError(`Error processing Instruction ${index}: ${message}`, logs);
    }
  });

  // Rent: a system account may not end between 0 and its rent-exempt minimum.
  const rent0 = rentExemptMinimum(0);
  for (const a of touched) {
    if (tokens[a]) continue;
    const b = bal(a);
    if (b > 0n && b < rent0) {
      throw new MockTxError(`Transaction results in an account (${a}) with insufficient funds for rent`, logs);
    }
  }

  const tokenDeltas: MockTokenDelta[] = [...preToken.entries()].map(([account, pre]) => ({
    account,
    mint: tokens[account].mint,
    owner: tokens[account].owner,
    pre,
    post: tokens[account].amount,
  }));
  const slot = state.slot + 1;
  const tx: MockTx = {
    sig: input.sig,
    slot,
    blockTime: input.blockTime,
    feePayer: input.feePayer,
    fee,
    accounts: accountKeys,
    memos,
    transfers,
    approves,
    tokenDeltas,
  };
  const txs = [...state.txs, tx];
  return { state: { slot, lamports, tokens, txs: txs.length > MAX_TXS ? txs.slice(-MAX_TXS) : txs }, tx };
}

/**
 * MOCK faucet: credits SOL and mints test tokens into `owner`'s token account `ata` (created if
 * missing). There is no real mint authority in MOCK mode, so this is a privileged ledger write.
 */
export function mintTestFunds(
  state: MockLedgerState,
  p: { sig: string; blockTime: number; owner: string; ata: string; mint: string; lamports: bigint; tokenAmount: bigint },
): { state: MockLedgerState; tx: MockTx } {
  const lamports = { ...state.lamports, [p.owner]: (state.lamports[p.owner] ?? 0n) + p.lamports };
  const tokens: Record<string, MockTokenAccount> = {};
  for (const [k, v] of Object.entries(state.tokens)) tokens[k] = { ...v };
  const existing = tokens[p.ata];
  if (existing && (existing.owner !== p.owner || existing.mint !== p.mint)) throw new MockTxError('Token account belongs to someone else');
  const pre = existing?.amount ?? 0n;
  tokens[p.ata] = existing ?? { mint: p.mint, owner: p.owner, amount: 0n, delegate: null, delegatedAmount: 0n };
  if (!existing) lamports[p.ata] = rentExemptMinimum(TOKEN_ACCOUNT_BYTES);
  tokens[p.ata].amount += p.tokenAmount;
  const slot = state.slot + 1;
  const tx: MockTx = {
    sig: p.sig,
    slot,
    blockTime: p.blockTime,
    feePayer: p.owner,
    fee: 0n,
    accounts: [p.owner, p.ata, p.mint],
    memos: ['laden-teilen MOCK faucet'],
    transfers: p.lamports > 0n ? [{ from: 'MOCK-FAUCET', to: p.owner, lamports: p.lamports }] : [],
    approves: [],
    tokenDeltas: [{ account: p.ata, mint: p.mint, owner: p.owner, pre, post: tokens[p.ata].amount }],
  };
  return { state: { slot, lamports, tokens, txs: [...state.txs, tx] }, tx };
}

/** Transactions that mention `address`, newest first (like getSignaturesForAddress). */
export function txsForAddress(state: MockLedgerState, address: string, limit = 1000): MockTx[] {
  const out: MockTx[] = [];
  for (let i = state.txs.length - 1; i >= 0 && out.length < limit; i--) {
    if (state.txs[i].accounts.includes(address)) out.push(state.txs[i]);
  }
  return out;
}

/** The RPC `memo` field format: "[<byteLength>] <text>" joined with "; ". */
export const rpcMemoField = (memos: readonly string[]): string | null =>
  memos.length === 0 ? null : memos.map((m) => `[${new TextEncoder().encode(m).length}] ${m}`).join('; ');

// ---------------------------------------------------------------------------------------------
// JSON snapshot (bigints survive as {"$big": "..."}).
// ---------------------------------------------------------------------------------------------

export function serializeLedger(state: MockLedgerState): string {
  return JSON.stringify({ v: 1, ...state }, (_k, v: unknown) => (typeof v === 'bigint' ? { $big: v.toString() } : v));
}

export function deserializeLedger(json: string | null | undefined): MockLedgerState {
  if (!json) return emptyLedger();
  try {
    const parsed = JSON.parse(json, (_k, v: unknown) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const o = v as Record<string, unknown>;
        const keys = Object.keys(o);
        if (keys.length === 1 && keys[0] === '$big' && typeof o.$big === 'string') return BigInt(o.$big);
      }
      return v;
    }) as MockLedgerState & { v?: number };
    if (parsed.v !== 1 || typeof parsed.slot !== 'number' || !Array.isArray(parsed.txs)) return emptyLedger();
    return { slot: parsed.slot, lamports: parsed.lamports ?? {}, tokens: parsed.tokens ?? {}, txs: parsed.txs };
  } catch {
    return emptyLedger();
  }
}
