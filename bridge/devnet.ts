// Devnet helpers for the bridge: treasury key loading (never printed), ephemeral key files that
// survive a crash, funding a scripted guest from the treasury, and reclaiming leftovers.
// Adapted from scripts/e2e-session.ts (which cannot be imported: it runs on import).
// DEVNET ONLY. Never point any of this at mainnet.
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { buildMemoIx, type ChainClient } from '../src/core/chain.ts';
import { CLUSTER } from '../src/core/config.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------------------------
// Treasury (DEV_TREASURY_SECRET env, or a dotenv file; the secret is never printed)
// ---------------------------------------------------------------------------------------------

function parseDotenv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

function parseSecretArray(raw: string, name: string, length: number): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not a JSON array`); // never echo the value
  }
  if (!Array.isArray(parsed) || parsed.length !== length || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    throw new Error(`${name} must be a JSON array of ${length} bytes`);
  }
  return Uint8Array.from(parsed as number[]);
}

export function treasuryFiles(): string[] {
  return [process.env.TREASURY_ENV_FILE, resolve(ROOT, '.env.treasury'), resolve(ROOT, '../.env.treasury')].filter(
    (f): f is string => Boolean(f),
  );
}

export async function loadTreasury(): Promise<KeyPairSigner | null> {
  let raw = process.env.DEV_TREASURY_SECRET;
  let expected = process.env.DEV_TREASURY_PUBKEY;
  if (!raw) {
    for (const file of treasuryFiles()) {
      if (!existsSync(file)) continue;
      const env = parseDotenv(readFileSync(file, 'utf8'));
      if (env.DEV_TREASURY_SECRET) {
        raw = env.DEV_TREASURY_SECRET;
        expected = env.DEV_TREASURY_PUBKEY;
        break;
      }
    }
  }
  if (!raw) return null;
  const signer = await createKeyPairSignerFromBytes(parseSecretArray(raw, 'DEV_TREASURY_SECRET', 64));
  if (expected && expected !== signer.address) throw new Error('DEV_TREASURY_PUBKEY does not match the secret key');
  return signer;
}

// ---------------------------------------------------------------------------------------------
// Ephemeral keys, persisted (0600, gitignored via .env*) so a crashed run can be recovered
// ---------------------------------------------------------------------------------------------

export type KeyRole = 'guest' | 'owner' | 'session';

export interface KeyFile {
  path: string;
  keys: Partial<Record<KeyRole, KeyPairSigner>>;
  /** Non-secret context saved with the keys (e.g. the owner address). */
  meta?: Record<string, string>;
}

export async function createKeyFile(
  path: string,
  roles: readonly KeyRole[],
  note: string,
  meta: Record<string, string> = {},
): Promise<KeyFile> {
  if (existsSync(path)) throw new Error(`${path} exists from an earlier run; recover it first (see docs/bridge.md)`);
  const secrets: Partial<Record<KeyRole, number[]>> = {};
  const keys: Partial<Record<KeyRole, KeyPairSigner>> = {};
  for (const role of roles) {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    secrets[role] = [...secret];
    keys[role] = await createKeyPairSignerFromPrivateKeyBytes(secret);
  }
  const addresses = Object.fromEntries(Object.entries(keys).map(([role, k]) => [role, k.address]));
  writeFileSync(path, JSON.stringify({ note, createdAt: new Date().toISOString(), cluster: CLUSTER, meta, addresses, secrets }, null, 2), {
    mode: 0o600,
  });
  chmodSync(path, 0o600);
  return { path, keys, meta };
}

export async function loadKeyFile(path: string): Promise<KeyFile | null> {
  if (!existsSync(path)) return null;
  const saved = JSON.parse(readFileSync(path, 'utf8')) as { secrets: Partial<Record<KeyRole, number[]>>; meta?: Record<string, string> };
  const keys: Partial<Record<KeyRole, KeyPairSigner>> = {};
  for (const [role, secret] of Object.entries(saved.secrets) as [KeyRole, number[]][]) {
    keys[role] = await createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(secret));
  }
  return { path, keys, meta: saved.meta };
}

export const removeKeyFile = (file: KeyFile): void => rmSync(file.path, { force: true });

// ---------------------------------------------------------------------------------------------
// Funding and reclaim
// ---------------------------------------------------------------------------------------------

export async function balances(client: ChainClient, owner: Address): Promise<{ lamports: bigint; micro: bigint; ata: Address }> {
  const ata = await client.findAta(owner);
  const [lamports, account] = await Promise.all([client.getSolBalance(owner), client.getAllowance(ata)]);
  return { lamports, micro: account.balanceMicro, ata };
}

/** Treasury -> guest: SOL for the deposit and fees, the guest's token account, and tokens. */
export async function fundGuest(
  client: ChainClient,
  treasury: KeyPairSigner,
  guest: Address,
  lamports: bigint,
  micro: bigint,
): Promise<string> {
  const { mint, decimals } = client.token;
  const treasuryAta = await client.findAta(treasury.address);
  const guestAta = await client.findAta(guest);
  return client.sendIxs(treasury, [
    getTransferSolInstruction({ source: treasury, destination: guest, amount: lamports }),
    getCreateAssociatedTokenIdempotentInstruction({ payer: treasury, ata: guestAta, owner: guest, mint }),
    getTransferCheckedInstruction({ source: treasuryAta, mint, destination: guestAta, authority: treasury, amount: micro, decimals }),
    buildMemoIx('laden-teilen bridge: fund scripted guest'),
  ]);
}

/** Sends `ixs` paid by `payer` and sweeps the payer's whole SOL balance to `to` in the same tx. */
async function sendWithSweep(client: ChainClient, payer: KeyPairSigner, ixs: Instruction[], to: Address): Promise<string> {
  const balance = await client.getSolBalance(payer.address);
  const fee = await client.estimateFee(payer, [...ixs, getTransferSolInstruction({ source: payer, destination: to, amount: 1n })]);
  const amount = balance - fee;
  return client.sendIxs(payer, amount > 0n ? [...ixs, getTransferSolInstruction({ source: payer, destination: to, amount })] : ixs);
}

/** Moves everything the ephemeral keys hold back to the treasury (closed accounts keep their history). */
export async function reclaimToTreasury(
  client: ChainClient,
  keys: Partial<Record<KeyRole, KeyPairSigner>>,
  treasury: KeyPairSigner,
  onTx: (label: string, sig: string) => void,
): Promise<void> {
  const { mint, decimals } = client.token;
  const treasuryAta = await client.findAta(treasury.address);
  for (const role of ['owner', 'guest', 'session'] as const) {
    const key = keys[role];
    if (!key) continue;
    const { lamports, ata } = await balances(client, key.address);
    const account = await client.getAllowance(ata);
    const ixs: Instruction[] = [];
    if (account.exists) {
      if (account.balanceMicro > 0n) {
        ixs.push(getTransferCheckedInstruction({ source: ata, mint, destination: treasuryAta, authority: key, amount: account.balanceMicro, decimals }));
      }
      ixs.push(getCloseAccountInstruction({ account: ata, destination: treasury.address, owner: key }));
    }
    if (ixs.length === 0 && lamports === 0n) continue;
    ixs.unshift(buildMemoIx('laden-teilen bridge: reclaim to treasury'));
    // Keys without SOL (the owner) let the treasury pay the fee; the others sweep themselves to 0.
    const sig = lamports > 0n ? await sendWithSweep(client, key, ixs, treasury.address) : await client.sendIxs(treasury, [...ixs]);
    onTx(`reclaim ${role}`, sig);
  }
}
