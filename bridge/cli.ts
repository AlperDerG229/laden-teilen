/**
 * Laden teilen · wallbox bridge (WP5): the kiosk loop of the web app (src/core ChargerSession), but
 * the energy comes from a real wallbox through evcc (or a go-e charger) and the QR code is printed
 * in the terminal. The bridge only switches the charge mode through the evcc / go-e API.
 *
 *   npm run bridge -- --help
 *   npm run bridge:smoke        mock chain + live `evcc --demo` container (no funds needed)
 *   npm run bridge -- --chain devnet --owner <wallet> --loadpoint 1      a real guest scans the QR
 *   npm run bridge:devnet       devnet session with a scripted guest funded from the dev treasury
 *
 * DEVNET ONLY: the chain side uses src/core/config.ts (devnet RPC, devnet EURC).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { address, generateKeyPairSigner, type Address, type KeyPairSigner } from '@solana/kit';
import { formatMicro, formatSol, parseEurToMicro, stepMicro } from '../src/core/amounts.ts';
import {
  buildStartIxs,
  buildStopIxs,
  createChainClient,
  createChargerChain,
  generateSessionKey,
  type ChainClient,
} from '../src/core/chain.ts';
import {
  CLUSTER,
  DEFAULT_CAP_EUR,
  DEFAULT_PRICE_EUR,
  RPC_URL,
  STEP_WH,
  TOKEN,
  explorerAddress,
  explorerTx,
} from '../src/core/config.ts';
import { errorMessage } from '../src/core/errors.ts';
import { sidOf } from '../src/core/memo.ts';
import { ChargerSession, type SessionResult } from '../src/core/session.ts';
import { sleep } from '../src/core/throttle.ts';
import {
  ROOT,
  balances,
  createKeyFile,
  fundGuest,
  loadKeyFile,
  loadTreasury,
  reclaimToTreasury,
  removeKeyFile,
  type KeyFile,
} from './devnet.ts';
import { MockChain } from './mock-chain.ts';
import { EvccPort } from './ports/evcc.ts';
import { GoePort } from './ports/goe.ts';
import { SimPort } from './ports/sim.ts';
import type { ChargerPort } from './ports/types.ts';
import { guestUrl, phantomBrowseUrl, terminalQr } from './qr.ts';
import { BridgeRun, createLogger, type Logger } from './run.ts';

const SESSION_KEY_FILE = resolve(ROOT, '.env.bridge-session.json'); // gitignored via .env*
const SCRIPTED_KEYS_FILE = resolve(ROOT, '.env.bridge-keys.json');
const DOC_FILE = resolve(ROOT, 'docs/bridge.md');
const DOC_START = '<!-- devnet-run:start -->';
const DOC_END = '<!-- devnet-run:end -->';

const TREASURY_MIN_LAMPORTS = 50_000_000n; // 0.05 SOL
const TREASURY_MIN_MICRO = 1_000_000n; // 1 EURC
const FUND_GUEST_LAMPORTS = 20_000_000n; // 0.02 SOL
const FUND_GUEST_MICRO = 1_000_000n; // 1 EURC

const HELP = `Laden teilen · wallbox bridge (devnet)

Usage: npm run bridge -- [options]

Charger
  --charger evcc|goe|sim   energy side (default evcc)
  --evcc-url URL           evcc base URL (env EVCC_URL, default http://127.0.0.1:7070)
  --loadpoint N            evcc loadpoint id, 1-based (env EVCC_LOADPOINT, default 1)
                           evcc API key: env EVCC_API_KEY (optional, sent as Bearer token)
  --goe-url URL            go-e charger base URL on the LAN (env GOE_URL)
  --sim-power W            simulator power (default 11000)   --sim-speed X   time factor (default 1)

Chain
  --chain mock|devnet      mock = in-memory chain + scripted guest, no funds (default)
                           devnet = real transactions (src/core, devnet EURC)
  --guest human|scripted   devnet only: a person scans the QR (default) or a scripted guest
                           funded from the dev treasury (.env.treasury) signs in-process
  --owner ADDRESS          owner payout wallet (required for --chain devnet --guest human)
  --recover                devnet: end a session left behind in .env.bridge-session.json (refund)

Session
  --price EUR              price per kWh (default ${DEFAULT_PRICE_EUR})
  --cap EUR                cap suggested in the QR link (default ${DEFAULT_CAP_EUR})
  --name TEXT              wallbox name shown to the guest
  --step-wh N              energy per payment step (default ${STEP_WH})
  --lead-wh N              pull the next step when metered >= paid - lead (default: one step)
  --poll-ms N              charger polling interval (default 2000)
  --idle-timeout S         end with "full" after S seconds without energy (default 120)
  --stop-after-wh N        operator stop after N metered Wh (demos)

Scripted guest (mock and --guest scripted)
  --guest-cap EUR          allowance the scripted guest approves (default: --cap)
  --guest-delay S          seconds until the scripted guest's start tx (default 3)
  --revoke-after N         the scripted guest presses "Stop & revoke" after N payments

Other
  --smoke                  mock chain against the live evcc demo, then PASS/FAIL checks
  --no-qr                  do not draw the QR code
  -h, --help
`;

interface CliOptions {
  charger: 'evcc' | 'goe' | 'sim';
  evccUrl: string;
  loadpoint: number;
  goeUrl: string | undefined;
  simPowerW: number;
  simSpeed: number;
  chain: 'mock' | 'devnet';
  guest: 'human' | 'scripted';
  owner: Address | undefined;
  recover: boolean;
  priceMicro: bigint;
  capMicro: bigint;
  name: string;
  stepWh: number;
  leadWh: number;
  pollMs: number;
  idleTimeoutMs: number;
  stopAfterWh: number | undefined;
  guestCapMicro: bigint | undefined;
  guestDelayMs: number;
  revokeAfter: number | undefined;
  smoke: boolean;
  qr: boolean;
  help: boolean;
}

function parseCli(argv: string[]): CliOptions {
  const { values: v } = parseArgs({
    args: argv,
    strict: true,
    options: {
      charger: { type: 'string' },
      'evcc-url': { type: 'string' },
      loadpoint: { type: 'string' },
      'goe-url': { type: 'string' },
      'sim-power': { type: 'string' },
      'sim-speed': { type: 'string' },
      chain: { type: 'string' },
      guest: { type: 'string' },
      owner: { type: 'string' },
      recover: { type: 'boolean' },
      price: { type: 'string' },
      cap: { type: 'string' },
      name: { type: 'string' },
      'step-wh': { type: 'string' },
      'lead-wh': { type: 'string' },
      'poll-ms': { type: 'string' },
      'idle-timeout': { type: 'string' },
      'stop-after-wh': { type: 'string' },
      'guest-cap': { type: 'string' },
      'guest-delay': { type: 'string' },
      'revoke-after': { type: 'string' },
      smoke: { type: 'boolean' },
      'no-qr': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const smoke = v.smoke === true;
  const oneOf = <T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T => {
    const x = value ?? fallback;
    if (!(allowed as readonly string[]).includes(x)) throw new Error(`--${name} must be one of ${allowed.join(', ')}`);
    return x as T;
  };
  const number = (name: string, value: string | undefined, fallback: number, min: number): number => {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n < min) throw new Error(`--${name} must be a number >= ${min}`);
    return n;
  };
  const integer = (name: string, value: string | undefined, fallback: number, min: number): number => {
    const n = number(name, value, fallback, min);
    if (!Number.isSafeInteger(n)) throw new Error(`--${name} must be an integer`);
    return n;
  };
  const stepWh = integer('step-wh', v['step-wh'], STEP_WH, 1);
  const priceMicro = parseEurToMicro(v.price ?? DEFAULT_PRICE_EUR);
  const chain = smoke ? 'mock' : oneOf('chain', v.chain, ['mock', 'devnet'] as const, 'mock');
  return {
    charger: oneOf('charger', v.charger, ['evcc', 'goe', 'sim'] as const, 'evcc'),
    evccUrl: v['evcc-url'] ?? process.env.EVCC_URL ?? 'http://127.0.0.1:7070',
    loadpoint: integer('loadpoint', v.loadpoint ?? process.env.EVCC_LOADPOINT, smoke ? 2 : 1, 1),
    goeUrl: v['goe-url'] ?? process.env.GOE_URL,
    simPowerW: number('sim-power', v['sim-power'], 11_000, 1),
    simSpeed: number('sim-speed', v['sim-speed'], 1, 0.001),
    chain,
    guest: oneOf('guest', v.guest, ['human', 'scripted'] as const, 'human'),
    owner: v.owner === undefined ? undefined : address(v.owner),
    recover: v.recover === true,
    priceMicro,
    capMicro: parseEurToMicro(v.cap ?? DEFAULT_CAP_EUR),
    name: v.name ?? 'Laden teilen wallbox',
    stepWh,
    leadWh: number('lead-wh', v['lead-wh'], stepWh, 0),
    pollMs: integer('poll-ms', v['poll-ms'], 2_000, 200),
    idleTimeoutMs: number('idle-timeout', v['idle-timeout'], 120, 5) * 1000,
    stopAfterWh: v['stop-after-wh'] === undefined ? undefined : number('stop-after-wh', v['stop-after-wh'], 0, 1),
    // The smoke run ends by the cap after three steps.
    guestCapMicro: v['guest-cap'] !== undefined ? parseEurToMicro(v['guest-cap']) : smoke ? 3n * stepMicro(priceMicro, stepWh) : undefined,
    guestDelayMs: number('guest-delay', v['guest-delay'], 3, 0) * 1000,
    revokeAfter: v['revoke-after'] === undefined ? undefined : integer('revoke-after', v['revoke-after'], 1, 1),
    smoke,
    qr: v['no-qr'] !== true,
    help: v.help === true,
  };
}

function makePort(o: CliOptions): ChargerPort {
  switch (o.charger) {
    case 'evcc':
      return new EvccPort({ url: o.evccUrl, loadpoint: o.loadpoint, apiKey: process.env.EVCC_API_KEY });
    case 'goe':
      if (!o.goeUrl) throw new Error('--goe-url (or env GOE_URL) is required for --charger goe');
      return new GoePort({ url: o.goeUrl });
    case 'sim':
      return new SimPort({ powerW: o.simPowerW, speed: o.simSpeed });
  }
}

/** Reads the charger once, prints what the bridge found, and switches it off until a guest pays. */
async function preflight(port: ChargerPort, log: Logger): Promise<boolean> {
  try {
    const r = await port.read();
    let what = port.label;
    let wasOn = r.enabled || r.charging;
    if (port instanceof EvccPort) {
      const [lp, info] = await Promise.all([port.readLoadpoint(), port.readInfo()]);
      what = `evcc ${info.version}${info.demoMode ? ' (demo mode)' : ''} at ${port.url} · ${port.label}${lp.vehicleTitle ? ` · vehicle "${lp.vehicleTitle}"` : ''}`;
      wasOn ||= lp.mode !== 'off'; // e.g. `pv` could start charging on surplus before a guest paid
    }
    log(`${what} · ${r.connected ? 'plugged in' : 'NO vehicle plugged in'}`);
    log(`  ${r.detail}`);
    // The bridge owns this loadpoint while it runs: off until a guest pays (idempotent).
    await port.stop();
    if (wasOn) log(`  switched OFF until a guest pays${port.actions ? ` (${port.actions.off})` : ''}`);
    if (!r.connected) log('  warning: plug in a vehicle; a session without energy ends with "full" after the idle timeout');
    return true;
  } catch (e) {
    log(`cannot use ${port.label}: ${errorMessage(e)}`);
    if (port instanceof EvccPort) log('  local test: docker run --rm -d --name evcc-demo -p 7070:7070 evcc/evcc --demo');
    return false;
  }
}

