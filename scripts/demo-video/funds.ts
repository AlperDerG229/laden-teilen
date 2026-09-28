// Devnet money for the FINAL demo take (scripts/record-demo.ts --final): load the dev treasury
// (the secret is never printed), check its balances, fund a fresh demo guest and sweep the guest's
// leftovers back afterwards.
//
// DEVNET ONLY. Funds come from the treasury and nowhere else: the public faucets are for humans
// (faucet.solana.com asks AI agents not to use it), so a human tops up the treasury by hand.
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTransferSolInstruction } from '@solana-program/system';
import {
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token';
import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import { formatMicro, formatSol } from '../../src/core/amounts.ts';
import { buildMemoIx, type ChainClient } from '../../src/core/chain.ts';
import { CLUSTER } from '../../src/core/config.ts';

/** What a final take gives the demo guest: fee deposit + network fees, and EURC for the session. */
export const FUND_GUEST_LAMPORTS = 20_000_000n; // 0.02 SOL
export const FUND_GUEST_MICRO = 3_000_000n; // 3 EURC
/** The treasury must hold at least this before a take starts (funding plus token-account rent and fees). */
export const TREASURY_MIN_LAMPORTS = 30_000_000n; // 0.03 SOL
export const TREASURY_MIN_MICRO = 3_000_000n; // 3 EURC

// ---------------------------------------------------------------------------------------------
// Treasury key (same sources as scripts/e2e-session.ts)
// ---------------------------------------------------------------------------------------------

function parseDotenv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

function parseSecretArray(raw: string, name: string, lengths: readonly number[]): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not a JSON array`); // never echo the value
  }
  if (!Array.isArray(parsed) || !lengths.includes(parsed.length) || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    throw new Error(`${name} must be a JSON array of ${lengths.join(' or ')} bytes`);
  }
  return Uint8Array.from(parsed as number[]);
}

/**
 * The devnet dev treasury from env DEV_TREASURY_SECRET or a dotenv file ($TREASURY_ENV_FILE,
 * <repo>/.env.treasury, <repo>/../.env.treasury). Returns null when none is configured.
 */
export async function loadTreasury(root: string): Promise<KeyPairSigner | null> {
  let raw = process.env.DEV_TREASURY_SECRET;
  let expected = process.env.DEV_TREASURY_PUBKEY;
  if (!raw) {
    const files = [process.env.TREASURY_ENV_FILE, resolve(root, '.env.treasury'), resolve(root, '../.env.treasury')];
    for (const file of files) {
      if (!file || !existsSync(file)) continue;
      const env = parseDotenv(readFileSync(file, 'utf8'));
      if (env.DEV_TREASURY_SECRET) {
        raw = env.DEV_TREASURY_SECRET;
        expected = env.DEV_TREASURY_PUBKEY;
        break;
      }
    }
  }
  if (!raw) return null;
  const signer = await createKeyPairSignerFromBytes(parseSecretArray(raw, 'DEV_TREASURY_SECRET', [64]));
  if (expected && expected !== signer.address) throw new Error('DEV_TREASURY_PUBKEY does not match the secret key');
  return signer;
}

// ---------------------------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------------------------

export interface Balances {
  lamports: bigint;
  micro: bigint;
  ata: Address;
  ataExists: boolean;
}

export async function balances(client: ChainClient, owner: Address): Promise<Balances> {
  const ata = await client.findAta(owner);
  const [lamports, account] = await Promise.all([client.getSolBalance(owner), client.getAllowance(ata)]);
  return { lamports, micro: account.balanceMicro, ata, ataExists: account.exists };
}

export const describeBalances = (b: Pick<Balances, 'lamports' | 'micro'>, symbol: string): string =>
  `${formatSol(b.lamports)} SOL, ${formatMicro(b.micro)} ${symbol}`;

export const treasuryIsFunded = (b: Pick<Balances, 'lamports' | 'micro'>): boolean =>
  b.lamports >= TREASURY_MIN_LAMPORTS && b.micro >= TREASURY_MIN_MICRO;

// ---------------------------------------------------------------------------------------------
// The demo guest: saved before it is funded, so a crashed take can always be swept
// ---------------------------------------------------------------------------------------------

interface SavedGuest {
  createdAt: string;
  cluster: string;
  address: string;
  /** 32 private-key bytes, the same format the app's demo wallet uses. */
  secret: number[];
}

export function saveGuest(file: string, address: Address, secret: Uint8Array): void {
  const saved: SavedGuest = { createdAt: new Date().toISOString(), cluster: CLUSTER, address, secret: [...secret] };
  writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

export async function loadSavedGuest(file: string): Promise<KeyPairSigner | null> {
  if (!existsSync(file)) return null;
  const saved = JSON.parse(readFileSync(file, 'utf8')) as SavedGuest;
  const signer = await createKeyPairSignerFromPrivateKeyBytes(parseSecretArray(JSON.stringify(saved.secret), 'saved guest secret', [32]));
  if (signer.address !== saved.address) throw new Error(`${file}: the address does not match the secret`);
  return signer;
}

export const forgetGuest = (file: string): void => rmSync(file, { force: true });

// ---------------------------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------------------------

/** Treasury -> guest: 0.02 SOL, the guest's EURC account (idempotent) and 3 EURC, in one tx. */
export async function fundGuest(client: ChainClient, treasury: KeyPairSigner, guest: Address): Promise<string> {
  const [treasuryAta, guestAta] = await Promise.all([client.findAta(treasury.address), client.findAta(guest)]);
  const { mint, decimals } = client.token;
  return client.sendIxs(treasury, [
    getTransferSolInstruction({ source: treasury, destination: guest, amount: FUND_GUEST_LAMPORTS }),
    getCreateAssociatedTokenIdempotentInstruction({ payer: treasury, ata: guestAta, owner: guest, mint }),
    getTransferCheckedInstruction({ source: treasuryAta, mint, destination: guestAta, authority: treasury, amount: FUND_GUEST_MICRO, decimals }),
    buildMemoIx('laden-teilen demo video: fund demo guest'),
  ]);
}

/**
 * Guest -> treasury: all EURC, the token account's rent (close) and every lamport, in one tx that
 * the treasury pays for, so the guest ends at exactly 0. Returns null when there is nothing left.
 * Works with an active delegate too (a take that crashed mid-session): the owner can always move
 * and close its own token account.
 */
export async function sweepGuest(client: ChainClient, treasury: KeyPairSigner, guest: KeyPairSigner): Promise<string | null> {
  const [treasuryAta, guestAta] = await Promise.all([client.findAta(treasury.address), client.findAta(guest.address)]);
  const [lamports, account] = await Promise.all([client.getSolBalance(guest.address), client.getAllowance(guestAta)]);
  const { mint, decimals } = client.token;
  const ixs: Instruction[] = [];
  if (account.exists) {
    if (account.balanceMicro > 0n) {
      ixs.push(
        getTransferCheckedInstruction({ source: guestAta, mint, destination: treasuryAta, authority: guest, amount: account.balanceMicro, decimals }),
      );
    }
    ixs.push(getCloseAccountInstruction({ account: guestAta, destination: treasury.address, owner: guest }));
  }
  if (lamports > 0n) ixs.push(getTransferSolInstruction({ source: guest, destination: treasury.address, amount: lamports }));
  if (ixs.length === 0) return null;
  return client.sendIxs(treasury, [buildMemoIx('laden-teilen demo video: sweep demo guest to treasury'), ...ixs]);
}
