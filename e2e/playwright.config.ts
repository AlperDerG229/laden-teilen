// Playwright e2e in MOCK chain mode (no funds, no network): `npm run test:e2e`.
// Runs against the production build (vite preview), so it also proves MOCK mode needs ?mock=1.
//
// Browser: set PW_CHROMIUM_PATH to a Chromium / headless-shell binary, or let Playwright use its
// own (npx playwright install chromium). PW_LD_LIBRARY_PATH is passed to the browser process as
// LD_LIBRARY_PATH (for machines without the system libraries).
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const localShell = join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell');
const executablePath = process.env.PW_CHROMIUM_PATH ?? (existsSync(localShell) ? localShell : undefined);
const ldPath = process.env.PW_LD_LIBRARY_PATH;
const PORT = Number(process.env.PW_PORT ?? 4173);

export default defineConfig({
  testDir: '.',
  outputDir: '../test-results',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}/laden-teilen/`,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath,
      args: ['--no-sandbox'],
      env: ldPath ? { ...process.env, LD_LIBRARY_PATH: ldPath } : undefined,
    },
  },
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/laden-teilen/`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    cwd: '..',
  },
});