async function showQr(o: CliOptions, session: Address, owner: Address, log: Logger): Promise<void> {
  const url = guestUrl({ session, owner, price: formatMicro(o.priceMicro), name: o.name, cap: formatMicro(o.capMicro) });
  if (o.qr) console.log(`\n${await terminalQr(url)}`);
  log(`scan to charge: ${url}`);
  if (o.chain === 'devnet') log(`in Phantom:     ${phantomBrowseUrl(url)}`);
}

function installSigint(run: BridgeRun, port: ChargerPort, log: Logger): () => void {
  let presses = 0;
  const handler = () => {
    presses++;
    if (presses === 1) {
      log('Ctrl+C: stopping. The energy already paid for is delivered, then the charger is switched off,');
      log('        the end tx sent and the deposit refunded. Ctrl+C again: switch off now.');
      run.requestStop('user', 'operator pressed Ctrl+C', { drain: true });
      return;
    }
    if (presses === 2) {
      log('Ctrl+C: switching off now (the end tx still follows). Ctrl+C again: abort without the end tx.');
      run.skipDrain();
      return;
    }
    log('aborting: switching the charger off; no end tx (devnet: npm run bridge -- --chain devnet --recover)');
    void port
      .stop()
      .catch(() => undefined)
      .finally(() => process.exit(130));
  };
  process.on('SIGINT', handler);
  return () => process.off('SIGINT', handler);
}

