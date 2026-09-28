/**
 * Full "Laden teilen" session on Solana DEVNET, end to end, using only src/core:
 *
 *   fund guest (treasury) -> start (guest: SOL deposit + ApproveChecked + memo)
 *   -> kiosk ChargerSession detects the start tx and pulls 5 steps (pay #1 creates the owner ATA)
 *   -> after step 5 the guest stops (Revoke + memo) -> kiosk ends (memo + sweep of all lamports)
 *   -> RPC assertions -> reclaim leftovers to the treasury.
 *
 * Usage:
 *   npm run e2e:devnet                     full run (needs a funded devnet treasury)
 *   npm run e2e:devnet -- --smoke          Kit smoke checks only (no funds needed)
 *   npm run e2e:devnet -- --no-reclaim     keep the ephemeral accounts' funds
 *   npm run e2e:devnet -- --reclaim-only   sweep keys saved by an interrupted run back to the treasury
 *   npm run e2e:devnet -- --init-treasury  create a throwaway devnet treasury in .env.treasury
 *
 * Treasury key: env DEV_TREASURY_SECRET (JSON array of 64 bytes, solana-keygen format), or a
 * dotenv file: $TREASURY_ENV_FILE, ./.env.treasury, ../.env.treasury. The secret is never printed.
 * DEVNET ONLY. Never point this at mainnet.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchMint,
  getCloseAccountInstruction,
  getTokenDecoder,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token';
import { getTransferSolInstruction } from '@solana-program/system';
import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isSome,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
} from '@solana/kit';
import { formatMicro, formatSol, parseEurToMicro, stepMicro as priceStep } from '../src/core/amounts.ts';
import {
  buildEndIxs,
  buildMemoIx,
  buildPayIxs,
  buildStartIxs,
  buildStopIxs,
  createChainClient,
  createChargerChain,
  type ChainClient,
} from '../src/core/chain.ts';
import {
  CLUSTER,
  DEFAULT_CAP_EUR,
  DEFAULT_PRICE_EUR,
  MEMO_PROGRAM,
  RPC_URL,
  STEP_WH,
  SYSTEM_PROGRAM,
  TOKEN,
  TOKEN_ACCOUNT_SIZE,
  TOKEN_PROGRAM,
  explorerAddress,
  explorerTx,
} from '../src/core/config.ts';
import { ChainError, errorMessage } from '../src/core/errors.ts';
import { decodeMemo, sidOf } from '../src/core/memo.ts';
import { ChargerSession, type ChargerPort } from '../src/core/session.ts';
import { sleep } from '../src/core/throttle.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEYS_FILE = resolve(ROOT, '.env.e2e-keys.json'); // gitignored via .env*
const REPORT_FILE = resolve(ROOT, 'docs/e2e-devnet.md');

const PULLS = 5;
const FUND_GUEST_LAMPORTS = 20_000_000n; // 0.02 SOL
const FUND_GUEST_MICRO = 1_000_000n; // 1 EURC
const TREASURY_MIN_LAMPORTS = 50_000_000n; // 0.05 SOL
const TREASURY_MIN_MICRO = 1_000_000n; // 1 EURC

const args = new Set(process.argv.slice(2));
const json = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));
const transcript: string[] = [];
function out(line = ''): void {
  transcript.push(line);
  console.log(line);
}

// ---------------------------------------------------------------------------------------------
// Treasury key handling (the secret is never printed)
// ---------------------------------------------------------------------------------------------

function parseDotenv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

function treasuryFiles(): string[] {
  return [process.env.TREASURY_ENV_FILE, resolve(ROOT, '.env.treasury'), resolve(ROOT, '../.env.treasury')].filter(
    (f): f is string => Boolean(f),
  );
}

function parseSecretArray(raw: string, name: string, length: number): Uint8Array {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not a JSON array`); // do not echo the value
  }
  if (!Array.isArray(parsed) || parsed.length !== length || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    throw new Error(`${name} must be a JSON array of ${length} bytes`);
  }
  return Uint8Array.from(parsed as number[]);
}

async function loadTreasury(): Promise<KeyPairSigner | null> {
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
  if (expected && expected !== signer.address) throw new Error(`DEV_TREASURY_PUBKEY does not match the secret key`);
  return signer;
}

async function initTreasury(): Promise<void> {
  const existing = await loadTreasury();
  if (existing) {
    out(`A treasury already exists: ${existing.address}`);
    return;
  }
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(secret);
  const full = new Uint8Array(64);
  full.set(secret, 0);
  full.set(getAddressEncoder().encode(signer.address), 32);
  const file = resolve(ROOT, '.env.treasury');
  writeFileSync(
    file,
    `# DEVNET ONLY throwaway treasury - never use on mainnet, never commit\nDEV_TREASURY_PUBKEY=${signer.address}\nDEV_TREASURY_SECRET=${JSON.stringify([...full])}\n`,
    { mode: 0o600 },
  );
  out(`Created ${file} (gitignored).`);
  out(`Fund ${signer.address} by hand: faucet.solana.com (devnet SOL) and faucet.circle.com (EURC, Solana Devnet).`);
}

// ---------------------------------------------------------------------------------------------
// Ephemeral keys (persisted so an interrupted run can be reclaimed)
// ---------------------------------------------------------------------------------------------

type Role = 'guest' | 'owner' | 'session';
type Keys = Record<Role, KeyPairSigner>;

async function createKeys(): Promise<Keys> {
  const secrets = {} as Record<Role, number[]>;
  const keys = {} as Keys;
  for (const role of ['guest', 'owner', 'session'] as const) {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    secrets[role] = [...secret];
    keys[role] = await createKeyPairSignerFromPrivateKeyBytes(secret);
  }
  const addresses = Object.fromEntries(Object.entries(keys).map(([r, k]) => [r, k.address]));
  writeFileSync(KEYS_FILE, JSON.stringify({ createdAt: new Date().toISOString(), cluster: CLUSTER, addresses, secrets }, null, 2), {
    mode: 0o600,
  });
  chmodSync(KEYS_FILE, 0o600);
  return keys;
}

async function loadSavedKeys(): Promise<Keys | null> {
  if (!existsSync(KEYS_FILE)) return null;
  const saved = JSON.parse(readFileSync(KEYS_FILE, 'utf8')) as { secrets: Record<Role, number[]> };
  const keys = {} as Keys;
  for (const role of ['guest', 'owner', 'session'] as const) {
    keys[role] = await createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(saved.secrets[role]));
  }
  return keys;
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

const links: { label: string; sig: string }[] = [];
function recordTx(label: string, sig: string): void {
  links.push({ label, sig });
  out(`  ✓ ${label.padEnd(26)} ${explorerTx(sig)}`);
}

/** Builds, (partially) signs and simulates without signature verification. */
async function simulate(client: ChainClient, payer: TransactionSigner, ixs: Instruction[], tokenAccount?: Address) {
  const { value: blockhash } = await client.rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await partiallySignTransactionMessageWithSigners(message);
  const wire = getBase64EncodedWireTransaction(signed);
  const config = { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true } as const;
  let value: { err: unknown; logs: readonly string[] | null };
  let post: string | undefined;
  if (tokenAccount) {
    const res = await client.rpc.simulateTransaction(wire, { ...config, accounts: { addresses: [tokenAccount], encoding: 'base64' } }).send();
    value = res.value;
    post = res.value.accounts[0]?.data[0];
  } else {
    value = (await client.rpc.simulateTransaction(wire, config).send()).value;
  }
  const token = post ? getTokenDecoder().decode(getBase64Encoder().encode(post)) : null;
  let sig = '(unsigned)';
  try {
    sig = getSignatureFromTransaction(signed);
  } catch {
    // the fee payer is a no-op signer in the semantic simulation
  }
  return { err: value.err, logs: value.logs ?? [], bytes: Math.round((wire.length * 3) / 4), sig, token };
}

