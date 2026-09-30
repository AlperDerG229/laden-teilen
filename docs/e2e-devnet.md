# Devnet end-to-end run

Output of `npm run e2e:devnet` (`scripts/e2e-session.ts`), recorded 2026-09-30T20:03:06.502Z.
Cluster: devnet. Token: EURC `HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr`. Memo program: `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`.
Stack: @solana/kit 8.3.0, @solana-program/token 0.17.0, memo 0.15.0, system 0.15.0.

## Accounts

| Role | Address |
|---|---|
| Guest wallet | [AguZi3Fc8ju6KVejRRqmDQxU6KANiFqbxkp4UdigyxEz](https://explorer.solana.com/address/AguZi3Fc8ju6KVejRRqmDQxU6KANiFqbxkp4UdigyxEz?cluster=devnet) |
| Guest token account | [3MZrqiiwgQeFJTP8pNnPE93hgjs2ietzGByjPYfZqGW5](https://explorer.solana.com/address/3MZrqiiwgQeFJTP8pNnPE93hgjs2ietzGByjPYfZqGW5?cluster=devnet) |
| Owner wallet | [7koZtiXdMJijpWhaJjaKjamrSny9GrKatNsyWtqo993p](https://explorer.solana.com/address/7koZtiXdMJijpWhaJjaKjamrSny9GrKatNsyWtqo993p?cluster=devnet) |
| Owner token account | [BcFEgX29Rn7gPvGb9cKmPjLQkC4G59QrEkhdFvzWyZHG](https://explorer.solana.com/address/BcFEgX29Rn7gPvGb9cKmPjLQkC4G59QrEkhdFvzWyZHG?cluster=devnet) |
| Session key (sid `2Yzg3xXx`) | [2Yzg3xXxuhtc7gtEuq5i1EAPDwsbYhnpgXgmjteYjdcu](https://explorer.solana.com/address/2Yzg3xXxuhtc7gtEuq5i1EAPDwsbYhnpgXgmjteYjdcu?cluster=devnet) |

## Transactions (all confirmed)

| Step | Signature |
|---|---|
| fund guest (treasury) | [4Xnv1PFKaymg3aDR...](https://explorer.solana.com/tx/4Xnv1PFKaymg3aDRt1UX3MxLWxfnGZvvkQbwzJ2YCq7H8o2sBfDc27E9eSMhF7STrTSiUJbCbREXYEditJcJF1Pg?cluster=devnet) |
| start (guest) | [3k6jYi67G4WC36mu...](https://explorer.solana.com/tx/3k6jYi67G4WC36mucunActqyWgxUTwRA1z4M8uupJ1AG8vFr3YqkjfPsAAGy8DpLxfZ8KvVAndx2ogbf1vW8YbaS?cluster=devnet) |
| pay #1 (0.039 EURC, 100 Wh) | [4yRY2L51zMNxRqv7...](https://explorer.solana.com/tx/4yRY2L51zMNxRqv7LRux5D4zpFGzXM3bWZKWViyWaf6mJyMxXDxN9d62rw9sYZQEqAdWsPEMc7eTVcFpmofvioae?cluster=devnet) |
| pay #2 (0.039 EURC, 200 Wh) | [3AcNikLGwtjF2GKo...](https://explorer.solana.com/tx/3AcNikLGwtjF2GKoREfZpab4vaFdFRDdYnvDDMAqe2zzAVHHfR665qbrMFpg3eP3QcgXb76N6VjdyhfT7KnbZwxv?cluster=devnet) |
| pay #3 (0.039 EURC, 300 Wh) | [4J2Jd7CSGpa3bFeM...](https://explorer.solana.com/tx/4J2Jd7CSGpa3bFeMKouPKABmdESaqGVQkuP9ecB57Gm1DhKXxyGcKBJGoHx6PXpdnxf4Fbsxm9G2G5LgyJMvxXhJ?cluster=devnet) |
| pay #4 (0.039 EURC, 400 Wh) | [4smMyffQ3JfgJ3CF...](https://explorer.solana.com/tx/4smMyffQ3JfgJ3CF9Pb6PcnNQdPJbW3TLQjcRYHGxcEAbixMA6zcRr83cbXsRoH1d3uEB1HYj67oyDccB2aLhoYs?cluster=devnet) |
| pay #5 (0.039 EURC, 500 Wh) | [2of3Zr619aUYk9FD...](https://explorer.solana.com/tx/2of3Zr619aUYk9FD5LKHdMsC4h127mEcVB8NH6G3RZ61Kr6smf8JnPZskeoQZWo1m5Atbk7EMxt7VjkzkPmYCxPk?cluster=devnet) |
| stop (guest revoke) | [2byM8q5ReRxF3mLo...](https://explorer.solana.com/tx/2byM8q5ReRxF3mLopTACxfTFW7WMpwJ3aGSmZUH69sDUJF9iwubP5AXiBMmQ5ZAxyAbJBcqDdxEaye7uWcgGzZ1K?cluster=devnet) |
| end (revoked, refund) | [22hBHNNZARv8mAXC...](https://explorer.solana.com/tx/22hBHNNZARv8mAXCjuSkHCoX4nXaTwzJ84EzoJ8tn6Vh42uoDwZTDbYgjY2V9QiwNUSk3fUAyLS8eHDacaz6mG2e?cluster=devnet) |
| reclaim owner | [4koEBwpfigSca6oX...](https://explorer.solana.com/tx/4koEBwpfigSca6oXBPm9TG25WoF7tYzZBUk74Jv2xK46E9wfkTmkEGrwGQc3ZLWkEwdQTpunSjM8K3rxFz4pCN2H?cluster=devnet) |
| reclaim guest | [2eyEbjJc5gfB6kjF...](https://explorer.solana.com/tx/2eyEbjJc5gfB6kjF2GaWGmhnK2bUJMBXRyJMxfbEDLupdGMchYZxwDe8LBQtGhtLYvhSUBFPyg6sh6xpc4vZuyS1?cluster=devnet) |

## Assertions

- PASS session ended by guest revoke: reason=revoked, endSig=22hBHNNZARv8mAXCjuSkHCoX4nXaTwzJ84EzoJ8tn6Vh42uoDwZTDbYgjY2V9QiwNUSk3fUAyLS8eHDacaz6mG2e
- PASS exactly 5 pulls: 5 payments
- PASS guest token account delegate == null: delegate=null, delegatedAmount=0
- PASS session key balance == 0: 0 lamports
- PASS owner received 5 × stepMicro: 195000 micro = 0.195 EURC (expected 195000)
- PASS pay memos via getSignaturesForAddress(ownerAta): seq 1,2,3,4,5 for sid 2Yzg3xXx
- PASS each pay tx moved exactly its memo amount: 39000, 39000, 39000, 39000, 39000
- PASS end memo on the guest wallet: LT1|end|2Yzg3xXx|500|195000|revoked

The ephemeral keys were discarded after the run and their leftovers were reclaimed to the dev
treasury; the closed accounts keep their full transaction history on the explorer.

## Console output

```text
Laden teilen - devnet end-to-end session (2026-09-30T20:02:19.387Z)
RPC https://api.devnet.solana.com · token EURC HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr · memo program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr

Kit smoke checks (no funds needed)
  rent-exempt minimum: 0 bytes = 650240 lamports, 165 bytes = 1488440 lamports (queried at runtime)
  EURC mint HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr: SPL Token, 6 decimals ✓
  jsonParsed memo read via Kit ([79] HELM_AUTH|v1|settle...): ✓; foreign memo decodes to null
  start   built + signed (3 ixs, 399 bytes, sig 5KsNcWLb...), simulated: runtime error "AccountNotFound" (expected: unfunded keys)
  pay #1  built + signed (3 ixs, 450 bytes, sig 5AMaRNac...), simulated: runtime error "AccountNotFound" (expected: unfunded keys)
  stop    built + signed (2 ixs, 258 bytes, sig 4ekq13GG...), simulated: runtime error "AccountNotFound" (expected: unfunded keys)
  end     built + signed (2 ixs, 288 bytes, sig 4rZBUS6T...), simulated: runtime error "AccountNotFound" (expected: unfunded keys)
  fee estimate via getFeeForMessage: end tx 5000 lamports (1 signer), reclaim tx 10000 lamports (2 signers) ✓
  sendIxs with an unfunded payer: ChainError(program) at preflight ✓ (Simulation failed: Attempt to debit an account but found no )
  start   simulated for real holder gnjANn6H... (sigVerify off): ok; post-state delegate = session key, delegatedAmount = 5000000 ✓
  stop    simulated for the same holder: ok; post-state delegate = none ✓

Treasury gnjANn6HJYbphXyT8fUkG4AUUNueykpzJ3VuWf1EMRD: 0.5 SOL, 20 EURC
Ephemeral keys (secrets saved to .env.e2e-keys.json, gitignored)
  guest   AguZi3Fc8ju6KVejRRqmDQxU6KANiFqbxkp4UdigyxEz   token account 3MZrqiiwgQeFJTP8pNnPE93hgjs2ietzGByjPYfZqGW5
  owner   7koZtiXdMJijpWhaJjaKjamrSny9GrKatNsyWtqo993p   token account BcFEgX29Rn7gPvGb9cKmPjLQkC4G59QrEkhdFvzWyZHG
  session 2Yzg3xXxuhtc7gtEuq5i1EAPDwsbYhnpgXgmjteYjdcu   sid 2Yzg3xXx
  price 0.39 EURC/kWh · step 100 Wh = 0.039 EURC · cap 5 EURC

Transactions
  ✓ fund guest (treasury)      https://explorer.solana.com/tx/4Xnv1PFKaymg3aDRt1UX3MxLWxfnGZvvkQbwzJ2YCq7H8o2sBfDc27E9eSMhF7STrTSiUJbCbREXYEditJcJF1Pg?cluster=devnet
  ✓ start (guest)              https://explorer.solana.com/tx/3k6jYi67G4WC36mucunActqyWgxUTwRA1z4M8uupJ1AG8vFr3YqkjfPsAAGy8DpLxfZ8KvVAndx2ogbf1vW8YbaS?cluster=devnet
  · kiosk found start tx: guest AguZi3Fc..., cap 5 EURC, deposit 0.005 SOL
  ✓ pay #1 (0.039 EURC, 100 Wh) https://explorer.solana.com/tx/4yRY2L51zMNxRqv7LRux5D4zpFGzXM3bWZKWViyWaf6mJyMxXDxN9d62rw9sYZQEqAdWsPEMc7eTVcFpmofvioae?cluster=devnet
  ✓ pay #2 (0.039 EURC, 200 Wh) https://explorer.solana.com/tx/3AcNikLGwtjF2GKoREfZpab4vaFdFRDdYnvDDMAqe2zzAVHHfR665qbrMFpg3eP3QcgXb76N6VjdyhfT7KnbZwxv?cluster=devnet
  ✓ pay #3 (0.039 EURC, 300 Wh) https://explorer.solana.com/tx/4J2Jd7CSGpa3bFeMKouPKABmdESaqGVQkuP9ecB57Gm1DhKXxyGcKBJGoHx6PXpdnxf4Fbsxm9G2G5LgyJMvxXhJ?cluster=devnet
  ✓ pay #4 (0.039 EURC, 400 Wh) https://explorer.solana.com/tx/4smMyffQ3JfgJ3CF9Pb6PcnNQdPJbW3TLQjcRYHGxcEAbixMA6zcRr83cbXsRoH1d3uEB1HYj67oyDccB2aLhoYs?cluster=devnet
  ✓ pay #5 (0.039 EURC, 500 Wh) https://explorer.solana.com/tx/2of3Zr619aUYk9FD5LKHdMsC4h127mEcVB8NH6G3RZ61Kr6smf8JnPZskeoQZWo1m5Atbk7EMxt7VjkzkPmYCxPk?cluster=devnet
  ✓ stop (guest revoke)        https://explorer.solana.com/tx/2byM8q5ReRxF3mLopTACxfTFW7WMpwJ3aGSmZUH69sDUJF9iwubP5AXiBMmQ5ZAxyAbJBcqDdxEaye7uWcgGzZ1K?cluster=devnet
  ✓ end (revoked, refund)      https://explorer.solana.com/tx/22hBHNNZARv8mAXCjuSkHCoX4nXaTwzJ84EzoJ8tn6Vh42uoDwZTDbYgjY2V9QiwNUSk3fUAyLS8eHDacaz6mG2e?cluster=devnet
  · session ended: reason=revoked, 5 payments, 500 Wh, 0.195 EURC, refund 0.00348156 SOL

Assertions
  PASS  session ended by guest revoke: reason=revoked, endSig=22hBHNNZARv8mAXCjuSkHCoX4nXaTwzJ84EzoJ8tn6Vh42uoDwZTDbYgjY2V9QiwNUSk3fUAyLS8eHDacaz6mG2e
  PASS  exactly 5 pulls: 5 payments
  PASS  guest token account delegate == null: delegate=null, delegatedAmount=0
  PASS  session key balance == 0: 0 lamports
  PASS  owner received 5 × stepMicro: 195000 micro = 0.195 EURC (expected 195000)
  PASS  pay memos via getSignaturesForAddress(ownerAta): seq 1,2,3,4,5 for sid 2Yzg3xXx
  PASS  each pay tx moved exactly its memo amount: 39000, 39000, 39000, 39000, 39000
  PASS  end memo on the guest wallet: LT1|end|2Yzg3xXx|500|195000|revoked
  info  guest SOL: 0.02 before start -> 0.01847156 after refund (net cost 0.00152844 SOL incl. owner token-account rent)

Reclaiming leftovers to the treasury
  ✓ reclaim owner              https://explorer.solana.com/tx/4koEBwpfigSca6oXBPm9TG25WoF7tYzZBUk74Jv2xK46E9wfkTmkEGrwGQc3ZLWkEwdQTpunSjM8K3rxFz4pCN2H?cluster=devnet
  ✓ reclaim guest              https://explorer.solana.com/tx/2eyEbjJc5gfB6kjF2GaWGmhnK2bUJMBXRyJMxfbEDLupdGMchYZxwDe8LBQtGhtLYvhSUBFPyg6sh6xpc4vZuyS1?cluster=devnet

Explorer links
  fund guest (treasury)      https://explorer.solana.com/tx/4Xnv1PFKaymg3aDRt1UX3MxLWxfnGZvvkQbwzJ2YCq7H8o2sBfDc27E9eSMhF7STrTSiUJbCbREXYEditJcJF1Pg?cluster=devnet
  start (guest)              https://explorer.solana.com/tx/3k6jYi67G4WC36mucunActqyWgxUTwRA1z4M8uupJ1AG8vFr3YqkjfPsAAGy8DpLxfZ8KvVAndx2ogbf1vW8YbaS?cluster=devnet
  pay #1 (0.039 EURC, 100 Wh) https://explorer.solana.com/tx/4yRY2L51zMNxRqv7LRux5D4zpFGzXM3bWZKWViyWaf6mJyMxXDxN9d62rw9sYZQEqAdWsPEMc7eTVcFpmofvioae?cluster=devnet
  pay #2 (0.039 EURC, 200 Wh) https://explorer.solana.com/tx/3AcNikLGwtjF2GKoREfZpab4vaFdFRDdYnvDDMAqe2zzAVHHfR665qbrMFpg3eP3QcgXb76N6VjdyhfT7KnbZwxv?cluster=devnet
  pay #3 (0.039 EURC, 300 Wh) https://explorer.solana.com/tx/4J2Jd7CSGpa3bFeMKouPKABmdESaqGVQkuP9ecB57Gm1DhKXxyGcKBJGoHx6PXpdnxf4Fbsxm9G2G5LgyJMvxXhJ?cluster=devnet
  pay #4 (0.039 EURC, 400 Wh) https://explorer.solana.com/tx/4smMyffQ3JfgJ3CF9Pb6PcnNQdPJbW3TLQjcRYHGxcEAbixMA6zcRr83cbXsRoH1d3uEB1HYj67oyDccB2aLhoYs?cluster=devnet
  pay #5 (0.039 EURC, 500 Wh) https://explorer.solana.com/tx/2of3Zr619aUYk9FD5LKHdMsC4h127mEcVB8NH6G3RZ61Kr6smf8JnPZskeoQZWo1m5Atbk7EMxt7VjkzkPmYCxPk?cluster=devnet
  stop (guest revoke)        https://explorer.solana.com/tx/2byM8q5ReRxF3mLopTACxfTFW7WMpwJ3aGSmZUH69sDUJF9iwubP5AXiBMmQ5ZAxyAbJBcqDdxEaye7uWcgGzZ1K?cluster=devnet
  end (revoked, refund)      https://explorer.solana.com/tx/22hBHNNZARv8mAXCjuSkHCoX4nXaTwzJ84EzoJ8tn6Vh42uoDwZTDbYgjY2V9QiwNUSk3fUAyLS8eHDacaz6mG2e?cluster=devnet
  reclaim owner              https://explorer.solana.com/tx/4koEBwpfigSca6oXBPm9TG25WoF7tYzZBUk74Jv2xK46E9wfkTmkEGrwGQc3ZLWkEwdQTpunSjM8K3rxFz4pCN2H?cluster=devnet
  reclaim guest              https://explorer.solana.com/tx/2eyEbjJc5gfB6kjF2GaWGmhnK2bUJMBXRyJMxfbEDLupdGMchYZxwDe8LBQtGhtLYvhSUBFPyg6sh6xpc4vZuyS1?cluster=devnet
  owner wallet               https://explorer.solana.com/address/7koZtiXdMJijpWhaJjaKjamrSny9GrKatNsyWtqo993p?cluster=devnet
  owner token account        https://explorer.solana.com/address/BcFEgX29Rn7gPvGb9cKmPjLQkC4G59QrEkhdFvzWyZHG?cluster=devnet

RESULT: PASS (11 confirmed transactions)
```
