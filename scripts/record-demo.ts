/**
 * Records the demo video (SPEC §11) with Playwright and ffmpeg: `npm run record`.
 *
 *   npm run record                          REHEARSAL (default): local production build (vite preview) in
 *                                           MOCK mode, banner visible. Output stays in video/raw/ (gitignored).
 *                                           A rehearsal is for checking timing and framing only: never
 *                                           publish or commit it.
 *   npm run record -- --final               FINAL: the live site on real devnet. Checks the dev treasury,
 *                                           funds a fresh demo guest from it (0.02 SOL + 3 EURC), records,
 *                                           sweeps the guest's leftovers back and writes public/demo.mp4
 *                                           plus docs/video.md. Exits with code 2 (BLOCKED-ON-FUNDS) at once
 *                                           when the treasury holds less than 0.03 SOL or 3 EURC.
 *   npm run record -- --final --sweep-only  returns the guest funds of an interrupted final take.
 *
 * Options: --speed <kWh per hour> (default 60: 0.1 kWh every 6 s; 600 gives a quick selector smoke run),
 *          --skip-build (rehearsal: reuse dist/), --port <n> (rehearsal preview port, default 4180),
 *          --fade <s> (crossfade between recorded pages, default 0.3; 0 = hard cuts), --crf <n> (x264, 20).
 * Env:     PW_CHROMIUM_PATH, PW_LD_LIBRARY_PATH (as for the e2e tests), FFMPEG_PATH / FFPROBE_PATH,
 *          DEV_TREASURY_SECRET or TREASURY_ENV_FILE (final; default <repo>/.env.treasury or ../.env.treasury).
 *
 * Deterministic: every step waits on data-testids or chain state. The only fixed waits are short
 * dwell times so viewers can read the captions. Each page records its own webm; an edit list cuts
 * and joins them into one 1280x720 30 fps H.264 MP4 (scripts/demo-video/edit.ts).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type BrowserContextOptions, type LaunchOptions, type Locator, type Page } from '@playwright/test';
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token';
import { createKeyPairSignerFromPrivateKeyBytes, getBase58Decoder, type Address, type KeyPairSigner } from '@solana/kit';
import { createChainClient, type ChainClient } from '../src/core/chain.ts';
import { APP_URL, TOKEN, explorerAddress, explorerTx } from '../src/core/config.ts';
import { MOCK_LEDGER_STORAGE_KEY } from '../src/sim/mock-chain.ts';
import { emptyLedger, mintTestFunds, serializeLedger } from '../src/sim/mock-ledger.ts';
import { DEMO_OWNER } from '../src/ui/demo-config.ts';
import { demoWalletKey } from '../src/ui/wallet/demo-wallet.ts';
import { FPS, HEIGHT, WIDTH, encode, findTools, formatClock, gate, probe, stills, type Segment, type Tools } from './demo-video/edit.ts';
import {
  FUND_GUEST_LAMPORTS,
  FUND_GUEST_MICRO,
  balances,
  describeBalances,
  forgetGuest,
  fundGuest,
  loadSavedGuest,
  loadTreasury,
  saveGuest,
  sweepGuest,
  treasuryIsFunded,
} from './demo-video/funds.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL = 'https://github.com/AlperDerG229/laden-teilen';
/** The final take's demo guest, saved before it is funded (gitignored via .env*). */
const GUEST_FILE = resolve(ROOT, '.env.demo-video-guest.json');
const VIEWPORT = { width: WIDTH, height: HEIGHT };

// ---------------------------------------------------------------------------------------------
// The script: captions (SPEC §11) and dwell times
// ---------------------------------------------------------------------------------------------

const CAPTIONS = {
  title: 'Laden teilen: pay-as-you-charge for private wallboxes. EURC on Solana (devnet).',
  problem:
    'Many EV drivers in German cities have no home charger, while private wallboxes sit idle. Sharing today means cash, PayPal chasing or platform subscriptions.',
  owner: 'The owner sets a price per kWh and a payout wallet. No sign-up, no merchant account, no signature.',
  guest:
    "The guest scans the QR and approves ONE transaction: a 5 EURC spending cap for this session's charger key plus a refundable 0.005 SOL fee deposit.",
  guestStarted: "The money stays in the guest's wallet. Here an in-page demo wallet on devnet; Phantom and Solflare work the same way.",
  charging: 'Every 0.1 kWh the charger pulls 0.039 EURC, before delivering the energy. Each payment is an on-chain receipt with a memo.',
  explorer: 'Payment #1 on a public Solana explorer (SolanaFM, devnet): the EURC transfer and its memo receipt LT1|pay|session|seq|Wh|amount.',
  explorerFallback: 'Every payment links to a public Solana explorer: the EURC transfer plus its memo receipt LT1|pay|session|seq|Wh|amount.',
  placeholder: '[REHEARSAL] Explorer scene placeholder: the final take opens payment #1 on a public Solana explorer here, memo visible.',
  stop: 'Stop anytime: the allowance is revoked and the unused fee deposit refunded. The guest paid exactly for the energy delivered.',
  dashboard: "A fresh browser with empty storage: the owner's dashboard is rebuilt purely from Solana history. No backend, no database.",
  closing:
    'Sub-cent fees make 0.1 kWh steps possible; EURC settles instantly in euros. Next: the evcc bridge on a physical wallbox and signed, Eichrecht-compliant meter readings on-chain.',
} as const;

