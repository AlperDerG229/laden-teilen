# Demo video

[`public/demo.mp4`](../public/demo.mp4), served at https://lyvoralper.github.io/laden-teilen/demo.mp4:
2:24.4 min, 1280×720, 30 fps, H.264, 10.9 MB.

Recorded 2026-09-30T20:11:56Z by `npm run record -- --final`
([`scripts/record-demo.ts`](../scripts/record-demo.ts)): headless Chromium drives the live site on Solana
devnet. The captions are the app's own caption bar (`?captions=1`). The only edits are cuts between the
recorded browser pages (main page, explorer tab, dashboard in a fresh browser context).

## Scenes

| Time | Scene |
|---|---|
| 0:01.7 | Title card (landing page) |
| 0:12.8 | The problem |
| 0:29.7 | Owner setup: payout wallet and price per kWh |
| 0:38.5 | Guest scans the QR code (demo wallet, cap 5 EURC) |
| 0:49.6 | One approval: the session starts (start tx link) |
| 1:09.9 | Charging: a payment before every 0.1 kWh |
| 1:22.4 | Six payments on the display and the phone |
| 1:25.0 | Pay #1 on a public explorer |
| 1:28.4 | Pay #1: the LT1 memo receipt |
| 1:46.9 | Stop & revoke: receipt with refund |
| 1:53.4 | Owner dashboard from Solana history, fresh browser |
| 2:04.4 | Why Solana, next steps, live URL and repository |

## Transactions in the recording