/** A real devnet wallet (system account with SOL) holding the token, found via recent mint activity. */
async function findFundedHolder(client: ChainClient): Promise<{ owner: Address; tokenAccount: Address } | null> {
  const sigs = await client.rpc.getSignaturesForAddress(client.token.mint, { limit: 8 }).send();
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await client.rpc.getTransaction(s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }).send();
    const keys = tx?.transaction.message.accountKeys.map((k) => k.pubkey) ?? [];
    for (const b of tx?.meta?.postTokenBalances ?? []) {
      if (b.mint !== client.token.mint || !b.owner || BigInt(b.uiTokenAmount.amount) < 1_000_000n || !keys[b.accountIndex]) continue;
      const info = (await client.rpc.getAccountInfo(b.owner, { encoding: 'base64' }).send()).value;
      if (info && info.owner === SYSTEM_PROGRAM && info.lamports >= 10_000_000n) return { owner: b.owner, tokenAccount: keys[b.accountIndex] };
    }
  }
  return null;
}

/** Kit checks that need no funds: reads, jsonParsed, build + sign of all 4 tx types, simulations. */
async function kitSmoke(client: ChainClient): Promise<void> {
  out('Kit smoke checks (no funds needed)');
  const rent0 = await client.getRentExemptMinimum(0);
  const rent165 = await client.getRentExemptMinimum(TOKEN_ACCOUNT_SIZE);
  out(`  rent-exempt minimum: 0 bytes = ${rent0} lamports, ${TOKEN_ACCOUNT_SIZE} bytes = ${rent165} lamports (queried at runtime)`);

  const mint = await fetchMint(client.rpc, client.token.mint);
  if (mint.programAddress !== TOKEN_PROGRAM || mint.data.decimals !== client.token.decimals) {
    throw new Error(`Unexpected mint ${client.token.mint}: owner ${mint.programAddress}, decimals ${mint.data.decimals}`);
  }
  out(`  ${client.token.symbol} mint ${client.token.mint}: SPL Token, ${mint.data.decimals} decimals ✓`);

  const recent = await client.rpc.getSignaturesForAddress(MEMO_PROGRAM, { limit: 5 }).send();
  const sample = recent.find((s) => !s.err && s.memo);
  if (sample) {
    const tx = await client.rpc
      .getTransaction(sample.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 })
      .send();
    const parsedMemo = tx?.transaction.message.instructions.some(
      (ix) => 'parsed' in ix && ix.programId === MEMO_PROGRAM && typeof (ix as { parsed: unknown }).parsed === 'string',
    );
    out(`  jsonParsed memo read via Kit (${sample.memo?.slice(0, 24)}...): ${parsedMemo ? '✓' : '?'}; foreign memo decodes to ${decodeMemo(sample.memo)}`);
  }

  const [g, s, o] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
  const sid = sidOf(s.address);
  const gAta = await client.findAta(g.address);
  const oAta = await client.findAta(o.address);
  const price = parseEurToMicro(DEFAULT_PRICE_EUR);
  const cap = parseEurToMicro(DEFAULT_CAP_EUR);
  const step = priceStep(price, STEP_WH);
  const txs: [string, KeyPairSigner, Instruction[]][] = [
    ['start', g, buildStartIxs({ guest: g, guestAta: gAta, session: s.address, capMicro: cap, sid, priceMicroPerKWh: price })],
    ['pay #1', s, await buildPayIxs({ session: s, guestAta: gAta, owner: o.address, ownerAta: oAta, amountMicro: step, seq: 1, whCum: STEP_WH, sid, createOwnerAta: true })],
    ['stop', g, buildStopIxs({ guest: g, guestAta: gAta, sid })],
    ['end', s, buildEndIxs({ session: s, guest: g.address, lamports: 1_000_000n, sid, whTotal: 500, totalMicro: 5n * step, reason: 'revoked' })],
  ];
  for (const [label, payer, ixs] of txs) {
    const sim = await simulate(client, payer, ixs);
    out(
      `  ${label.padEnd(7)} built + signed (${ixs.length} ixs, ${sim.bytes} bytes, sig ${sim.sig.slice(0, 8)}...), ` +
        `simulated: ${sim.err ? `runtime error ${json(sim.err)} (expected: unfunded keys)` : 'ok'}`,
    );
  }

  // getFeeForMessage from compiled message bytes (used to sweep the session key to exactly 0).
  const endFee = await client.estimateFee(s, buildEndIxs({ session: s, guest: g.address, lamports: 1n, sid, whTotal: 0, totalMicro: 0n, reason: 'user' }));
  const reclaimFee = await client.estimateFee(g, [
    getTransferCheckedInstruction({ source: oAta, mint: client.token.mint, destination: gAta, authority: o, amount: 1n, decimals: client.token.decimals }),
    getCloseAccountInstruction({ account: oAta, destination: g.address, owner: o }),
  ]);
  if (endFee !== 5_000n || reclaimFee !== 10_000n) throw new Error(`Unexpected fee estimates: end ${endFee}, 2-signer ${reclaimFee}`);
  out(`  fee estimate via getFeeForMessage: end tx ${endFee} lamports (1 signer), reclaim tx ${reclaimFee} lamports (2 signers) ✓`);

  // sendTransaction path: an unfunded payer must fail fast at preflight as a non-retryable program error.
  const sendError = await client.sendIxs(g, buildStopIxs({ guest: g, guestAta: gAta, sid })).then(
    () => null,
    (e: unknown) => e,
  );
  if (!(sendError instanceof ChainError) || sendError.kind !== 'program') {
    throw new Error(`Expected a preflight ChainError('program'), got ${errorMessage(sendError)}`);
  }
  out(`  sendIxs with an unfunded payer: ChainError(program) at preflight ✓ (${sendError.message.slice(0, 60)})`);

  // Semantic check against the real programs: a funded EURC holder as the (unsigned) guest.
  const holder = await findFundedHolder(client);
  if (!holder) {
    out('  (no funded EURC holder found for the semantic simulation; skipped)');
    return;
  }
  const guest = createNoopSigner(holder.owner);
  const s2 = await generateKeyPairSigner();
  const sid2 = sidOf(s2.address);
  const start = await simulate(
    client,
    guest,
    buildStartIxs({ guest, guestAta: holder.tokenAccount, session: s2.address, capMicro: cap, sid: sid2, priceMicroPerKWh: price }),
    holder.tokenAccount,
  );
  const approved = start.token && isSome(start.token.delegate) && start.token.delegate.value === s2.address && start.token.delegatedAmount === cap;
  const memoOk = start.logs.some((l) => l.includes(`Program ${MEMO_PROGRAM} success`));
  if (start.err || !approved || !memoOk) throw new Error(`Semantic simulation of start failed: ${json(start.err)} ${start.logs.join(' / ')}`);
  out(`  start   simulated for real holder ${holder.owner.slice(0, 8)}... (sigVerify off): ok; post-state delegate = session key, delegatedAmount = ${cap} ✓`);
  const stop = await simulate(client, guest, buildStopIxs({ guest, guestAta: holder.tokenAccount, sid: sid2 }), holder.tokenAccount);
  if (stop.err || !stop.token || isSome(stop.token.delegate)) throw new Error(`Semantic simulation of stop failed: ${json(stop.err)} ${stop.logs.join(' / ')}`);
  out(`  stop    simulated for the same holder: ok; post-state delegate = none ✓`);
}