/** `speed` is kWh per hour (60 = 1 kWh per minute). */
const chainCaption = (speed: number): string => {
  const perMinute = Number((speed / 60).toFixed(2));
  return `Demo speed: ${perMinute} kWh per minute. Display and phone share nothing but Solana devnet: both read the same payments from the chain.`;
};

/** Reading time per scene in ms (the scenes also wait for the app and the chain). */
const DWELL = {
  title: 10_000,
  problem: 14_000,
  ownerIntro: 1_500,
  ownerRead: 6_000,
  guestIntro: 5_000,
  guestReady: 3_000,
  startLink: 5_000,
  afterPayments: 3_000,
  explorerTop: 2_500,
  explorerMemo: 5_000,
  placeholder: 7_000,
  stopIntro: 2_500,
  receiptTop: 3_500,
  receipt: 6_500,
  dashboard: 10_000,
  closingMin: 12_000,
  closingMax: 22_000,
} as const;
/** Still frames taken at these marks, and the scene list in docs/video.md. */
const SCENE_NAMES: Record<string, string> = {
  title: 'Title card (landing page)',
  problem: 'The problem',
  owner: 'Owner setup: payout wallet and price per kWh',
  guest: 'Guest scans the QR code (demo wallet, cap 5 EURC)',
  started: 'One approval: the session starts (start tx link)',
  charging: 'Charging: a payment before every 0.1 kWh',
  payments: 'Six payments on the display and the phone',
  'explorer-top': 'Pay #1 on a public explorer',
  'explorer-memo': 'Pay #1: the LT1 memo receipt',
  'explorer-placeholder': 'Explorer scene placeholder (rehearsal only)',
  receipt: 'Stop & revoke: receipt with refund',
  dashboard: 'Owner dashboard from Solana history, fresh browser',
  closing: 'Why Solana, next steps, live URL and repository',
};
/** The closing card stretches (within closingMin..closingMax) to land the video near this length. */
const TARGET_SECONDS = 160;
const PAYMENTS_SHOWN = 6;

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

interface Options {
  mode: 'rehearsal' | 'final';
  sweepOnly: boolean;
  speed: number;
  skipBuild: boolean;
  port: number;
  fade: number;
  crf: number;
}