// ---------------------------------------------------------------------------------------------
// Mock chain (+ smoke checks)
// ---------------------------------------------------------------------------------------------

async function runMock(o: CliOptions, port: ChargerPort, log: Logger): Promise<number> {
  const { signer: sessionKey } = await generateSessionKey();
  const owner = o.owner ?? (await generateKeyPairSigner()).address;
  const guest = (await generateKeyPairSigner()).address;
  const guestAta = (await generateKeyPairSigner()).address;
  const guestCap = o.guestCapMicro ?? o.capMicro;
  const chain = new MockChain({
    session: sessionKey.address,
    guest,
    guestAta,
    priceMicroPerKWh: o.priceMicro,
    capMicro: guestCap,
    startAfterMs: o.guestDelayMs,
    latencyMs: 800,
    revokeAfterPayments: o.revokeAfter,
    onEvent: (e) => {
      if (e.type === 'guest-start') log(`mock guest scanned the QR and approved ${formatMicro(e.capMicro)} ${TOKEN.symbol} (start tx)`);
      if (e.type === 'guest-revoke') log('mock guest pressed "Stop & revoke" (stop tx)');
    },
  });
  log(`chain: MOCK (in-memory, no funds; signatures are labelled mock:) · owner ${owner.slice(0, 8)}...`);
  await showQr(o, sessionKey.address, owner, log);
  const run = new BridgeRun({
    port,
    chain,
    sessionKey,
    owner,
    priceMicroPerKWh: o.priceMicro,
    stepWh: o.stepWh,
    leadWh: o.leadWh,
    pollMs: o.pollMs,
    idleTimeoutMs: o.idleTimeoutMs,
    stopAfterWh: o.stopAfterWh,
    sigLink: (sig) => sig,
    log,
  });
  const uninstall = installSigint(run, port, log);
  const result = await run.start();
  uninstall();
  if (!o.smoke) return result.reason === 'error' ? 1 : 0;

  // Smoke verdict: the whole loop against the live charger, with the chain mocked.
  const expectedSteps = Number(guestCap / stepMicro(o.priceMicro, o.stepWh));
  const finalMode = port instanceof EvccPort ? (await port.readLoadpoint()).mode : 'n/a';
  const end = chain.ends[0];
  const checks: [string, boolean, string][] = [
    ['charger switched on after pay #1 and off at the end', run.stats.switchedOn && run.stats.switchedOff === true, `on=${run.stats.switchedOn} off=${run.stats.switchedOff}`],
    ['session ended by the cap', result.reason === 'cap', `reason=${result.reason}`],
    [`${expectedSteps} payments pulled`, result.payments === expectedSteps, `${result.payments} payments`],
    ['energy was metered', run.stats.meteredWh > 0, `${run.stats.meteredWh.toFixed(1)} Wh`],
    ['pull before deliver: metered <= paid while charging', run.stats.maxUnpaidWh <= 0, `max(metered - paid) = ${run.stats.maxUnpaidWh.toFixed(1)} Wh`],
    ['paid energy delivered before switching off', run.stats.meteredWh >= result.payments * o.stepWh, `${run.stats.meteredWh.toFixed(1)} of ${result.payments * o.stepWh} Wh`],
    ['end memo carries the metered Wh', end !== undefined && end.whTotal === Math.floor(run.stats.meteredWh), `whTotal=${end?.whTotal}`],
    ['session key swept to 0 (deposit refunded)', chain.sessionLamports === 0n && result.refundLamports !== null, `refund ${formatSol(result.refundLamports ?? 0n)} SOL`],
  ];
  if (port instanceof EvccPort) checks.push(['evcc loadpoint back in mode off', finalMode === 'off', `mode=${finalMode}`]);
  log();
  log('Smoke checks');
  for (const [name, ok, detail] of checks) log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  const passed = checks.every(([, ok]) => ok);
  log(passed ? 'SMOKE: PASS' : 'SMOKE: FAIL');
  return passed ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------
// Devnet, human guest (the product path) + recovery
// ---------------------------------------------------------------------------------------------

async function runDevnetHuman(o: CliOptions, port: ChargerPort, log: Logger): Promise<number> {
  if (!o.owner) {
    log('--owner <wallet> is required on devnet (the payout wallet of the wallbox owner)');
    return 2;
  }
  const client = createChainClient();
  const keyFile = await createKeyFile(SESSION_KEY_FILE, ['session'], 'laden-teilen bridge session key; holds the guest deposit until the end tx', {
    owner: o.owner,
  });
  const sessionKey = keyFile.keys.session as KeyPairSigner;
  log(`chain: ${CLUSTER} via ${RPC_URL} · owner ${o.owner} · session key saved to ${keyFile.path} until the end tx`);
  await showQr(o, sessionKey.address, o.owner, log);
  const run = new BridgeRun({
    port,
    chain: createChargerChain(client),
    sessionKey,
    owner: o.owner,
    priceMicroPerKWh: o.priceMicro,
    stepWh: o.stepWh,
    leadWh: o.leadWh,
    pollMs: o.pollMs,
    idleTimeoutMs: o.idleTimeoutMs,
    stopAfterWh: o.stopAfterWh,
    sigLink: explorerTx,
    log,
  });
  const uninstall = installSigint(run, port, log);
  const result = await run.start();
  uninstall();
  await forgetSessionKeyIfDone(client, keyFile, result, log);
  return result.reason === 'error' ? 1 : 0;
}

async function forgetSessionKeyIfDone(client: ChainClient, keyFile: KeyFile, result: SessionResult, log: Logger): Promise<void> {
  const session = keyFile.keys.session as KeyPairSigner;
  const lamports = await client.getSolBalance(session.address).catch(() => null);
  if (result.endSig !== null || lamports === 0n) {
    removeKeyFile(keyFile);
  } else {
    log(`session key kept in ${keyFile.path} (balance ${lamports === null ? 'unknown' : `${formatSol(lamports)} SOL`}); run: npm run bridge -- --chain devnet --recover`);
  }
}

/** Ends a session that a crashed bridge left behind: end memo + refund of the deposit to the guest. */
async function recover(log: Logger): Promise<number> {
  const keyFile = await loadKeyFile(SESSION_KEY_FILE);
  const session = keyFile?.keys.session;
  if (!keyFile || !session) {
    log(`nothing to recover (${SESSION_KEY_FILE} not found)`);
    return 0;
  }
  const client = createChainClient();
  const start = await client.findStartTx(session.address);
  const lamports = await client.getSolBalance(session.address);
  log(`session key ${session.address}: ${formatSol(lamports)} SOL, start tx ${start ? explorerTx(start.sig) : 'none'}`);
  if (!start) {
    if (lamports === 0n) removeKeyFile(keyFile);
    else log('no start tx found, so there is no guest to refund; the key file is kept');
    return 0;
  }
  const payments = await client.listSessionPayments(start.guestAta, start.sid);
  const owner = (keyFile.meta?.owner as Address | undefined) ?? session.address; // pay() is never called below
  const recovery = new ChargerSession({
    session,
    owner,
    priceMicroPerKWh: start.priceMicroPerKWh,
    chain: createChargerChain(client),
    charger: { deliver: async () => {} },
    resume: {
      start,
      payments: payments.length,
      whDelivered: payments.at(-1)?.whCum ?? 0,
      totalMicro: payments.reduce((sum, p) => sum + p.amountMicro, 0n),
    },
  });
  recovery.stop('error');
  const result = await recovery.start();
  log(`recovered: ${result.payments} payments, refund ${formatSol(result.refundLamports ?? 0n)} SOL${result.endSig ? `   ${explorerTx(result.endSig)}` : ''}`);
  await forgetSessionKeyIfDone(client, keyFile, result, log);
  return result.endSig ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------
// Devnet, scripted guest funded from the dev treasury (WP5 acceptance run)
// ---------------------------------------------------------------------------------------------

async function runDevnetScripted(o: CliOptions, port: ChargerPort, log: Logger): Promise<number> {
  const treasury = await loadTreasury();
  if (!treasury) {
    log('No dev treasury key found (DEV_TREASURY_SECRET or .env.treasury).');
    return 2;
  }
  const client = createChainClient();
  const t = await balances(client, treasury.address);
  log(`treasury ${treasury.address}: ${formatSol(t.lamports)} SOL, ${formatMicro(t.micro)} ${TOKEN.symbol}`);
  if (t.lamports < TREASURY_MIN_LAMPORTS || t.micro < TREASURY_MIN_MICRO) {
    log(
      `BLOCKED-ON-FUNDS: the treasury needs >= ${formatSol(TREASURY_MIN_LAMPORTS)} SOL and >= ${formatMicro(TREASURY_MIN_MICRO)} ${TOKEN.symbol} ` +
        `(fund ${treasury.address} by hand: faucet.solana.com, faucet.circle.com)`,
    );
    return 2;
  }

  const keyFile = await createKeyFile(SCRIPTED_KEYS_FILE, ['guest', 'owner', 'session'], 'laden-teilen bridge scripted devnet run');
  const { guest, owner, session } = keyFile.keys as Record<'guest' | 'owner' | 'session', KeyPairSigner>;
  const sid = sidOf(session.address);
  const guestAta = await client.findAta(guest.address);
  const ownerAta = await client.findAta(owner.address);
  const guestCap = o.guestCapMicro ?? o.capMicro;
  const links: { label: string; sig: string }[] = [];
  const record = (label: string, sig: string) => links.push({ label, sig });
  log(`ephemeral keys saved to ${keyFile.path}: guest ${guest.address}, owner ${owner.address}, session ${session.address}`);

  let exitCode = 1;
  try {
    const fundSig = await fundGuest(client, treasury, guest.address, FUND_GUEST_LAMPORTS, FUND_GUEST_MICRO);
    record('fund guest (treasury)', fundSig);
    log(`funded the scripted guest with ${formatSol(FUND_GUEST_LAMPORTS)} SOL + ${formatMicro(FUND_GUEST_MICRO)} ${TOKEN.symbol}   ${explorerTx(fundSig)}`);
    await showQr(o, session.address, owner.address, log);

    // The scripted guest "scans" the QR and signs the start tx (deposit + ApproveChecked + memo).
    const guestStart = (async () => {
      await sleep(o.guestDelayMs);
      const ixs = buildStartIxs({ guest, guestAta, session: session.address, capMicro: guestCap, sid, priceMicroPerKWh: o.priceMicro });
      const sig = await client.sendIxs(guest, ixs);
      record('start (guest)', sig);
      log(`scripted guest signed the start tx (cap ${formatMicro(guestCap)} ${TOKEN.symbol})   ${explorerTx(sig)}`);
    })();
    let guestStop: Promise<void> | null = null;
    const run = new BridgeRun({
      port,
      chain: createChargerChain(client),
      sessionKey: session,
      owner: owner.address,
      priceMicroPerKWh: o.priceMicro,
      stepWh: o.stepWh,
      leadWh: o.leadWh,
      pollMs: o.pollMs,
      idleTimeoutMs: o.idleTimeoutMs,
      stopAfterWh: o.stopAfterWh,
      sigLink: explorerTx,
      log,
      onPayment: (p) => {
        record(`pay #${p.seq}`, p.sig);
        if (o.revokeAfter !== undefined && p.seq === o.revokeAfter) {
          guestStop = client.sendIxs(guest, buildStopIxs({ guest, guestAta, sid })).then((sig) => {
            record('stop (guest revoke)', sig);
            log(`scripted guest pressed "Stop & revoke"   ${explorerTx(sig)}`);
          });
        }
      },
    });
    const uninstall = installSigint(run, port, log);
    const [result] = await Promise.all([run.start(), guestStart]);
    uninstall();
    await (guestStop ?? Promise.resolve());
    if (result.endSig) record(`end (${result.reason}, refund)`, result.endSig);

    log();
    log('Checks (via RPC)');
    const checks: [string, boolean, string][] = [];
    const check = (name: string, ok: boolean, detail: string) => {
      checks.push([name, ok, detail]);
      log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
    };
    const eventually = async <T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> => {
      let value = await read();
      for (let i = 0; i < 10 && !ok(value); i++) {
        await sleep(2_000);
        value = await read();
      }
      return value;
    };
    const step = stepMicro(o.priceMicro, o.stepWh);
    check('charger switched on after pay #1 and off at the end', run.stats.switchedOn && run.stats.switchedOff === true, `on=${run.stats.switchedOn} off=${run.stats.switchedOff}`);
    check('session ended and refunded', result.endSig !== null, `reason=${result.reason}`);
    check('pull before deliver: metered <= paid while charging', run.stats.maxUnpaidWh <= 0, `max(metered - paid) = ${run.stats.maxUnpaidWh.toFixed(1)} Wh`);
    const sessionLamports = await eventually(() => client.getSolBalance(session.address), (l) => l === 0n);
    check('session key balance == 0', sessionLamports === 0n, `${sessionLamports} lamports`);
    const guestAcc = await eventually(() => client.getAllowance(guestAta), (a) => a.delegate === null);
    check('guest token account delegate == null', guestAcc.delegate === null, `delegate=${guestAcc.delegate}`);
    const expectedOwner = BigInt(result.payments) * step;
    const ownerAcc = await eventually(() => client.getAllowance(ownerAta), (a) => a.balanceMicro === expectedOwner);
    check(`owner received ${result.payments} x ${formatMicro(step)} ${TOKEN.symbol}`, ownerAcc.balanceMicro === expectedOwner, `${formatMicro(ownerAcc.balanceMicro)} ${TOKEN.symbol}`);
    const end = await eventually(() => client.findSessionEnd(guest.address, sid), (e) => e !== null);
    check(
      'end memo on the guest wallet carries the metered Wh',
      end !== null && end.whTotal === Math.floor(run.stats.meteredWh) && end.totalMicro === result.totalMicro,
      end ? `LT1|end|${sid}|${end.whTotal}|${end.totalMicro}|${end.reason}` : 'not found',
    );
    const passed = checks.every(([, ok]) => ok);

    log();
    await reclaimToTreasury(client, keyFile.keys, treasury, (label, sig) => {
      record(label, sig);
      log(`${label}   ${explorerTx(sig)}`);
    });
    removeKeyFile(keyFile);
    log();
    log('Explorer links');
    for (const { label, sig } of links) log(`  ${label.padEnd(24)} ${explorerTx(sig)}`);
    log(`  owner token account      ${explorerAddress(ownerAta)}`);
    log(passed ? `RESULT: PASS (${links.length} confirmed transactions)` : 'RESULT: FAIL');
    if (passed) writeDevnetReport(log.transcript, links);
    exitCode = passed ? 0 : 1;
  } catch (e) {
    log(`devnet run failed: ${errorMessage(e)}`);
    log(`ephemeral keys kept in ${keyFile.path}; their funds can be moved back with the reclaim helper in bridge/devnet.ts`);
  }
  return exitCode;
}

/** Replaces the devnet section of docs/bridge.md with this run's log and links. */
function writeDevnetReport(transcript: string[], links: { label: string; sig: string }[]): void {
  if (!existsSync(DOC_FILE)) return;
  const doc = readFileSync(DOC_FILE, 'utf8');
  const a = doc.indexOf(DOC_START);
  const b = doc.indexOf(DOC_END);
  if (a < 0 || b < a) return;
  const rows = links.map(({ label, sig }) => `| ${label} | [${sig.slice(0, 16)}...](${explorerTx(sig)}) |`).join('\n');
  const section = `${DOC_START}
Recorded ${new Date().toISOString()} with \`npm run bridge:devnet\` (energy from evcc, chain: ${CLUSTER}).

| Step | Transaction |
|---|---|
${rows}

\`\`\`text
${transcript.join('\n')}
\`\`\`
`;
  writeFileSync(DOC_FILE, doc.slice(0, a) + section + doc.slice(b));
  console.log(`devnet log written to ${DOC_FILE}`);
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<number> {
  let o: CliOptions;
  try {
    o = parseCli(process.argv.slice(2));
  } catch (e) {
    console.error(`${errorMessage(e)}\n\n${HELP}`);
    return 2;
  }
  if (o.help) {
    console.log(HELP);
    return 0;
  }
  const log = createLogger();
  log(`Laden teilen · wallbox bridge · chain ${o.chain}${o.chain === 'devnet' ? ` (${o.guest} guest)` : ''} · charger ${o.charger}`);
  if (o.recover) return recover(log);
  const port = makePort(o);
  if (!(await preflight(port, log))) return 1;
  if (o.chain === 'mock') return runMock(o, port, log);
  return o.guest === 'scripted' ? runDevnetScripted(o, port, log) : runDevnetHuman(o, port, log);
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`bridge failed: ${errorMessage(e)}`);
    process.exit(1);
  },
);
