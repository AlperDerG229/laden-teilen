# Submission draft: Superteam Germany "Road to Colosseum: Build your MVP"

> DRAFT. The funded devnet run (30.09.2026) and the final demo video are in. The only placeholders left are the
> Colosseum project link (Q9) and the handle (Q10), which Alper fills in himself. The live app and the repository are public.
> **HUMAN_ONLY:** Alper submits the form himself at https://earn.superteam.fun/listing/road-to-colosseum-hackathon-build-your-mvp
> Deadline: **Mon 05.10.2026, 23:59 CEST (21:59 UTC)**. Target submission: Sun 04.10.
> Prerequisite: Colosseum registration (country: Germany) + project page. The form's Q9 needs its link.

---

**Q1. Project name**
Laden teilen

**Q2. One-liner**
Turn the wallbox you already own into a pay-per-kWh charger: guests scan a QR, approve one EURC spending cap, and pay every 0.1 kWh on Solana. No sign-up, no merchant account, no backend.

**Q3. What problem are you solving, and who are you building for?**
Many EV drivers in German cities have no home charger (in German: "Laternenparker", street parkers). At the same time, hundreds of thousands of private wallboxes sit idle most of the day. Owners would share with neighbours, guests or Airbnb visitors, but getting paid fairly is the blocker. Today that means cash, chasing PayPal transfers, or a platform subscription that still doesn't process the payment.

I'm an apprentice electrician (Elektroniker für Energie- und Gebäudetechnik) near Stuttgart and install wallboxes for a living. Owners ask me exactly this question.

Laden teilen is for:
- **Owners**, who get paid automatically per kWh.
- **Guests**, who pay only for the energy actually delivered, with a hard cap, and can walk away at any time.

**Q4. Briefly explain the Solana integration in your working MVP.**
No custom program. Everything uses existing Solana programs:
- **One guest transaction starts a session.** It contains three instructions:
  1. `ApproveChecked` gives a fresh per-session charger key a spending cap on the guest's EURC account. It works like a card pre-authorisation, and the funds stay in the guest's wallet.
  2. A refundable 0.005 SOL fee deposit.
  3. A Memo that marks the session start.
- **Pull before deliver.** The charger key pulls 0.1 kWh worth of EURC (`TransferChecked` as delegate) *before* delivering each step. Every payment carries a memo receipt (`LT1|pay|session|seq|Wh|amount`).
- **Stopping.** The guest's Stop sends `Revoke`. The charger then ends the session with a memo and refunds the unused SOL deposit.
- **No backend or database.** Sub-cent fees make 0.1 kWh payment steps viable, and EURC settles instantly in euros. The owner dashboard is rebuilt purely from on-chain history.
- **Programs used:**
  - System `11111111111111111111111111111111`
  - SPL Token `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`
  - Associated Token `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`
  - Memo v2 `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`
- **Real hardware path.** An open-source bridge runs the same charger loop against evcc's REST API (the popular German open-source energy manager) instead of the browser simulator. Verified live against evcc 0.316.1; a run on a physical wallbox is next.

**Q5. Link to access and test the MVP**
https://lyvoralper.github.io/laden-teilen/#/demo
How to test in about 3 minutes: open `/#/demo` → "Demo wallet (devnet)" → "Get test funds" (faucet links for devnet SOL and EURC) → Start. Phantom works in testnet mode (README).

**Q6. 2–3 minute demo video**
https://lyvoralper.github.io/laden-teilen/demo.mp4 (2:24, recorded on the live site against real devnet; optional: upload as unlisted YouTube)

**Q7. Public GitHub repository**
https://github.com/LyvorAlper/laden-teilen

**Q8. Devnet or Mainnet? Program IDs, tx links, addresses**
Devnet.
- EURC (devnet) mint `HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr`.
- Example session:
  - start https://explorer.solana.com/tx/3k6jYi67G4WC36mucunActqyWgxUTwRA1z4M8uupJ1AG8vFr3YqkjfPsAAGy8DpLxfZ8KvVAndx2ogbf1vW8YbaS?cluster=devnet
  - pay #1 https://explorer.solana.com/tx/4yRY2L51zMNxRqv7LRux5D4zpFGzXM3bWZKWViyWaf6mJyMxXDxN9d62rw9sYZQEqAdWsPEMc7eTVcFpmofvioae?cluster=devnet, pay #2 https://explorer.solana.com/tx/3AcNikLGwtjF2GKoREfZpab4vaFdFRDdYnvDDMAqe2zzAVHHfR665qbrMFpg3eP3QcgXb76N6VjdyhfT7KnbZwxv?cluster=devnet
  - stop / revoke https://explorer.solana.com/tx/2byM8q5ReRxF3mLopTACxfTFW7WMpwJ3aGSmZUH69sDUJF9iwubP5AXiBMmQ5ZAxyAbJBcqDdxEaye7uWcgGzZ1K?cluster=devnet
  - end + refund https://explorer.solana.com/tx/22hBHNNZARv8mAXCjuSkHCoX4nXaTwzJ84EzoJ8tn6Vh42uoDwZTDbYgjY2V9QiwNUSk3fUAyLS8eHDacaz6mG2e?cluster=devnet
- Owner payout account https://explorer.solana.com/address/BcFEgX29Rn7gPvGb9cKmPjLQkC4G59QrEkhdFvzWyZHG?cluster=devnet (5 payments x 0.039 EURC = 0.195 EURC).
- Programs: see Q4.

**Q9. Colosseum project link**
‹https://arena.colosseum.org/projects/…› (Alper creates it after registering, country: Germany)

**Q10. Did you take part in the Ideathon?** (optional)
No, this project started during the MVP phase.

**Q11. Telegram username**
‹@…› (Alper)

---

## Colosseum project page (English)

**Name:** Laden teilen

**Tagline:** Pay-as-you-charge for the private wallbox you already own. EURC on Solana, settled every 0.1 kWh.

**Description:**
EV drivers without a driveway need charging. Private wallboxes are idle most of the day. Sharing them fails on payment: cash, PayPal chasing, or subscriptions.

Laden teilen makes the owner's existing wallbox a pay-per-kWh charger:
- The guest scans a QR and approves one EURC spending cap for a per-session charger key.
- The charger pulls a micro-payment before every 0.1 kWh it delivers, each with an on-chain memo receipt.
- The guest can stop and revoke at any time.

Everything runs on existing Solana programs (SPL Token delegate, Memo, System). There is no custom program, no backend and no custody.

Built by an apprentice electrician who installs wallboxes, with an evcc bridge for real hardware and an Eichrecht-first roadmap: signed meter readings (OCMF) anchored in the payment memo.

**Why Solana:**
- Sub-cent fees and fast finality make per-0.1 kWh settlement possible.
- EURC gives euro-native pricing for the German market.
- Wallet-standard onboarding needs no app install.

**Business model (roadmap):** a small per-kWh protocol fee on mainnet, plus a paid "Pro" tier for multi-unit buildings (owners' associations and apartment garages) with bookkeeping exports.

**Development history / disclosure:**
- Repository created 28 Sep 2026, during the contest period (started 14 Sep 2026). No prior code; built with Claude Code.
- Open-source dependencies are listed in `package.json`.
- Precedents named openly in the README: DeCharge (Solana DePIN charging, own hardware, US), Share&Charge (Ethereum, 2017), Stromnachbar (non-crypto, no payment processing).

**Legal note:** Devnet prototype with a simulated charger. No real energy is sold. Pricing is per kWh on purpose, because kWh is the unit German metering law expects. Production requires a metering chain that complies with German calibration law (Eichrecht).