function parseArgs(argv: readonly string[]): Options {
  const known = ['--final', '--rehearsal', '--sweep-only', '--skip-build', '--speed', '--port', '--fade', '--crf'];
  for (const a of argv) if (a.startsWith('--') && !known.includes(a.split('=')[0])) throw new Error(`Unknown option ${a}`);
  const has = (f: string) => argv.includes(f);
  const value = (name: string): string | undefined => {
    const eq = argv.find((a) => a.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (name: string, fallback: number, ok: (n: number) => boolean): number => {
    const raw = value(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !ok(n)) throw new Error(`Invalid ${name} ${raw}`);
    return n;
  };
  if (has('--final') && has('--rehearsal')) throw new Error('Choose --final or --rehearsal, not both');
  const sweepOnly = has('--sweep-only');
  return {
    mode: has('--final') || sweepOnly ? 'final' : 'rehearsal',
    sweepOnly,
    speed: num('--speed', 60, (n) => n > 0),
    skipBuild: has('--skip-build'),
    port: num('--port', 4180, (n) => Number.isInteger(n) && n > 0 && n < 65536),
    fade: num('--fade', 0.3, (n) => n >= 0 && n <= 1),
    crf: num('--crf', 20, (n) => Number.isInteger(n) && n >= 14 && n <= 35),
  };
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const started = Date.now();
const log = (line: string): void => console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(6)} s] ${line}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Polls a DOM or chain condition (not a blind sleep). */
async function until(what: string, check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs / 1000} s waiting for ${what}`);
    await sleep(250);
  }
}

const caption = (page: Page, text: string): Promise<void> =>
  page.evaluate((t) => (window as unknown as { __caption?: (t: string) => void }).__caption?.(t), text);

/** Draws a red ring around `targets` for `ms`, so viewers find the link the caption talks about. */
async function highlight(page: Page, targets: Locator[], ms: number): Promise<void> {
  const present: Locator[] = [];
  for (const t of targets) if ((await t.count()) > 0) present.push(t);
  const ring = (on: boolean) =>
    Promise.all(
      present.map((t) =>
        t
          .evaluate(
            (el, on) => {
              const s = (el as HTMLElement).style;
              s.outline = on ? '3px solid #c1121c' : '';
              s.outlineOffset = on ? '4px' : '';
              s.borderRadius = on ? '3px' : '';
            },
            on,
            { timeout: 5_000 },
          )
          .catch(() => undefined), // cosmetic only
      ),
    );
  await ring(true);
  await page.waitForTimeout(ms);
  await ring(false);
}

/** A caption bar like the app's, for pages that are not ours (the explorer). */
async function overlayCaption(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    const bar = document.createElement('div');
    Object.assign(bar.style, {
      position: 'fixed',
      left: '0',
      right: '0',
      bottom: '0',
      zIndex: '2147483647',
      minHeight: '76px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '10px 28px',
      boxSizing: 'border-box',
      background: 'rgba(28, 33, 36, 0.96)',
      color: '#fff',
      font: '700 21px/1.3 system-ui, "DejaVu Sans", sans-serif',
      textAlign: 'center',
      borderTop: '3px solid #c1121c',
    });
    bar.textContent = t;
    document.body.appendChild(bar);
  }, text);
}

/** The end card: static markup over the dashboard page, in the app's own fonts and colours. */
const closingCardHtml = (live: string, repo: string): string => `
<div style="display:flex;align-items:center;gap:18px;font-weight:700;font-size:64px;letter-spacing:0.01em">
  <span style="display:inline-flex;gap:4px;padding:6px;background:var(--register,#0e0e10);border-radius:5px">
    <i style="width:14px;height:34px;border-radius:2px;background:#e9ebe6"></i><i style="width:14px;height:34px;border-radius:2px;background:#e9ebe6"></i><i style="width:14px;height:34px;border-radius:2px;background:var(--red,#c1121c)"></i>
  </span>Laden teilen
</div>
<p style="margin:0;font-size:26px;color:var(--on-housing-2,#b4bcc0)">Pay-as-you-charge for private wallboxes · EURC on Solana, settled every 0.1&nbsp;kWh</p>
<dl style="margin:8px 0 0;display:grid;grid-template-columns:auto auto;gap:14px 26px;align-items:baseline">
  <dt style="font-size:18px;letter-spacing:0.14em;text-transform:uppercase;color:var(--on-housing-2,#b4bcc0)">Try it</dt>
  <dd style="margin:0;font-family:var(--font-mono);font-size:28px;color:#fff">${live}</dd>
  <dt style="font-size:18px;letter-spacing:0.14em;text-transform:uppercase;color:var(--on-housing-2,#b4bcc0)">Code</dt>
  <dd style="margin:0;font-family:var(--font-mono);font-size:28px;color:#fff">${repo}</dd>
</dl>
<p style="margin:10px 0 0;font-family:var(--font-body);font-size:17px;color:var(--on-housing-2,#b4bcc0)">Devnet prototype with a simulated charger. No real energy is sold; test tokens have no value.</p>`;

async function showClosingCard(page: Page): Promise<void> {
  // No named helpers inside evaluate(): tsx/esbuild would wrap them in a __name() the page lacks.
  await page.evaluate((html) => {
    const card = document.createElement('div');
    card.dataset.testid = 'closing-card';
    // Below the MOCK banner (z-index 50) and the caption bar (60): a rehearsal stays marked as MOCK.
    card.style.cssText =
      'position:fixed;inset:0;z-index:45;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;' +
      'padding-bottom:var(--caption-h,76px);background:var(--housing,#373f43);color:var(--on-housing,#eef0ec);font-family:var(--font-din);' +
      'opacity:0;transition:opacity 700ms ease';
    card.innerHTML = html;
    document.body.appendChild(card);
    requestAnimationFrame(() => requestAnimationFrame(() => (card.style.opacity = '1')));
  }, closingCardHtml(APP_URL, REPO_URL));
}

// ---------------------------------------------------------------------------------------------
// Edit list: which part of which page's recording goes into the video
// ---------------------------------------------------------------------------------------------

/** A recorded page. Playwright stamps frames from the recorder's creation, i.e. from newPage(). */
interface Rec {
  name: string;
  page: Page;
  t0: number;
}
const at = (r: Rec): number => (Date.now() - r.t0) / 1000;

interface Cut {
  label: string;
  rec: Rec;
  start: number;
  end: number;
}

class EditList {
  readonly cuts: Cut[] = [];
  readonly marks: { name: string; cut: number; at: number }[] = [];
  private open: { label: string; rec: Rec; start: number } | null = null;
  private readonly fade: number;

  constructor(fade: number) {
    this.fade = fade;
  }

  /** Starts a cut in `rec`'s recording `delay` seconds from now (after a caption has rendered). */
  start(label: string, rec: Rec, delay = 0.25): void {
    this.stop();
    this.open = { label, rec, start: at(rec) + delay };
  }

  stop(): void {
    if (!this.open) return;
    this.cuts.push({ ...this.open, end: at(this.open.rec) });
    this.open = null;
  }

  /** A still for checking the video, `delay` seconds from now. */
  mark(name: string, delay = 1.5): void {
    if (!this.open) throw new Error(`mark(${name}) outside a cut`);
    this.marks.push({ name, cut: this.cuts.length, at: at(this.open.rec) + delay });
  }

  private offset(cut: number): number {
    let t = 0;
    for (let i = 0; i < cut; i++) t += this.cuts[i].end - this.cuts[i].start - this.fade;
    return t;
  }

  /** Length of the video so far, including the open cut (joins overlap by `fade`). */
  elapsed(): number {
    const n = this.cuts.length;
    if (this.open) return this.offset(n) + Math.max(0, at(this.open.rec) - this.open.start);
    return n === 0 ? 0 : this.offset(n) + this.fade;
  }

  /** Where each mark lands in the finished video. */
  stills(): { name: string; at: number }[] {
    return this.marks.map((m) => ({ name: m.name, at: this.offset(m.cut) + (m.at - this.cuts[m.cut].start) }));
  }
}

// ---------------------------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------------------------

function launchOptions(): LaunchOptions {
  const localShell = join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell');
  const executablePath = process.env.PW_CHROMIUM_PATH ?? (existsSync(localShell) ? localShell : undefined);
  const ld = process.env.PW_LD_LIBRARY_PATH;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  if (ld) env.LD_LIBRARY_PATH = ld;
  return { executablePath, args: ['--no-sandbox'], env };
}

function contextOptions(videoDir: string, extra: BrowserContextOptions = {}): BrowserContextOptions {
  return {
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'Europe/Berlin',
    recordVideo: { dir: videoDir, size: VIEWPORT },
    ...extra,
  };
}

function watchConsole(page: Page, name: string, logFile: string): void {
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') appendFileSync(logFile, `[${name}] ${m.type()}: ${m.text()}\n`);
  });
  page.on('pageerror', (e) => appendFileSync(logFile, `[${name}] pageerror: ${e.message}\n`));
}

// ---------------------------------------------------------------------------------------------
// The take
// ---------------------------------------------------------------------------------------------

interface TakeEnv {
  mode: Options['mode'];
  /** App base URL, e.g. https://alperderg229.github.io/laden-teilen/ */
  base: string;
  /** Global flags for the first load (they stay in the query string for hash navigation). */
  query: string;
  owner: Address;
  /** localStorage entries set before the app loads (set-if-absent): demo wallet, MOCK ledger. */
  seed: [string, string][];
  rawDir: string;
  fade: number;
  chainCaption: string;
}

interface ReceiptTx {
  label: string;
  sig: string;
}

interface Take {
  segments: Segment[];
  stills: { name: string; at: number }[];
  txs: ReceiptTx[];
  sid: string | null;
  explorer: { sig: string; url: string } | null;
  dashboardUrl: string;
}

const solanaFmTx = (sig: string): string => `https://solana.fm/tx/${sig}?cluster=devnet-solana`;

/**
 * Explorer tab (final only). explorer.solana.com, Solscan and Orb answer automated browsers with a
 * bot check; SolanaFM renders the same transaction, so the recording opens it there. Soft-fails: a
 * third-party site must never abort a funded take.
 */
async function explorerScene(page: Page, rec: Rec, sig: string, edit: EditList): Promise<boolean> {
  try {
    await page.goto(solanaFmTx(sig), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    // SolanaFM prints the memo in the program logs: Program logged: "Memo (len 49): "LT1|pay|…"".
    const memo = page.getByText(/LT1\|pay\|/).filter({ visible: true }).first();
    try {
      await memo.waitFor({ timeout: 40_000 });
    } catch {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 }); // freshly confirmed txs can lag the indexer
      await memo.waitFor({ timeout: 40_000 });
    }
    await overlayCaption(page, CAPTIONS.explorer);
    edit.start('explorer', rec);
    edit.mark('explorer-top', 1.2);
    await page.waitForTimeout(DWELL.explorerTop);
    await memo.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    edit.mark('explorer-memo', 1.8);
    await page.waitForTimeout(DWELL.explorerMemo);
    edit.stop();
    return true;
  } catch (e) {
    edit.stop();
    log(`! explorer scene skipped: ${(e as Error).message.split('\n')[0]}`);
    return false;
  }
}