async function balances(client: ChainClient, owner: Address): Promise<{ lamports: bigint; micro: bigint; ata: Address }> {
  const ata = await client.findAta(owner);
  const [lamports, allowance] = await Promise.all([client.getSolBalance(owner), client.getAllowance(ata)]);
  return { lamports, micro: allowance.balanceMicro, ata };
}

/** Sends `ixs` paid by `payer`, sweeping `sweepFrom`'s whole SOL balance to `to` in the same tx. */
async function sendWithSweep(client: ChainClient, payer: KeyPairSigner, ixs: Instruction[], to: Address): Promise<string> {
  const balance = await client.getSolBalance(payer.address);
  const draft = [...ixs, getTransferSolInstruction({ source: payer, destination: to, amount: 1n })];
  const fee = await client.estimateFee(payer, draft);
  const amount = balance - fee;
  return client.sendIxs(payer, amount > 0n ? [...ixs, getTransferSolInstruction({ source: payer, destination: to, amount })] : ixs);
}

/** Moves everything held by the ephemeral keys back to the treasury. */
async function reclaim(client: ChainClient, keys: Keys, treasury: KeyPairSigner): Promise<void> {
  out('Reclaiming leftovers to the treasury');
  const treasuryAta = await client.findAta(treasury.address);
  const mint = client.token.mint;
  const decimals = client.token.decimals;
  for (const role of ['owner', 'guest', 'session'] as const) {
    const key = keys[role];
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
    ixs.unshift(buildMemoIx('laden-teilen e2e: reclaim to treasury'));
    // Keys without SOL (the owner) let the treasury pay the fee; the others sweep themselves to 0.
    const sig = lamports > 0n ? await sendWithSweep(client, key, ixs, treasury.address) : await client.sendIxs(treasury, [...ixs]);
    recordTx(`reclaim ${role}`, sig);
  }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main(): Promise<number> {
  out(`Laden teilen - devnet end-to-end session (${new Date().toISOString()})`);
  out(`RPC ${RPC_URL} · token ${TOKEN.symbol} ${TOKEN.mint} · memo program ${MEMO_PROGRAM}`);
  out();

  if (args.has('--init-treasury')) {
    await initTreasury();
    return 0;
  }

  const client = createChainClient();
  await kitSmoke(client);
  out();
  if (args.has('--smoke')) return 0;

  const treasury = await loadTreasury();
  if (!treasury) {
    out('No treasury key found. Set DEV_TREASURY_SECRET or run: npm run e2e:devnet -- --init-treasury');
    return 2;
  }

  if (args.has('--reclaim-only')) {
    const keys = await loadSavedKeys();
    if (!keys) {
      out(`Nothing to reclaim (${KEYS_FILE} not found).`);
      return 0;
    }
    await reclaim(client, keys, treasury);
    rmSync(KEYS_FILE);
    return 0;
  }

  const t = await balances(client, treasury.address);
  out(`Treasury ${treasury.address}: ${formatSol(t.lamports)} SOL, ${formatMicro(t.micro)} ${TOKEN.symbol}`);
  if (t.lamports < TREASURY_MIN_LAMPORTS || t.micro < TREASURY_MIN_MICRO) {
    out();
    out(
      `BLOCKED-ON-FUNDS: treasury needs ≥${formatSol(TREASURY_MIN_LAMPORTS)} SOL and ≥${formatMicro(TREASURY_MIN_MICRO)} ${TOKEN.symbol} — fund ${treasury.address}`,
    );
    out(`  found: ${formatSol(t.lamports)} SOL (${t.lamports} lamports), ${formatMicro(t.micro)} ${TOKEN.symbol} (${t.micro} micro)`);
    out('  SOL: https://faucet.solana.com (devnet) · EURC: https://faucet.circle.com (EURC, Solana Devnet)');
    return 2;
  }
  if (existsSync(KEYS_FILE)) {
    out(`${KEYS_FILE} exists from an earlier run. Run with --reclaim-only first (or delete it).`);
    return 2;
  }

  // 1. Ephemeral keys (saved first, so funds are recoverable if anything below fails).
  const keys = await createKeys();
  const { guest, owner, session } = keys;
  const sid = sidOf(session.address);
  const guestAta = await client.findAta(guest.address);
  const ownerAta = await client.findAta(owner.address);
  const price = parseEurToMicro(DEFAULT_PRICE_EUR);
  const capMicro = parseEurToMicro(DEFAULT_CAP_EUR);
  const step = priceStep(price, STEP_WH);
  out('Ephemeral keys (secrets saved to .env.e2e-keys.json, gitignored)');
  out(`  guest   ${guest.address}   token account ${guestAta}`);
  out(`  owner   ${owner.address}   token account ${ownerAta}`);
  out(`  session ${session.address}   sid ${sid}`);
  out(`  price ${formatMicro(price)} ${TOKEN.symbol}/kWh · step ${STEP_WH} Wh = ${formatMicro(step)} ${TOKEN.symbol} · cap ${formatMicro(capMicro)} ${TOKEN.symbol}`);
  out();

  // 2. Fund the guest from the treasury.
  out('Transactions');
  const treasuryAta = t.ata;
  recordTx(
    'fund guest (treasury)',
    await client.sendIxs(treasury, [
      getTransferSolInstruction({ source: treasury, destination: guest.address, amount: FUND_GUEST_LAMPORTS }),
      getCreateAssociatedTokenIdempotentInstruction({ payer: treasury, ata: guestAta, owner: guest.address, mint: TOKEN.mint }),
      getTransferCheckedInstruction({
        source: treasuryAta,
        mint: TOKEN.mint,
        destination: guestAta,
        authority: treasury,
        amount: FUND_GUEST_MICRO,
        decimals: TOKEN.decimals,
      }),
      buildMemoIx('laden-teilen e2e: fund demo guest'),
    ]),
  );

  // 3. Guest start tx: SOL fee deposit + ApproveChecked(cap) to the session key + start memo.
  const guestLamportsBefore = await client.getSolBalance(guest.address);
  recordTx(
    'start (guest)',
    await client.sendIxs(guest, buildStartIxs({ guest, guestAta, session: session.address, capMicro, sid, priceMicroPerKWh: price })),
  );

  // 4. Kiosk loop with the real chain adapter. The scripted charger stops the guest after step 5.
  const stop: { sig: string | null } = { sig: null };
  const charger: ChargerPort = {
    async deliver(_wh) {
      await sleep(250); // simulated energy delivery
      const delivered = kiosk.progress.payments;
      if (delivered < PULLS) return;
      // Guest presses "Stop & revoke" (second wallet approval). Wait until the revoke is visible
      // before handing control back, so the kiosk's next allowance check sees it.
      stop.sig = await client.sendIxs(guest, buildStopIxs({ guest, guestAta, sid }));
      recordTx('stop (guest revoke)', stop.sig);
      for (let i = 0; i < 20 && (await client.getAllowance(guestAta)).delegate !== null; i++) await sleep(1_000);
    },
  };
  const kiosk = new ChargerSession({
    session,
    owner: owner.address,
    priceMicroPerKWh: price,
    chain: createChargerChain(client),
    charger,
  });
  kiosk.on('guest', (g) =>
    out(`  · kiosk found start tx: guest ${g.guest.slice(0, 8)}..., cap ${formatMicro(g.capMicro)} ${TOKEN.symbol}, deposit ${formatSol(g.depositLamports)} SOL`),
  );
  kiosk.on('payment', (p) => recordTx(`pay #${p.seq} (${formatMicro(p.amountMicro)} ${TOKEN.symbol}, ${p.whCum} Wh)`, p.sig));
  kiosk.on('error', (e) => out(`  ! kiosk ${e.fatal ? 'error' : 'warning'}: ${e.message}`));
  const result = await kiosk.start();
  if (result.endSig) recordTx(`end (${result.reason}, refund)`, result.endSig);
  out(
    `  · session ended: reason=${result.reason}, ${result.payments} payments, ${result.whDelivered} Wh, ` +
      `${formatMicro(result.totalMicro)} ${TOKEN.symbol}, refund ${result.refundLamports === null ? '-' : formatSol(result.refundLamports)} SOL`,
  );
  out();

  // 5. Assertions via RPC (with retries for indexing lag on the public RPC).
  out('Assertions');
  const checks: [string, boolean, string][] = [];
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push([name, ok, detail]);
    out(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  };
  const eventually = async <T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> => {
    let value = await read();
    for (let i = 0; i < 10 && !ok(value); i++) {
      await sleep(2_000);
      value = await read();
    }
    return value;
  };

  check('session ended by guest revoke', result.reason === 'revoked' && result.endSig !== null, `reason=${result.reason}, endSig=${result.endSig ?? 'none'}`);
  check('exactly 5 pulls', result.payments === PULLS && stop.sig !== null, `${result.payments} payments`);
  const guestAcc = await eventually(() => client.getAllowance(guestAta), (a) => a.delegate === null);
  check('guest token account delegate == null', guestAcc.delegate === null, `delegate=${guestAcc.delegate}, delegatedAmount=${guestAcc.delegatedMicro}`);
  const sessionLamports = await eventually(() => client.getSolBalance(session.address), (l) => l === 0n);
  check('session key balance == 0', sessionLamports === 0n, `${sessionLamports} lamports`);
  const ownerAcc = await eventually(() => client.getAllowance(ownerAta), (a) => a.balanceMicro === BigInt(PULLS) * step);
  check(
    `owner received ${PULLS} × stepMicro`,
    ownerAcc.balanceMicro === BigInt(PULLS) * step,
    `${ownerAcc.balanceMicro} micro = ${formatMicro(ownerAcc.balanceMicro)} ${TOKEN.symbol} (expected ${BigInt(PULLS) * step})`,
  );
  const payments = await eventually(() => client.listSessionPayments(ownerAta, sid), (p) => p.length === PULLS);
  const seqOk = payments.map((p) => p.seq).join(',') === '1,2,3,4,5' && payments.every((p) => p.amountMicro === step && p.whCum === p.seq * STEP_WH);
  check('pay memos via getSignaturesForAddress(ownerAta)', seqOk, `seq ${payments.map((p) => p.seq).join(',')} for sid ${sid}`);
  const verified = await Promise.all(payments.map((p) => client.verifyPayment(p.sig, ownerAta)));
  check(
    'each pay tx moved exactly its memo amount',
    verified.length === PULLS && verified.every((v) => v.ok && v.payer === guest.address),
    verified.map((v) => `${v.receivedMicro}`).join(', '),
  );
  const end = await eventually(() => client.findSessionEnd(guest.address, sid), (e) => e !== null);
  check(
    'end memo on the guest wallet',
    end !== null && end.whTotal === PULLS * STEP_WH && end.totalMicro === BigInt(PULLS) * step,
    end ? `LT1|end|${sid}|${end.whTotal}|${end.totalMicro}|${end.reason}` : 'not found',
  );
  const guestLamportsAfter = await client.getSolBalance(guest.address);
  out(
    `  info  guest SOL: ${formatSol(guestLamportsBefore)} before start -> ${formatSol(guestLamportsAfter)} after refund ` +
      `(net cost ${formatSol(guestLamportsBefore - guestLamportsAfter)} SOL incl. owner token-account rent)`,
  );
  out();

  const passed = checks.every(([, ok]) => ok);

  // 6. Reclaim leftovers (after the assertions; closed accounts keep their history).
  if (!args.has('--no-reclaim')) {
    try {
      await reclaim(client, keys, treasury);
      rmSync(KEYS_FILE);
    } catch (e) {
      out(`  ! reclaim failed (${errorMessage(e)}); retry with: npm run e2e:devnet -- --reclaim-only`);
    }
    out();
  }

  out('Explorer links');
  for (const { label, sig } of links) out(`  ${label.padEnd(26)} ${explorerTx(sig)}`);
  out(`  owner wallet               ${explorerAddress(owner.address)}`);
  out(`  owner token account        ${explorerAddress(ownerAta)}`);
  out();
  out(passed ? `RESULT: PASS (${links.length} confirmed transactions)` : 'RESULT: FAIL');

  if (passed) writeReport({ sid, keys, guestAta, ownerAta, checks });
  return passed ? 0 : 1;
}

function writeReport(r: { sid: string; keys: Keys; guestAta: Address; ownerAta: Address; checks: [string, boolean, string][] }): void {
  const rows = links.map(({ label, sig }) => `| ${label} | [${sig.slice(0, 16)}...](${explorerTx(sig)}) |`).join('\n');
  const md = `# Devnet end-to-end run

Output of \`npm run e2e:devnet\` (\`scripts/e2e-session.ts\`), recorded ${new Date().toISOString()}.
Cluster: ${CLUSTER}. Token: ${TOKEN.symbol} \`${TOKEN.mint}\`. Memo program: \`${MEMO_PROGRAM}\`.
Stack: @solana/kit 8.3.0, @solana-program/token 0.17.0, memo 0.15.0, system 0.15.0.

## Accounts

| Role | Address |
|---|---|
| Guest wallet | [${r.keys.guest.address}](${explorerAddress(r.keys.guest.address)}) |
| Guest token account | [${r.guestAta}](${explorerAddress(r.guestAta)}) |
| Owner wallet | [${r.keys.owner.address}](${explorerAddress(r.keys.owner.address)}) |
| Owner token account | [${r.ownerAta}](${explorerAddress(r.ownerAta)}) |
| Session key (sid \`${r.sid}\`) | [${r.keys.session.address}](${explorerAddress(r.keys.session.address)}) |

## Transactions (all confirmed)

| Step | Signature |
|---|---|
${rows}

## Assertions

${r.checks.map(([name, ok, detail]) => `- ${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`).join('\n')}

The ephemeral keys were discarded after the run and their leftovers were reclaimed to the dev
treasury; the closed accounts keep their full transaction history on the explorer.

## Console output

\`\`\`text
${transcript.join('\n')}
\`\`\`
`;
  mkdirSync(dirname(REPORT_FILE), { recursive: true });
  writeFileSync(REPORT_FILE, md);
  console.log(`Report written to ${REPORT_FILE}`);
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`\nE2E failed: ${errorMessage(e)}`);
    if (existsSync(KEYS_FILE)) console.error(`Ephemeral keys kept in ${KEYS_FILE}; recover funds with: npm run e2e:devnet -- --reclaim-only`);
    process.exit(1);
  },
);