Session `Ge1dHdEy`, all on devnet (from the guest's receipt):

| Step | Transaction |
|---|---|
| Start (cap + deposit) | [29MntCEJzoTQANsTrzJM…](https://explorer.solana.com/tx/29MntCEJzoTQANsTrzJMV3aAuc6QyKDVAQGG66EVs1EYkkmqVni9u7RSi51TTfLeaiKk3FHZ8MMUw9M1EREANLyz?cluster=devnet) |
| Pay #1: 0.039 EURC for 0.1 kWh | [5siaQk5ytLkhZeBM2vuH…](https://explorer.solana.com/tx/5siaQk5ytLkhZeBM2vuHgvoZLqj75Pw35rC4XStT7SC8oGcSVNACBrpj8sKg6fRHwaMRUiW5imzNn4v4rMecc8bQ?cluster=devnet) |
| Pay #2: 0.039 EURC for 0.2 kWh | [5eAkTcCwTahKaPKb5KHX…](https://explorer.solana.com/tx/5eAkTcCwTahKaPKb5KHXmrtwotYN6WKT8ESymQpEYA18FHtDMVb2MA6QXt8MrWxFPyHrj7b17dzpbTySmpCyWuv9?cluster=devnet) |
| Pay #3: 0.039 EURC for 0.3 kWh | [36y2SdW19JqwQyNHU72D…](https://explorer.solana.com/tx/36y2SdW19JqwQyNHU72DEyxQ5StEN68Fd6CoYQ6FxL9cBp1t14v84iqbrC8oxGojads97HzvjDQT1y7iBVMWvew8?cluster=devnet) |
| Pay #4: 0.039 EURC for 0.4 kWh | [482AYK1Dm9EpwK5BXV18…](https://explorer.solana.com/tx/482AYK1Dm9EpwK5BXV18ENtiMD3XQAFCGTosjqUrnfBTPPjNr1rjap2CqzFmo1d4Jtr4myPEFJ8ZfTqyJo8CCPAa?cluster=devnet) |
| Pay #5: 0.039 EURC for 0.5 kWh | [4KgHxTkTg87ZQxsPya9r…](https://explorer.solana.com/tx/4KgHxTkTg87ZQxsPya9rLgdPhsCHcXp9VnGMkTVmYh8ap19FVNh8oxiveTqbJbnhqKdtvPkAjCCJg8V1RJCQrstz?cluster=devnet) |
| Pay #6: 0.039 EURC for 0.6 kWh | [4fB3zEoPsdBT7pYdVfXX…](https://explorer.solana.com/tx/4fB3zEoPsdBT7pYdVfXXvXid3kFi7foPJgJwXPAoRN44u4UugnTE7ErDHQ2qP2o5YRrTM3zxqh8gH523pRHZSvPs?cluster=devnet) |
| Pay #7: 0.039 EURC for 0.7 kWh | [5DxcBmD7ub8VT15o6oTj…](https://explorer.solana.com/tx/5DxcBmD7ub8VT15o6oTj6Em8mfEfWhoGoP3B6WJiyxJoo89q2Pup5uQAeAzd8qTfKD8punE8f2bq8k7QubHfbJii?cluster=devnet) |
| Pay #8: 0.039 EURC for 0.8 kWh | [2RPzYe3HSn1QSgnk8j9w…](https://explorer.solana.com/tx/2RPzYe3HSn1QSgnk8j9w1ViB5oyDKsfjpdaN7E8UgvdKdNxX4rrzmh1vFj5WGG1UK3PXsW5GNDNWTNrJjwyHnocW?cluster=devnet) |
| Pay #9: 0.039 EURC for 0.9 kWh | [5BcXcLGL1HDFrxLBS5qe…](https://explorer.solana.com/tx/5BcXcLGL1HDFrxLBS5qed5yCMeM3B2n1w22iFjw2CSQhwY7MbnL71r5YZnST2FxqPjwqutj8rWQX7KqrKe9CoXCo?cluster=devnet) |
| Pay #10: 0.039 EURC for 1.0 kWh | [4qHQ8TVFFRBD4kSpjQSH…](https://explorer.solana.com/tx/4qHQ8TVFFRBD4kSpjQSHhyUBVq5yF33CLkGDzH3ynpu6XsLdcvoEBnowfpUtNhtMqdz2XiWUUbdyDMMq1gq42Wbn?cluster=devnet) |
| Stop & revoke | [2Lnc6oJjKBoyhBHGVXPQ…](https://explorer.solana.com/tx/2Lnc6oJjKBoyhBHGVXPQxihdydAUuXRntBL9QPtiNVniVycd6jLSyVDicmrepJR1aKxPjzp4N5GJibb2PcAsoDCg?cluster=devnet) |
| End & refund | [2Kf4JtBC5sB8GSBgbNi6…](https://explorer.solana.com/tx/2Kf4JtBC5sB8GSBgbNi6CQdWNc9oNmefU8HPHTi8nzzRgDdHvvAE1NYfXSUviXv9H9uXR3WLuEVqrj8YXAakZkLU?cluster=devnet) |

The explorer scene shows pay #1 on [SolanaFM](https://solana.fm/tx/5siaQk5ytLkhZeBM2vuHgvoZLqj75Pw35rC4XStT7SC8oGcSVNACBrpj8sKg6fRHwaMRUiW5imzNn4v4rMecc8bQ?cluster=devnet-solana); the app's own link for it is
https://explorer.solana.com/tx/5siaQk5ytLkhZeBM2vuHgvoZLqj75Pw35rC4XStT7SC8oGcSVNACBrpj8sKg6fRHwaMRUiW5imzNn4v4rMecc8bQ?cluster=devnet. explorer.solana.com answers automated browsers with a bot check, so the
recording uses SolanaFM for the same transaction.

## Accounts

| Role | Address |
|---|---|
| Demo guest (fresh key for this take, swept back afterwards) | [`6kBSNw6xGQWAgXuwwNyKHrWQ2wjVavuqviwTppKYnQ8T`](https://explorer.solana.com/address/6kBSNw6xGQWAgXuwwNyKHrWQ2wjVavuqviwTppKYnQ8T?cluster=devnet) |
| Owner payout wallet (the devnet dev treasury, default owner of `/#/demo`) | [`gnjANn6HJYbphXyT8fUkG4AUUNueykpzJ3VuWf1EMRD`](https://explorer.solana.com/address/gnjANn6HJYbphXyT8fUkG4AUUNueykpzJ3VuWf1EMRD?cluster=devnet) |
| Owner dashboard | https://lyvoralper.github.io/laden-teilen/#/owner/dashboard?o=gnjANn6HJYbphXyT8fUkG4AUUNueykpzJ3VuWf1EMRD |

## Funding (not in the video)

| Step | Transaction |
|---|---|
| Fund the demo guest from the dev treasury (0.02 SOL + 3 EURC) | [3Vmb4HCQkbksceriwEaS…](https://explorer.solana.com/tx/3Vmb4HCQkbksceriwEaSJNRmXvXTeHePJ4JM45A68t7bdKtzx7h3zt7DQzPyehzzo293Z4GQvURipcDrCoXpS5XJ?cluster=devnet) |
| Sweep the guest's leftovers back to the treasury | [5pN9baGBgzZuszKBPVF7…](https://explorer.solana.com/tx/5pN9baGBgzZuszKBPVF7i6zCqmseNeNvFMKc2dztnXrLSQY65sXcWe46FhJizyUWa1VwVqUAjhsMq8nDJ1uLBNLE?cluster=devnet) |