async function recordTake(env: TakeEnv): Promise<Take> {
  const edit = new EditList(env.fade);
  const consoleLog = join(env.rawDir, 'console.log');
  const browser = await chromium.launch(launchOptions());
  const recs: Rec[] = [];
  const contexts: BrowserContext[] = [];
  const url = (hash: string) => `${env.base}?${env.query}#${hash}`;
  const origin = new URL(env.base).origin;
  const newRec = async (ctx: BrowserContext, name: string): Promise<Rec> => {
    const page = await ctx.newPage();
    const rec = { name, page, t0: Date.now() };
    page.setDefaultTimeout(60_000);
    watchConsole(page, name, consoleLog);
    recs.push(rec);
    return rec;
  };

  try {
    // ---- Main page: landing -> owner setup -> split-screen demo ---------------------------------
    const ctxMain = await browser.newContext(contextOptions(env.rawDir));
    contexts.push(ctxMain);
    const mainRec = await newRec(ctxMain, 'main');
    const main = mainRec.page;
    await main.addInitScript(
      ({ origin, seed }) => {
        if (location.origin !== origin) return;
        try {
          for (const [k, v] of seed) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
        } catch {
          // storage unavailable: the app then creates an empty demo wallet and the take fails loudly
        }
      },
      { origin, seed: env.seed },
    );

    // 1. Title card: the landing page.
    log('scene 1: title (landing)');
    await main.goto(url('/'), { waitUntil: 'load' });
    await main.getByTestId('cta-demo').waitFor();
    await main.waitForFunction(() => typeof (window as unknown as { __caption?: unknown }).__caption === 'function');
    await main.evaluate(async () => {
      await document.fonts.ready;
    });
    await caption(main, CAPTIONS.title);
    edit.start('main', mainRec);
    edit.mark('title', 2);
    await main.waitForTimeout(DWELL.title);

    // 2. Problem: scroll to the explainer.
    log('scene 2: problem');
    await caption(main, CAPTIONS.problem);
    await main.locator('section.problem').evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    edit.mark('problem', 3);
    await main.waitForTimeout(DWELL.problem);

    // 3. Owner setup: payout wallet + price, then open the split-screen demo.
    log('scene 3: owner setup');
    await main.evaluate(() => {
      window.location.hash = '#/owner?next=demo';
    });
    const address = main.getByTestId('owner-address');
    await address.waitFor();
    await caption(main, CAPTIONS.owner);
    await main.waitForTimeout(DWELL.ownerIntro);
    // Bring the whole form (payout wallet down to the buttons) above the caption bar.
    await main.locator('form.owner__form').evaluate((form) =>
      window.scrollTo({ top: form.getBoundingClientRect().top + window.scrollY - 56, behavior: 'smooth' }),
    );
    await main.waitForTimeout(900);
    await address.fill('');
    await main.waitForTimeout(700);
    await address.fill(env.owner); // pasted, like a wallet address
    await main.waitForTimeout(900);
    const price = main.getByTestId('owner-price');
    await price.fill('');
    await price.pressSequentially('0.39', { delay: 180 });
    edit.mark('owner', 1);
    await main.waitForTimeout(DWELL.ownerRead);
    await main.getByTestId('open-kiosk').click();
    await main.waitForURL(/#\/demo\?/);

    // 4. Guest starts with the demo wallet: cap 5 EURC, one approval.
    log('scene 4: guest starts');
    const kiosk = main.getByTestId('kiosk');
    const phone = main.getByTestId('phone');
    await kiosk.getByTestId('kiosk-qr').waitFor();
    await phone.getByTestId('demo-wallet').waitFor();
    await caption(main, CAPTIONS.guest);
    edit.mark('guest', 2.5);
    await main.waitForTimeout(DWELL.guestIntro);
    await phone.getByTestId('demo-wallet').click();
    await phone.getByTestId('wallet-card').waitFor();
    const funds = main.getByTestId('funds-panel');
    const start = phone.getByTestId('start-btn');
    await until('the demo wallet balances', async () => (await funds.count()) > 0 || (await start.isEnabled()), 90_000);
    if ((await funds.count()) > 0) throw new Error('The demo wallet has no funds: the app opened "Get test funds".');
    await phone.getByTestId('cap-select').selectOption('5');
    await main.waitForTimeout(DWELL.guestReady);
    await start.click();
    await kiosk.locator('[data-testid="kiosk-state"][data-state="CHARGING"]').waitFor({ timeout: 180_000 });
    await phone.getByTestId('allowance').waitFor({ timeout: 120_000 });
    await caption(main, CAPTIONS.guestStarted);
    edit.mark('started', 1.5);
    await highlight(main, [kiosk.locator('.inuse-plate [data-sig]').first(), phone.locator('.live__start [data-sig]').first()], DWELL.startLink);

    // 5. Charging: >= 6 payments, then one of them on an explorer.
    log('scene 5: charging');
    await caption(main, CAPTIONS.charging);
    const rows = kiosk.getByTestId('payment-row');
    await until('2 payments', async () => (await rows.count()) >= 2, 240_000);
    // The phone's own payment list (with explorer links) sits below its meter: scroll to it.
    await phone
      .locator('.live__list-title')
      .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }))
      .catch(() => undefined);
    await until('4 payments', async () => (await rows.count()) >= 4, 240_000);
    edit.mark('charging', 0.5);
    await caption(main, env.chainCaption);
    await until(`${PAYMENTS_SHOWN} payments`, async () => (await rows.count()) >= PAYMENTS_SHOWN, 240_000);
    edit.mark('payments', 1);
    await main.waitForTimeout(DWELL.afterPayments);

    let explorer: Take['explorer'] = null;
    if (env.mode === 'final') {
      const sig = await kiosk.locator('[data-testid="payment-row"][data-seq="1"] [data-sig]').first().getAttribute('data-sig');
      if (!sig) throw new Error('pay #1 has no signature on the display');
      log(`scene 5b: explorer (pay #1 on SolanaFM)`);
      edit.stop();
      const exRec = await newRec(ctxMain, 'explorer');
      const shown = await explorerScene(exRec.page, exRec, sig, edit);
      await exRec.page.close();
      await main.bringToFront();
      edit.start('main', mainRec);
      if (shown) explorer = { sig, url: solanaFmTx(sig) };
      else {
        await caption(main, CAPTIONS.explorerFallback);
        await main.waitForTimeout(DWELL.placeholder);
      }
    } else {
      log('scene 5b: explorer placeholder (rehearsal)');
      await caption(main, CAPTIONS.placeholder);
      edit.mark('explorer-placeholder', 1);
      await main.waitForTimeout(DWELL.placeholder);
    }

    // 6. Stop & revoke -> receipt.
    log('scene 6: stop and receipt');
    await caption(main, CAPTIONS.stop);
    await main.waitForTimeout(DWELL.stopIntro);
    await phone.getByTestId('stop-btn').click();
    await phone.getByTestId('receipt').waitFor({ timeout: 180_000 });
    await phone
      .locator('[data-testid="receipt-refund"][data-ok="true"]')
      .waitFor({ timeout: 90_000 })
      .catch(() => log('! the fee deposit refund did not show within 90 s'));
    await main.waitForTimeout(DWELL.receiptTop);
    // Then the two checks the caption talks about: allowance revoked, deposit refunded.
    await phone
      .getByTestId('receipt-refund')
      .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }))
      .catch(() => undefined);
    edit.mark('receipt', 1.5);
    await main.waitForTimeout(DWELL.receipt);
    const txs = await phone.locator('[data-testid="receipt"] details li').evaluateAll((items) =>
      items.map((li) => {
        const copy = li.cloneNode(true) as HTMLElement;
        copy.querySelectorAll('[data-sig]').forEach((n) => n.remove());
        return { label: (copy.textContent ?? '').replace(/\s+/g, ' ').trim(), sig: li.querySelector('[data-sig]')?.getAttribute('data-sig') ?? '' };
      }),
    );
    const meta = (await phone.locator('.receipt__meta').textContent()) ?? '';
    const sid = /session\s+(\S+)/.exec(meta)?.[1] ?? null;
    edit.stop();
    // MOCK mode: the ledger is the "chain", so the dashboard's fresh browser gets exactly that key.
    const ledger = env.mode === 'rehearsal' ? await main.evaluate((k) => localStorage.getItem(k), MOCK_LEDGER_STORAGE_KEY) : null;
    await ctxMain.close();

    // 7. Owner dashboard in a new browser context with empty storage.
    log('scene 7: owner dashboard (new context)');
    const storageState = ledger
      ? { cookies: [], origins: [{ origin, localStorage: [{ name: MOCK_LEDGER_STORAGE_KEY, value: ledger }] }] }
      : undefined;
    const ctxDash = await browser.newContext(contextOptions(env.rawDir, { storageState }));
    contexts.push(ctxDash);
    const dashRec = await newRec(ctxDash, 'dashboard');
    const dash = dashRec.page;
    const dashboardHash = `/owner/dashboard?o=${env.owner}`;
    await dash.goto(url(dashboardHash), { waitUntil: 'load' });
    await dash.getByTestId('dash-total').waitFor();
    await dash.waitForFunction(() => typeof (window as unknown as { __caption?: unknown }).__caption === 'function');
    await dash.evaluate(async () => {
      await document.fonts.ready;
    });
    await caption(dash, CAPTIONS.dashboard);
    edit.start('dashboard', dashRec);
    const row = dash.getByTestId('dash-session-row').first();
    await row.waitFor({ timeout: 180_000 });
    await row
      .getByText('✓ sample')
      .waitFor({ timeout: 60_000 })
      .catch(() => log('! the dashboard did not verify a sample payment within 60 s'));
    await dash.getByTestId('export-csv').hover();
    edit.mark('dashboard', 1);
    await dash.waitForTimeout(DWELL.dashboard);

    // 8. Why Solana + next, end card with the live URL and the repo.
    log('scene 8: closing card');
    await caption(dash, CAPTIONS.closing);
    await showClosingCard(dash);
    const closingMs = clamp((TARGET_SECONDS - edit.elapsed()) * 1000, DWELL.closingMin, DWELL.closingMax);
    edit.mark('closing', 2);
    await dash.waitForTimeout(closingMs);
    edit.stop();
    await ctxDash.close();

    const segments: Segment[] = [];
    for (const c of edit.cuts) {
      const video = c.rec.page.video();
      if (!video) throw new Error(`no recording for ${c.rec.name}`);
      segments.push({ label: c.label, file: await video.path(), start: c.start, end: c.end });
    }
    return { segments, stills: edit.stills(), txs, sid, explorer, dashboardUrl: url(dashboardHash) };
  } catch (e) {
    for (const r of recs) {
      if (!r.page.isClosed()) await r.page.screenshot({ path: join(env.rawDir, `failure-${r.name}.png`) }).catch(() => undefined);
    }
    throw e;
  } finally {
    for (const c of contexts) await c.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Rehearsal: local production build, MOCK ledger with a pre-funded demo wallet
// ---------------------------------------------------------------------------------------------

async function startPreview(port: number, skipBuild: boolean): Promise<{ base: string; stop: () => void }> {
  if (!skipBuild) {
    log('building (npm run build)');
    const b = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
    if (b.status !== 0) throw new Error('npm run build failed');
  } else if (!existsSync(join(ROOT, 'dist/index.html'))) {
    throw new Error('--skip-build needs an existing dist/ (run npm run build)');
  }
  const base = `http://127.0.0.1:${port}/laden-teilen/`;
  const child: ChildProcess = spawn(join(ROOT, 'node_modules/.bin/vite'), ['preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let exited = false;
  child.on('exit', () => (exited = true));
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (exited) throw new Error(`vite preview exited (is port ${port} free? use --port)`);
    try {
      if ((await fetch(base)).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`vite preview did not answer on ${base}`);
    await sleep(300);
  }
  log(`preview at ${base}`);
  return { base, stop: () => void child.kill('SIGTERM') };
}

/** A MOCK ledger in which the demo guest already holds what a final take funds (0.02 SOL + 3 EURC). */
async function mockLedgerFor(guest: Address): Promise<string> {
  const [ata] = await findAssociatedTokenPda({ owner: guest, mint: TOKEN.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const { state } = mintTestFunds(emptyLedger(), {
    sig: getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(64))),
    blockTime: Math.floor(Date.now() / 1000),
    owner: guest,
    ata,
    mint: TOKEN.mint,
    lamports: FUND_GUEST_LAMPORTS,
    tokenAmount: FUND_GUEST_MICRO,
  });
  return serializeLedger(state);
}

// ---------------------------------------------------------------------------------------------
// Final: docs/video.md
// ---------------------------------------------------------------------------------------------

function writeVideoDoc(p: {
  file: string;
  seconds: number;
  bytes: number;
  take: Take;
  guest: Address;
  owner: Address;
  fundSig: string;
  sweepSig: string | null;
}): void {
  const link = (sig: string) => `[${sig.slice(0, 20)}…](${explorerTx(sig)})`;
  const addr = (a: string) => `[\`${a}\`](${explorerAddress(a)})`;
  const scenes = p.take.stills.map((s) => `| ${formatClock(s.at)} | ${SCENE_NAMES[s.name] ?? s.name} |`).join('\n');
  const rows = p.take.txs.map((t) => `| ${t.label.replace(/\|/g, '\\|')} | ${t.sig ? link(t.sig) : '(none)'} |`).join('\n');
  const md = `# Demo video

[\`public/demo.mp4\`](../public/demo.mp4), served at ${APP_URL}demo.mp4:
${formatClock(p.seconds)} min, ${WIDTH}×${HEIGHT}, ${FPS} fps, H.264, ${(p.bytes / 1e6).toFixed(1)} MB.

Recorded ${new Date().toISOString().replace(/\.\d+Z$/, 'Z')} by \`npm run record -- --final\`
([\`scripts/record-demo.ts\`](../scripts/record-demo.ts)): headless Chromium drives the live site on Solana
devnet. The captions are the app's own caption bar (\`?captions=1\`). The only edits are cuts between the
recorded browser pages (main page, explorer tab, dashboard in a fresh browser context).

## Scenes

| Time | Scene |
|---|---|
${scenes}

## Transactions in the recording

Session \`${p.take.sid ?? '?'}\`, all on devnet (from the guest's receipt):

| Step | Transaction |
|---|---|
${rows}

${
  p.take.explorer
    ? `The explorer scene shows pay #1 on [SolanaFM](${p.take.explorer.url}); the app's own link for it is
${explorerTx(p.take.explorer.sig)}. explorer.solana.com answers automated browsers with a bot check, so the
recording uses SolanaFM for the same transaction.`
    : 'The explorer scene was skipped in this take (SolanaFM did not show the transaction in time).'
}

## Accounts

| Role | Address |
|---|---|
| Demo guest (fresh key for this take, swept back afterwards) | ${addr(p.guest)} |
| Owner payout wallet (the devnet dev treasury, default owner of \`/#/demo\`) | ${addr(p.owner)} |
| Owner dashboard | ${APP_URL}#/owner/dashboard?o=${p.owner} |

## Funding (not in the video)

| Step | Transaction |
|---|---|
| Fund the demo guest from the dev treasury (0.02 SOL + 3 EURC) | ${link(p.fundSig)} |
| Sweep the guest's leftovers back to the treasury | ${p.sweepSig ? link(p.sweepSig) : '(nothing left)'} |
`;
  writeFileSync(p.file, md);
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

function blocked(address: string, found: string): number {
  console.log(`
BLOCKED-ON-FUNDS: the devnet treasury ${address} needs at least 0.03 SOL and 3 EURC for a final take.
  found: ${found}
  A human tops it up (the faucets ask AI agents not to use them):
    SOL:  https://faucet.solana.com (Devnet)
    EURC: https://faucet.circle.com (EURC, Solana Devnet)
  Then run: npm run record -- --final
`);
  return 2;
}

async function sweep(client: ChainClient, treasury: KeyPairSigner): Promise<string | null> {
  const guest = await loadSavedGuest(GUEST_FILE);
  if (!guest) {
    log('nothing to sweep (no saved demo guest)');
    return null;
  }
  const sig = await sweepGuest(client, treasury, guest);
  log(sig ? `swept the demo guest ${guest.address} to the treasury: ${explorerTx(sig)}` : `demo guest ${guest.address} is already empty`);
  forgetGuest(GUEST_FILE);
  return sig;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  log(`mode: ${opts.mode.toUpperCase()}${opts.sweepOnly ? ' (sweep only)' : ''}`);

  // FINAL: check the money first, before building or launching anything.
  let client: ChainClient | null = null;
  let treasury: KeyPairSigner | null = null;
  if (opts.mode === 'final') {
    treasury = await loadTreasury(ROOT);
    if (!treasury) {
      console.log('BLOCKED-ON-FUNDS: no devnet treasury key (set DEV_TREASURY_SECRET or create .env.treasury: npm run e2e:devnet -- --init-treasury).');
      return 2;
    }
    client = createChainClient();
    if (opts.sweepOnly) {
      await sweep(client, treasury);
      return 0;
    }
    const t = await balances(client, treasury.address);
    log(`treasury ${treasury.address}: ${describeBalances(t, TOKEN.symbol)}`);
    if (!treasuryIsFunded(t)) return blocked(treasury.address, describeBalances(t, TOKEN.symbol));
    if (existsSync(GUEST_FILE)) {
      console.log(`${relative(ROOT, GUEST_FILE)} exists from an interrupted take. Run: npm run record -- --final --sweep-only`);
      return 1;
    }
    if (treasury.address !== DEMO_OWNER) log(`note: payments go to the demo owner ${DEMO_OWNER}, not to this treasury`);
    const live = await fetch(APP_URL).catch(() => null);
    if (!live?.ok) throw new Error(`The live site ${APP_URL} does not answer (${live?.status ?? 'network error'})`);
  }

  // Fail on a missing ffmpeg or browser now, not after the demo guest has been funded.
  const tools: Tools = findTools();
  await (await chromium.launch(launchOptions())).close();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rawDir = resolve(ROOT, 'video/raw', `${opts.mode}-${stamp}`);
  mkdirSync(rawDir, { recursive: true });

  const secret = crypto.getRandomValues(new Uint8Array(32));
  const guest = await createKeyPairSignerFromPrivateKeyBytes(secret);
  const walletKey = demoWalletKey(opts.mode === 'final' ? 'devnet' : 'mock');
  const seed: [string, string][] = [[walletKey, JSON.stringify([...secret])]];

  let base = APP_URL;
  let stopPreview = (): void => undefined;
  let fundSig = '';
  let sweepSig: string | null = null;
  const flags = new URLSearchParams({ captions: '1', speed: String(opts.speed) });

  let take: Take;
  try {
    if (opts.mode === 'final') {
      saveGuest(GUEST_FILE, guest.address, secret); // before any funds move
      process.once('SIGINT', () => {
        console.log('\nInterrupted. Return the demo guest funds with: npm run record -- --final --sweep-only');
        process.exit(130);
      });
      fundSig = await fundGuest(client!, treasury!, guest.address);
      log(`funded demo guest ${guest.address}: ${explorerTx(fundSig)}`);
      const g = await balances(client!, guest.address);
      if (g.lamports < FUND_GUEST_LAMPORTS || g.micro < FUND_GUEST_MICRO) throw new Error(`guest funding not visible yet: ${describeBalances(g, TOKEN.symbol)}`);
    } else {
      const preview = await startPreview(opts.port, opts.skipBuild);
      base = preview.base;
      stopPreview = preview.stop;
      flags.set('mock', '1');
      seed.push([MOCK_LEDGER_STORAGE_KEY, await mockLedgerFor(guest.address)]);
    }
    log(`recording to ${relative(ROOT, rawDir)}/ (demo guest ${guest.address}, owner ${DEMO_OWNER}, speed ${opts.speed} kWh/h)`);
    take = await recordTake({
      mode: opts.mode,
      base,
      query: flags.toString(),
      owner: DEMO_OWNER,
      seed,
      rawDir,
      fade: opts.fade,
      chainCaption: chainCaption(opts.speed),
    });
  } finally {
    stopPreview();
    if (opts.mode === 'final') {
      try {
        sweepSig = await sweep(client!, treasury!);
      } catch (e) {
        log(`! sweep failed (${(e as Error).message}); retry with: npm run record -- --final --sweep-only`);
      }
    }
  }

  // Edit: cut, join, check.
  const out = join(rawDir, opts.mode === 'final' ? 'demo.mp4' : 'demo-rehearsal.mp4');
  writeFileSync(join(rawDir, 'edit-list.json'), JSON.stringify({ segments: take.segments, stills: take.stills }, null, 2));
  log(`encoding ${take.segments.length} segments (${take.segments.map((s) => `${s.label} ${(s.end - s.start).toFixed(1)} s`).join(', ')})`);
  try {
    encode(tools, take.segments, out, { crf: opts.crf, fade: opts.fade });
  } catch (e) {
    if (opts.fade === 0) throw e;
    log(`! crossfade encode failed (${(e as Error).message.split('\n')[0]}); using hard cuts`);
    encode(tools, take.segments, out, { crf: opts.crf, fade: 0 });
  }
  let p = probe(tools, out);
  for (let crf = opts.crf + 3; p.bytes >= 48 * 1024 * 1024 && crf <= 35; crf += 3) {
    log(`${(p.bytes / 1e6).toFixed(1)} MB is too big; re-encoding with crf ${crf}`);
    encode(tools, take.segments, out, { crf, fade: opts.fade });
    p = probe(tools, out);
  }
  const shots = stills(tools, out, take.stills.map((s) => ({ ...s, at: Math.min(s.at, p.seconds - 0.2) })), join(rawDir, 'stills'));
  const problems = gate(p);
  log(`video: ${relative(ROOT, out)} · ${formatClock(p.seconds)} (${p.seconds.toFixed(1)} s) · ${p.width}x${p.height} ${p.codec} ${p.fps} fps · ${(p.bytes / 1e6).toFixed(1)} MB`);
  log(`stills: ${relative(ROOT, join(rawDir, 'stills'))}/ (${shots.length})`);
  for (const s of take.stills) log(`  ${formatClock(s.at)}  ${s.name}`);
  if (problems.length > 0) {
    log(`GATE FAILED: ${problems.join('; ')}`);
    if (opts.mode === 'final') log('public/demo.mp4 was NOT updated; the take stays in video/raw/.');
    return 1;
  }

  if (opts.mode === 'final') {
    const published = join(ROOT, 'public/demo.mp4');
    copyFileSync(out, published);
    writeVideoDoc({ file: join(ROOT, 'docs/video.md'), seconds: p.seconds, bytes: p.bytes, take, guest: guest.address, owner: DEMO_OWNER, fundSig, sweepSig });
    log(`published ${relative(ROOT, published)} and docs/video.md (commit both; Pages serves ${APP_URL}demo.mp4)`);
  } else {
    log('REHEARSAL (MOCK) video: for checking only. Never publish or commit it.');
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`\nrecord-demo failed: ${e instanceof Error ? e.message : String(e)}`);
    if (existsSync(GUEST_FILE)) console.error('A funded demo guest may be left over: npm run record -- --final --sweep-only');
    process.exit(1);
  },
);
