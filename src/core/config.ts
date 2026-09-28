// Central configuration. Works in the browser (Vite `import.meta.env`) and in Node scripts
// (tsx, `process.env`). Mints are always paired with the cluster: the EURC mint address is the
// same on devnet and mainnet, so never reuse this config against mainnet.
import { address, type Address } from '@solana/kit';

type EnvRecord = Record<string, string | undefined>;

/** Reads a `VITE_*` variable from Vite's build-time env, falling back to `process.env` in Node. */
export function readEnv(name: string): string | undefined {
  const viteEnv = import.meta.env as EnvRecord | undefined;
  const nodeEnv = (globalThis as { process?: { env?: EnvRecord } }).process?.env;
  const value = viteEnv?.[name] ?? nodeEnv?.[name];
  return value === undefined || value === '' ? undefined : value;
}

export const CLUSTER = 'devnet' as const;
export const RPC_URL = readEnv('VITE_RPC_URL') ?? 'https://api.devnet.solana.com';
export const WS_URL = readEnv('VITE_WS_URL') ?? 'wss://api.devnet.solana.com';

export type TokenSymbol = 'EURC' | 'USDC';
export type TokenConfig = Readonly<{ mint: Address; decimals: number; symbol: TokenSymbol }>;

/** Devnet mints (classic SPL Token program, 6 decimals each). */
export const TOKENS: Readonly<Record<TokenSymbol, TokenConfig>> = {
  EURC: { mint: address('HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr'), decimals: 6, symbol: 'EURC' },
  USDC: { mint: address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'), decimals: 6, symbol: 'USDC' },
};

/** Active token. EURC by default; set `VITE_TOKEN=USDC` to switch to devnet USDC. */
export const TOKEN: TokenConfig = readEnv('VITE_TOKEN')?.toUpperCase() === 'USDC' ? TOKENS.USDC : TOKENS.EURC;

// Programs (no custom program is used).
export const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
export const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
/** Classic SPL Memo program ("Memo v2"). Explorers parse it; @solana-program/memo defaults to a newer one. */
export const MEMO_PROGRAM = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

// Session economics.
/** Energy per payment step in Wh (0.1 kWh). */
export const STEP_WH = 100;
/** SOL the guest deposits to the session key in the start tx; the remainder is refunded at the end. */
export const FEE_DEPOSIT_LAMPORTS = 5_000_000n;
/** The kiosk refuses to charge when the start tx deposited less than this. */
export const MIN_DEPOSIT_LAMPORTS = 3_000_000n;
/** Stop trigger `sol`: spendable session-key lamports (above its rent-exempt reserve) fell below this. */
export const MIN_SOL_BUDGET_LAMPORTS = 20_000n;
/** Size of an SPL token account in bytes (for the owner ATA rent check). */
export const TOKEN_ACCOUNT_SIZE = 165;

export const DEFAULT_PRICE_EUR = '0.39';
export const DEFAULT_CAP_EUR = '5';
export const CAP_CHOICES_EUR = ['2', '5', '10'] as const;

// RPC budget (spec 4.6).
export const RPC_MAX_REQUESTS_PER_SECOND = 5;
export const POLL_INTERVAL_MS = 2_000;

export const APP_URL = 'https://alperderg229.github.io/laden-teilen/';

export const explorerTx = (sig: string): string => `https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}`;
export const explorerAddress = (addr: string): string =>
  `https://explorer.solana.com/address/${addr}?cluster=${CLUSTER}`;
