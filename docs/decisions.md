# Decisions

## WP1-1: Keep @solana/kit (no fallback to web3.js v1)

Date: 2026-09-28. Status: accepted.

The spec allowed 90 minutes for a Kit spike before switching the whole project to
`@solana/web3.js` 1.99 + `@solana/spl-token` 0.4. The Kit path worked end to end within about
20 minutes, so the project stays on Kit.

Evidence (`npm run e2e:devnet -- --smoke`, no funds needed):

- Reads through Kit and the throttled transport: rent (`getMinimumBalanceForRentExemption`, queried
  at runtime: 0 bytes = 650,240 and 165 bytes = 1,488,440 lamports on devnet), the EURC mint via
  `fetchMint` (SPL Token, 6 decimals), and `getTransaction` with `jsonParsed` memo instructions.
- All four session transactions (start, pay with owner-ATA creation, stop, end) build, sign and
  serialize. Devnet `simulateTransaction` accepts every wire format.
- Semantic check against the real programs: the start tx simulated for a real funded EURC holder
  (`sigVerify: false`) leaves the holder's token account with delegate = session key and
  delegatedAmount = cap. The stop tx leaves delegate = none. Memo v2 (`MemoSq4g...`) logs the LT1 memo.
- The same core bundles for the browser with Vite 8 (no Node built-ins).

The funded devnet run (`npm run e2e:devnet`) is the final proof. Its output goes to
`docs/e2e-devnet.md`.

## WP1-2: Toolchain pins that differ from "latest"

- `vitest` 4.1.11: vitest 5 requires Node >= 22.12, and the build machine runs Node 20.20.1.
- `typescript` 6.0.3: `typescript-eslint` 8.70 supports TypeScript < 6.1 (the latest is 7.0).
- ESLint 10 flat config, following the spec. The current create-vite template ships oxlint instead.

## WP1-3: Core behaviour choices

- **Confirmation without WebSocket.** `sendIxs` polls `getSignatureStatuses` and re-broadcasts the
  same signed bytes until the tx is confirmed or its blockhash expires. Only after expiry does it
  throw `ChainError('expired')`, so rebuilding and retrying a pull can never double-charge.
  `WS_URL` stays in config for an optional later optimisation.
- **Read-your-writes.** The public RPC is load balanced, so reads that must reflect our own txs
  (balances, token accounts) pass `minContextSlot` = the slot of our last confirmed tx.
- **Start validation.** `findStartTx` validates structure: ApproveChecked delegate = session key,
  mint = EURC, the start memo sid, and the deposit from the guest. `ChargerSession` validates the
  economics: cap >= one step, deposit >= 0.003 SOL, and the memo price equals the wallbox price.
  A bad start is not ignored. The session ends at once with reason `error`, which refunds the
  deposit.
- **End reasons.** Adds `error` to the spec's `user | revoked | cap | funds | full | sol` for
  program or charger failures. The token program clears a delegate whose allowance reaches
  exactly 0, so the session labels that case `cap`, not `revoked`.
- **SOL budget.** Before a pull the session key needs (balance - rent-exempt reserve) >= 20,000
  lamports, plus the token-account rent before pay #1 (owner ATA creation). This keeps the key
  rent-exempt until the final sweep to exactly 0.
