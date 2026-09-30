# Wallbox bridge (WP5): evcc and go-e instead of the simulator

`bridge/` is a small Node CLI that runs the same charger loop as the browser kiosk
(`ChargerSession` from `src/core`), but the energy comes from a real wallbox through
[evcc](https://evcc.io) (or a go-e charger) and the QR code is printed in the terminal.

> **Safety note.** The bridge is software only. It never touches wiring, contactors or the
> meter: it only switches the charge mode through the energy manager's or manufacturer's API
> (evcc loadpoint mode `now` / `off`, go-e `frc=2` / `frc=1`), exactly like the owner would in
> the evcc web UI or the go-e app. Installing or modifying a wallbox is work for a qualified
> electrician. This is a **devnet prototype**: evcc's `chargedEnergy` is not an eichrechtskonforme
> measurement, so no real energy may be sold with it (see spec §10). Production needs a MID meter
> plus signed meter values (OCMF), which the roadmap anchors in the pay memos.

## Quick start (no funds, no hardware)

```bash
docker run --rm -d --name evcc-demo -p 7070:7070 evcc/evcc --demo   # evcc 0.316.1 demo site
npm run bridge:smoke                                                # mock chain + live evcc, ~2 min
docker stop evcc-demo                                               # --rm removes the container
```

`bridge:smoke` runs the whole loop with an in-memory chain and a scripted guest who approves a
cap of three steps, against loadpoint 2 ("Garage", a connected "white Model 3") of the evcc demo:
QR, start tx, pay #1, evcc `mode/now`, pulls as `chargedEnergy` advances, cap reached, the paid
energy is delivered, evcc `mode/off`, end tx with refund. It then checks nine conditions and
prints `SMOKE: PASS` (transcript below).

With real devnet transactions and a person scanning the QR with Phantom (testnet mode):

```bash
npm run bridge -- --chain devnet --owner <payout wallet> --loadpoint 2 --name "Garage"
```

## How the bridge charges

```
 guest phone (/#/charge)                 bridge (Node, next to evcc)               evcc / go-e
 ───────────────────────                 ─────────────────────────────             ───────────
 scans terminal QR ─────── start tx ───▶ findStartTx(session key)
                                         pay #1 (pull as delegate) ──────────────▶ mode/now
                                         pay #2 (one step ahead)
                                         poll chargedEnergy every 2 s ◀────────── GET /api/state?jq=…
                                         metered ≥ paid − lead ⇒ next pull
 "Stop & revoke" / cap / funds ────────▶ allowance check fails ⇒ deliver paid rest
                                         ──────────────────────────────────────▶ mode/off
                                         end tx: memo with metered Wh + SOL refund
```

- **Reuse of the core.** `bridge/metered.ts` implements core's `ChargerPort.deliver()` on top of a
  charger that delivers energy continuously once switched on, and wraps `ChargerChain.end()` so
  the end tx is sent only after the charger is off. `src/core` is unchanged; the same
  `ChargerSession` drives the kiosk, the e2e script and the bridge.
- **Pull before deliver, one step ahead.** The first `deliver()` comes after pay #1 has confirmed,
  and only then is the charger switched on. After that, the bridge pulls the next step as soon as
  the metered energy comes within `--lead-wh` of the paid energy (default: one step, 100 Wh). evcc
  books energy in chunks (every ~9 s in demo mode, every control `interval` otherwise, 30 s by
  default), so a smaller lead would let unpaid energy flow between two meter updates. In the smoke
  run the paid energy stayed at least 79 Wh ahead of the meter.
- **Stopping delivers what was paid.** Like core's `ChargerSession.stop()` ("a step that is
  already paid is still delivered first"), the bridge first delivers the energy that is already
  paid for ("drain"), then switches off, when the session ends because of the guest's token account
  (cap, funds, revoke), the session key's SOL budget, or an operator stop. Charger-side stops (car
  unplugged or full, mode changed in the evcc UI, charger unreachable) and errors switch off at
  once, because the energy cannot be delivered anyway.
- **Guest exposure.** Right after a pull, paid − metered ≤ step + lead (2 steps = 0.078 EURC at
  0.39 EURC/kWh). A guest can only lose that prepaid rest when the car is unplugged or full, or on
  an error; `--lead-wh 50` halves it where the meter updates often enough (evcc demo).
- **End memo.** The end memo carries the **metered** energy in integer Wh (evcc's `chargedEnergy`
  delta after the meter settled), not the step count; pay memos keep `whCum` = paid energy.
- **Stop triggers.**

  | Trigger | Detected by | End reason | Paid rest delivered? |
  |---|---|---|---|
  | Guest "Stop & revoke" | allowance check before the next pull | `revoked` | yes |
  | Cap used up / token balance too low | allowance check | `cap` / `funds` | yes |
  | Session key's SOL budget too low | balance check | `sol` | yes |
  | Operator Ctrl+C, `--stop-after-wh` | bridge | `user` | yes (second Ctrl+C: no) |
  | Car unplugged (`connected: false` twice, or `chargedEnergy` drops) | charger poll | `full` | no |
  | No energy and not charging for `--idle-timeout` (car full) | charger poll | `full` | no |
  | Mode changed in the evcc UI (not `now` twice) | charger poll | `user` | no |
  | evcc unreachable 5× in a row, cannot switch on, program error | bridge | `error` | no |

- **Ctrl+C** stops gracefully: deliver the paid rest, charger off, end tx, refund. A second Ctrl+C
  switches off at once (the end tx still follows); a third one switches off and exits without the
  end tx (devnet: `--recover` later).
- **Crash safety (devnet).** The session key is written to `.env.bridge-session.json` (mode 0600,
  gitignored by `.env*`) until the end tx. `npm run bridge -- --chain devnet --recover` finds the
  start tx and payments on chain, then sends the end memo and refunds the deposit to the guest.
- **Owner of the loadpoint.** At startup the bridge switches the loadpoint off if it was on, so no
  one charges unpaid while it waits for a guest. After a session the loadpoint stays `off`.

## Verified live against evcc 0.316.1 (28 Sep 2026)

`docker run --rm -d --name evcc-demo -p 7070:7070 evcc/evcc --demo` (image digest
`sha256:114f3912…`, built 2026-09-27). Startup log: `evcc 0.316.1`, `switching into demo mode`,
`Authentication is locked in demo mode`. The demo site has **3** loadpoints (the spec expected 2):
`1 "Carport"` (mode `smart`, "blue e-Golf", charging), `2 "Garage"` (mode `off`, "white Model 3",
connected), `3 "Heat pump"` (mode `smart`). The bridge uses loadpoint 2 for the demo.

### State

```text
$ curl -si http://127.0.0.1:7070/api/state
HTTP/1.1 200 OK
Content-Type: application/json
{"apiReady":true,"aux":[],"battery":{…},…,"demoMode":true,…,"interval":3,…,"loadpoints":[…],…,"version":"0.316.1"}
```

The body is the state object itself (no `{"result": …}` wrapper as in old evcc versions) and is
93,614 bytes. Each loadpoint has ~100 keys; the bridge reads `title`, `mode`, `connected`,
`charging`, `chargePower` (W), `chargedEnergy` (Wh) and `vehicleTitle` (`sessionEnergy` mirrors
`chargedEnergy`). evcc's `jq` query parameter filters the state server side, so each poll is one
small request:

```text
$ curl -s -g 'http://127.0.0.1:7070/api/state?jq=.loadpoints[1]|{title,mode,connected,charging,chargePower,chargedEnergy,vehicleTitle}'
{"chargePower":0,"chargedEnergy":1329.814,"charging":false,"connected":true,"mode":"off","title":"Garage","vehicleTitle":"white Model 3"}
$ curl -s -g 'http://127.0.0.1:7070/api/state?jq=[.loadpoints[].title]'
["Carport","Garage","Heat pump"]
$ curl -si -g 'http://127.0.0.1:7070/api/state?jq=.loadpoints[7]'      -> 200 null
$ curl -si -g 'http://127.0.0.1:7070/api/state?jq=.loadpoints['        -> 400 {"error":"unexpected EOF"}
```

### Mode

```text
$ curl -si -X POST http://127.0.0.1:7070/api/loadpoints/2/mode/now
HTTP/1.1 200 OK
Content-Type: application/json
Content-Length: 6

"now"
$ curl -si -X POST http://127.0.0.1:7070/api/loadpoints/2/mode/off        -> 200 "off"
$ curl -si -X POST http://127.0.0.1:7070/api/loadpoints/2/mode/turbo      -> 400 {"error":"invalid value: turbo"}
$ curl -si -X POST http://127.0.0.1:7070/api/loadpoints/9/mode/now        -> 404 404 page not found
$ curl -si -X POST http://127.0.0.1:7070/api/loadpoints/0/mode/now        -> 404 (ids are 1-based: /loadpoints/2 = loadpoints[1])
$ curl -si        http://127.0.0.1:7070/api/loadpoints/2/mode/now         -> 404 (POST only)
$ curl -si -X POST http://127.0.0.1:7070/api/loadpoints/2/limitenergy/0   -> 200 0
$ curl -si        http://127.0.0.1:7070/api/auth/status                   -> 403 Forbidden in demo mode
```

### Does the demo accumulate energy? Yes, in Wh.

Loadpoint 2 after `POST mode/now` at 10:23:45 (polled every 3 s, unchanged lines omitted):

```text
10:23:45 {"mode":"now","connected":true,"charging":false,"enabled":true,"chargePower":0,"chargedEnergy":0,"chargeDuration":0}
10:23:48 {"mode":"now","connected":true,"charging":true,"enabled":true,"chargePower":11040,"chargedEnergy":0,"chargeDuration":0}
10:23:57 {"mode":"now","connected":true,"charging":true,"enabled":true,"chargePower":11040,"chargedEnergy":27.598,"chargeDuration":9}
10:24:07 {"mode":"now","connected":true,"charging":true,"enabled":true,"chargePower":11040,"chargedEnergy":55.197,"chargeDuration":18}
```

- **Unit: Wh.** 11,040 W × 9 s / 3600 = 27.60 Wh, observed 27.598 (loadpoint 1: 3,220 W × 9 s =
  8.05 Wh, observed 8.065). This matches `core/loadpoint.go` logging `chargedEnergy/1e3` as kWh.
- **Cadence.** `chargedEnergy` moves in ~27.6 Wh chunks every ~9 s at 11 kW (state `interval: 3`).
  After `mode/now`, power shows after ~3 s, `charging: true` after ~9 s, the first energy after ~18 s.
- **No reset on mode toggles.** `chargedEnergy` keeps counting within one plug-in session
  (145.271 → 170.02 after off → now), so the bridge meters against a baseline taken at start.
- **Trailing energy after `off`.** evcc books the last seconds after switching off (138.001 →
  145.271 in a manual probe, +0.3 to +5.7 Wh in the four smoke runs); `chargePower` drops to 0
  within ~4 s and `charging` turns false within ~10 s. The bridge waits for a stable reading
  before it sends the end tx.

### CORS

```text
$ curl -si -H 'Origin: https://lyvoralper.github.io' 'http://127.0.0.1:7070/api/state?jq=.version'
HTTP/1.1 200 OK
Access-Control-Allow-Origin: *
"0.316.1"
$ curl -si -X OPTIONS -H 'Origin: https://lyvoralper.github.io' -H 'Access-Control-Request-Method: POST' \
    http://127.0.0.1:7070/api/loadpoints/2/mode/off
HTTP/1.1 200 OK
Access-Control-Allow-Origin: *
```

evcc allows any origin (resolves the spec's open CORS point). The bridge is still a Node process:
the GitHub Pages site is https and evcc on the LAN is plain http (mixed content; Chrome's
private-network rules add more friction), and the charger loop must keep running with the session
key while no browser tab is open.

### Auth outside demo mode (correction to the spec)

Checked on a second, **non-demo** evcc 0.316.1 container (minimal `evcc.yaml` with a
`demo-charger` and one loadpoint, admin password set through the API):

```text
GET  /api/auth/status                  (no password yet)     -> 501 Not implemented
PUT  /api/auth/password {"current":"","new":"…"}             -> 201 (sets the session cookie)
no credentials:
GET  /api/state?jq=.loadpoints[0].mode                        -> 200 "off"
POST /api/loadpoints/1/mode/now                               -> 200 "now"
POST /api/loadpoints/1/mode/off                               -> 200 "off"
GET  /api/config/loadpoints                                   -> 401 Unauthorized
GET  /api/auth/apikey                                         -> 401 Unauthorized
with the session cookie:
POST /api/auth/apikey {"password":"…"}                        -> 200 {"key":"evcc_…"}   (35 characters)
with Authorization: Bearer evcc_…:
GET  /api/auth/status                                         -> 200 true
GET  /api/config/loadpoints                                   -> 200 [{"name":"lp-1","charger":"wallbox",…}]
GET  /api/auth/apikey                                         -> 200 {"configured":true}
with a wrong Bearer key:
GET  /api/config/loadpoints                                   -> 401 Unauthorized
POST /api/loadpoints/1/mode/now                               -> 200 "now"   (public route, header ignored)
```

So in evcc 0.316.1 the state and the loadpoint mode are **public** even with a password set, as
evcc's own `docs/agents/api-security.md` says ("Read-only state and basic charging controls are
intentionally unauthenticated"). The spec assumed the mode route needs a cookie or an `evcc_` API
key; only configuration and system routes do. The bridge sends `EVCC_API_KEY` as
`Authorization: Bearer …` when it is set (for a reverse proxy in front of evcc, or a later evcc that
protects these routes); evcc accepts any one valid credential and ignores the header on public
routes. `EvccPort` was run against this instance with a freshly generated key (read, `mode/now`,
`mode/off` all fine).

Side finding: the fixed-value `demo-charger` template keeps reporting 11 kW after `mode/off`
(its power and status are constants), so energy kept counting on that test instance. Real chargers
and the `--demo` site stop. The bridge warns if a charger still reports charging after it was
switched off.

## Running against a real evcc

1. Find the loadpoint id (1-based, same order as in the evcc UI):
   `curl -s -g 'http://evcc.local:7070/api/state?jq=[.loadpoints[].title]'`
2. Optional API key: evcc UI → Configuration → Security → API key (shown once), or
   `POST /api/auth/apikey {"password": …}` with a logged-in session. Pass it through the
   environment, not the command line: `export EVCC_API_KEY=evcc_…`.
3. Run the bridge on a machine in the same LAN (Raspberry Pi next to evcc works):

   ```bash
   EVCC_URL=http://evcc.local:7070 EVCC_LOADPOINT=1 \
     npm run bridge -- --chain devnet --owner <payout wallet> --price 0.39 --name "Carport"
   ```

4. **Lead vs. evcc interval.** Choose `--lead-wh` ≥ charge power × (evcc `interval` + ~5 s), so a
   meter update can never overtake the payments: at 11 kW with evcc's default 30 s interval that is
   ~110 Wh (`--lead-wh 150`), at 22 kW ~215 Wh (`--lead-wh 250`). The bridge polls every 2 s
   regardless; a shorter evcc `interval` (evcc warns below 30 s) makes the meter less coarse.
5. While the bridge runs it owns that loadpoint: it switches it `off` at startup and after each
   session. Switching the loadpoint to another mode in the evcc UI during a session ends it with
   reason `user`.

## go-e charger (HTTP API v2, untested)

Implemented from the vendor docs (`github.com/goecharger/go-eCharger-API-v2`, `http-en.md`,
`API_KEYS_FIRMWARE/apikeys-en.md`); **not tested on hardware**, only with mocked responses.

1. go-e app → enable **HTTP API v2** (local network), note the charger's IP.
2. `npm run bridge -- --charger goe --goe-url http://192.168.0.75 --chain devnet --owner <wallet>`

| Action | Request | Keys used |
|---|---|---|
| read | `GET /api/status?filter=wh,car,frc,alw,nrg,err` (firmware ≥ 051.4; the legacy `filter=["wh",…]` form is in `GoePort({ legacyFilter: true })`) | `wh` Wh since the car connected, `car` (1 idle, 2 charging, 3 wait car, 4 complete, 0/5 error), `frc` force state, `nrg[11]` total power W |
| on | `GET /api/set?frc=2` → `{"frc":true}` | force on |
| off | `GET /api/set?frc=1` → `{"frc":true}` | force off; the charger stays locked until the next paid session (set `frc=0` in the app to return to normal) |

`wh` resets when a car connects, so the port meters against a baseline, like with evcc.

## CLI reference

`npm run bridge -- --help` prints all options. The important ones:

| Option | Default | Meaning |
|---|---|---|
| `--charger evcc\|goe\|sim` | `evcc` | energy side (`sim` = in-process 11 kW simulator, `--sim-speed` time factor; keep one poll below one step, e.g. `--sim-speed 10 --poll-ms 500`) |
| `--evcc-url`, `--loadpoint` | `http://127.0.0.1:7070`, `1` | or `EVCC_URL`, `EVCC_LOADPOINT`; API key only via `EVCC_API_KEY` |
| `--chain mock\|devnet` | `mock` | in-memory chain + scripted guest, or real devnet transactions |
| `--guest human\|scripted` | `human` | devnet: a person scans the QR, or a guest funded from `.env.treasury` |
| `--owner` | | payout wallet (required for devnet with a human guest) |
| `--price`, `--cap`, `--name` | `0.39`, `5`, | values in the guest link (`/#/charge?k=&o=&p=&n=&cap=`) |
| `--step-wh`, `--lead-wh` | `100`, one step | payment step and pull lead |
| `--idle-timeout` | `120` s | end with `full` when the car stops taking energy |
| `--stop-after-wh` | | operator stop after N metered Wh (demos) |
| `--guest-cap`, `--guest-delay`, `--revoke-after` | | scripted guest: approved cap, seconds until its start tx, revoke after N payments |
| `--recover` | | devnet: end a session a crashed bridge left behind (refund) |

Scripts: `bridge`, `bridge:smoke`, `bridge:devnet` (scripted devnet guest from the dev treasury,
loadpoint 2, cap 1 EURC, revoke after 4 payments), `test:bridge` (also part of `npm test`),
`typecheck:bridge`. Command-line flags win over `EVCC_LOADPOINT`, and the last flag wins, so on a
real evcc use `npm run bridge:devnet -- --loadpoint 1` (the script itself passes `--loadpoint 2`).

## Tests

`npm run test:bridge` (also run by `npm test`): 33 tests.

- `bridge/ports/evcc.test.ts`: a fake evcc (mocked `fetch`) with the status codes and bodies
  observed above: jq read, baseline, counter reset = unplugged, fallback to the full state and the
  legacy `{result}` wrapper, 404 / 400 error bodies, Bearer header, network errors and timeouts.
- `bridge/ports/goe.test.ts`: filter URL, `frc` on/off, car states, `wh` reset, rejected `set`.
- `bridge/metered.test.ts`: the real `ChargerSession` + `MeteredCharger` + `SimPort` + mock chain
  on a fake clock: pay #1 before switch-on, metered ≤ paid while charging, drain on cap, revoke and
  operator stop (also when the stop arrives while pay #1 confirms), `skipDrain()`, immediate off on
  unplug, idle timeout, external mode change, charger unreachable, switch-on failure, no guest,
  lead 0, end-tx retry runs the shutdown once, and the warning for a charger that keeps charging
  after `off`.
- `bridge/qr.test.ts`: guest link format and terminal QR.

### `npm run bridge:smoke` against the live evcc demo

Final run on the committed code, 28 Sep 2026 (all four runs that day passed: 305.1, 308.6, 309.3
and 303.9 Wh metered). The QR code is drawn in the terminal above the `scan to charge` line; the
guest link opens the web app's guest page for this session key.

```text
$ npm run bridge:smoke
11:03:13  Laden teilen · wallbox bridge · chain mock · charger evcc
11:03:13  evcc 0.316.1 (demo mode) at http://127.0.0.1:7070 · evcc loadpoint 2 "Garage" · vehicle "white Model 3" · plugged in
11:03:13    mode=off connected=true charging=false chargedEnergy=1924.835 Wh
11:03:13  chain: MOCK (in-memory, no funds; signatures are labelled mock:) · owner 6y8FU65Y...
          [QR code drawn here]
11:03:13  scan to charge: https://lyvoralper.github.io/laden-teilen/#/charge?k=13fJwdfCSAJgkUvSvkCBqGXzQUGA5umdDUbBNSjrMmFU&o=6y8FU65YUVKbLnYtj1Qf8sp1drDh77wz7L99ikYB8SY3&p=0.39&n=Laden+teilen+wallbox&cap=5
11:03:13  price 0.39 EURC/kWh · step 100 Wh = 0.039 EURC · lead 100 Wh
11:03:13  waiting for the guest's start transaction (session 13fJwdfC)
11:03:17  mock guest scanned the QR and approved 0.117 EURC (start tx)
11:03:17  guest 55orrw61... approved 0.117 EURC, deposit 0.005 SOL   mock:start
11:03:18  pay #1   0.039 EURC   paid 100 Wh   mock:pay#1
11:03:18  evcc loadpoint 2 "Garage": switched ON (POST /api/loadpoints/2/mode/now)
11:03:18  meter 0.0 Wh >= paid 100 Wh - lead 100 Wh -> pull the next step
11:03:19  pay #2   0.039 EURC   paid 200 Wh   mock:pay#2
11:03:33  meter   27.6 Wh   11.0 kW   paid 200 Wh
11:03:43  meter   55.2 Wh   11.0 kW   paid 200 Wh
11:03:51  meter   82.8 Wh   11.0 kW   paid 200 Wh
11:04:01  meter  110.4 Wh   11.0 kW   paid 200 Wh
11:04:01  meter 110.4 Wh >= paid 200 Wh - lead 100 Wh -> pull the next step
11:04:02  pay #3   0.039 EURC   paid 300 Wh   mock:pay#3
11:04:10  meter  138.0 Wh   11.0 kW   paid 300 Wh
11:04:18  meter  165.6 Wh   11.0 kW   paid 300 Wh
11:04:28  meter  193.2 Wh   11.0 kW   paid 300 Wh
11:04:36  meter  220.8 Wh   11.0 kW   paid 300 Wh
11:04:36  meter 220.8 Wh >= paid 300 Wh - lead 100 Wh -> pull the next step
11:04:36  ending: cap (the guest's spending cap is used up)
11:04:36  delivering the energy already paid for: metered 220.8 of 300 Wh
11:04:46  meter  248.4 Wh   11.0 kW   paid 300 Wh
11:04:54  meter  276.0 Wh   11.0 kW   paid 300 Wh
11:05:03  meter  303.6 Wh   11.0 kW   paid 300 Wh
11:05:03  evcc loadpoint 2 "Garage": switched OFF (POST /api/loadpoints/2/mode/off)
11:05:05  meter  303.9 Wh   11.0 kW   paid 300 Wh
11:05:15  final meter reading: 303.9 Wh delivered, 300 Wh paid
11:05:15  session ended: cap (the guest's spending cap is used up) · 3 payments · 0.117 EURC · metered 303.9 Wh · refund 0.00349156 SOL   mock:end
11:05:16  Smoke checks
11:05:16    PASS  charger switched on after pay #1 and off at the end: on=true off=true
11:05:16    PASS  session ended by the cap: reason=cap
11:05:16    PASS  3 payments pulled: 3 payments
11:05:16    PASS  energy was metered: 303.9 Wh
11:05:16    PASS  pull before deliver: metered <= paid while charging: max(metered - paid) = -79.2 Wh
11:05:16    PASS  paid energy delivered before switching off: 303.9 of 300 Wh
11:05:16    PASS  end memo carries the metered Wh: whTotal=303
11:05:16    PASS  session key swept to 0 (deposit refunded): refund 0.00349156 SOL
11:05:16    PASS  evcc loadpoint back in mode off: mode=off
11:05:16  SMOKE: PASS
```

### Ctrl+C against the live evcc demo

`npm run bridge -- --loadpoint 2 --no-qr --name "Garage (evcc demo)"` (mock chain, the scripted
guest approves the default 5 EURC), then one Ctrl+C at 55 Wh: the two paid steps are delivered
before evcc is switched off (the 24 Wh above the paid 200 Wh are evcc's last 27.6 Wh chunk plus the
energy booked after `off`, in the guest's favour).

```text
10:59:02  Laden teilen · wallbox bridge · chain mock · charger evcc
10:59:02  evcc 0.316.1 (demo mode) at http://127.0.0.1:7070 · evcc loadpoint 2 "Garage" · vehicle "white Model 3" · plugged in
10:59:02    mode=off connected=true charging=false chargedEnergy=1391.444 Wh
10:59:02  chain: MOCK (in-memory, no funds; signatures are labelled mock:) · owner AiDKBZwM...
10:59:02  price 0.39 EURC/kWh · step 100 Wh = 0.039 EURC · lead 100 Wh
10:59:02  waiting for the guest's start transaction (session 6GwYTxRv)
10:59:06  mock guest scanned the QR and approved 5 EURC (start tx)
10:59:06  guest A9wdhDkH... approved 5 EURC, deposit 0.005 SOL   mock:start
10:59:07  pay #1   0.039 EURC   paid 100 Wh   mock:pay#1
10:59:07  evcc loadpoint 2 "Garage": switched ON (POST /api/loadpoints/2/mode/now)
10:59:07  meter 0.0 Wh >= paid 100 Wh - lead 100 Wh -> pull the next step
10:59:08  pay #2   0.039 EURC   paid 200 Wh   mock:pay#2
10:59:22  meter   27.6 Wh   11.0 kW   paid 200 Wh
10:59:30  meter   55.2 Wh   11.0 kW   paid 200 Wh
10:59:30  Ctrl+C: stopping. The energy already paid for is delivered, then the charger is switched off,
10:59:30          the end tx sent and the deposit refunded. Ctrl+C again: switch off now.
10:59:30  stop requested: user (operator pressed Ctrl+C)
10:59:30  ending: user (stopped by the operator)
10:59:30  delivering the energy already paid for: metered 55.2 of 200 Wh
10:59:40  meter   82.8 Wh   11.0 kW   paid 200 Wh
10:59:48  meter  110.4 Wh   11.0 kW   paid 200 Wh
10:59:58  meter  138.0 Wh   11.0 kW   paid 200 Wh
11:00:06  meter  165.6 Wh   11.0 kW   paid 200 Wh
11:00:16  meter  193.2 Wh   11.0 kW   paid 200 Wh
11:00:24  meter  220.8 Wh   11.0 kW   paid 200 Wh
11:00:24  evcc loadpoint 2 "Garage": switched OFF (POST /api/loadpoints/2/mode/off)
11:00:26  meter  224.1 Wh   0.0 kW   paid 200 Wh
11:00:35  final meter reading: 224.1 Wh delivered, 200 Wh paid
11:00:35  session ended: user (stopped by the operator) · 2 payments · 0.078 EURC · metered 224.1 Wh · refund 0.00349656 SOL   mock:end
```

## 15-second terminal clip for the video

Record `npm run bridge:smoke` in a terminal of at least 100 × 45 characters, ideally next to the
evcc web UI (http://127.0.0.1:7070, loadpoint "Garage" flips to "Now" and back to "Off"). The run
takes ~2 minutes in real time; for a 15-second clip keep these lines (verbatim from the final run above)
and fast-forward the meter phase about 10×:

| Clip time | What the viewer sees |
|---|---|
| 0–3 s | command, evcc header, the QR code |
| 3–6 s | guest approved, `pay #1`, evcc switched ON, `pay #2` (one step ahead) |
| 6–11 s | meter lines racing up in 27.6 Wh chunks, `pay #3` (fast-forward) |
| 11–15 s | `ending: cap`, paid rest delivered, evcc switched OFF, session ended with refund |

```text
$ npm run bridge:smoke
11:03:13  evcc 0.316.1 (demo mode) at http://127.0.0.1:7070 · evcc loadpoint 2 "Garage" · vehicle "white Model 3" · plugged in
          [QR code]
11:03:13  waiting for the guest's start transaction (session 13fJwdfC)
11:03:17  guest 55orrw61... approved 0.117 EURC, deposit 0.005 SOL   mock:start
11:03:18  pay #1   0.039 EURC   paid 100 Wh   mock:pay#1
11:03:18  evcc loadpoint 2 "Garage": switched ON (POST /api/loadpoints/2/mode/now)
11:03:19  pay #2   0.039 EURC   paid 200 Wh   mock:pay#2
11:03:33  meter   27.6 Wh   11.0 kW   paid 200 Wh
11:04:01  meter  110.4 Wh   11.0 kW   paid 200 Wh
11:04:02  pay #3   0.039 EURC   paid 300 Wh   mock:pay#3
11:04:36  ending: cap (the guest's spending cap is used up)
11:04:36  delivering the energy already paid for: metered 220.8 of 300 Wh
11:05:03  evcc loadpoint 2 "Garage": switched OFF (POST /api/loadpoints/2/mode/off)
11:05:15  session ended: cap (the guest's spending cap is used up) · 3 payments · 0.117 EURC · metered 303.9 Wh · refund 0.00349156 SOL   mock:end
```

Without Docker, the same flow runs in ~13 s against the simulator (checked 28 Sep 2026; it shows
`simulated 11.0 kW charger (x10 speed): switched ON` instead of the evcc lines, so use the evcc
recording for any claim about real hardware):
`npm run bridge -- --charger sim --sim-speed 10 --poll-ms 500 --guest-cap 0.117 --guest-delay 1`

Suggested caption: "Real energy manager, real meter: evcc switches the wallbox on only after the first EURC pull,
and off when the guest's cap is used up." Once the treasury is funded, the same clip from
`npm run bridge:devnet` shows explorer links instead of `mock:` labels.

## Real devnet session

<!-- devnet-run:start -->
Recorded 2026-09-30T20:06:56.182Z with `npm run bridge:devnet` (energy from evcc, chain: devnet).

| Step | Transaction |
|---|---|
| fund guest (treasury) | [7RTZtHzV1APBHe6T...](https://explorer.solana.com/tx/7RTZtHzV1APBHe6TyvstjV32cXoPhfkHUz166Yj8CZ6tk1TFEau58UtvG3c4hUdNCZHHmcFYDgNW1Qo9cAic4n5?cluster=devnet) |
| start (guest) | [5Z2M8is4RNvwGJnQ...](https://explorer.solana.com/tx/5Z2M8is4RNvwGJnQnB3p5xHaCEA9xuYMq6Y8EKuPt3mYQbC1t4SGzjtSFDaUFjSovVCgw5nPA1PpRumUDKdXCuEu?cluster=devnet) |
| pay #1 | [2mK3N8aqRGXeuzj1...](https://explorer.solana.com/tx/2mK3N8aqRGXeuzj1NS7SwdNAZLxWcGKRsnyMMyGciBkLGa6HNBcAE7rdYvr8DyZTQj31DPxrQYqcKdsXFo2W6gXD?cluster=devnet) |
| pay #2 | [2YWaPDwjNSgU3sc6...](https://explorer.solana.com/tx/2YWaPDwjNSgU3sc6ZRaLvP4TKksBudxaKq8nGMAvxNuLkN3GNU3oBPXYWeDATZfMow2A6ga2HJcLkPwYzaC5G5ri?cluster=devnet) |
| pay #3 | [3TtVtwJ9aDWprLL9...](https://explorer.solana.com/tx/3TtVtwJ9aDWprLL9TWJFN6Q6VqdL9kp3MGSPERHWweLPtt2tt12m84yfZwYJL66c7cL8QA9rF8wUoT36fgMyAkuA?cluster=devnet) |
| pay #4 | [3TqgvcD358kT1KK8...](https://explorer.solana.com/tx/3TqgvcD358kT1KK8zCB1EYn87H9t4CSv5idUTjUh2aNqHUk4id5PuEiuLCm4VACGZMVCBKtVQXAuYEiLa1tpS5nE?cluster=devnet) |
| stop (guest revoke) | [45LQDFadEjircfyW...](https://explorer.solana.com/tx/45LQDFadEjircfyWAgLYseDcaKsSgWWQfQy925qgkkYo1PyHns4hyV7QPg6B7TZUwfHP8yBKbvSvTyvdhv1fhGJu?cluster=devnet) |
| end (revoked, refund) | [KQBzwfvGicq7Hzc9...](https://explorer.solana.com/tx/KQBzwfvGicq7Hzc9aSJFCbsuFuVm7hmiS3KjU8ghRxJWTe5qLWrPaLhhJykjLP2yABsutrm67iZX7k1qaeo6iw8?cluster=devnet) |
| reclaim owner | [5PUb8eP2tcLJegAG...](https://explorer.solana.com/tx/5PUb8eP2tcLJegAGABGkQuS11uYoirD5eUT5D4ZZwRCP8AXoMwKaCsoqJwdXJHweCkEYJUJb3wWVoYK8kFHcGKzD?cluster=devnet) |
| reclaim guest | [2THnu8LQBKBGDmT8...](https://explorer.solana.com/tx/2THnu8LQBKBGDmT8htmXJYXbTRS1y1PTsBpfdvTRCj6s8aDmvE2RYTyUX2q65p3KNtAZN2iTsRbP6chn72B3VD2Y?cluster=devnet) |

```text
20:04:07  Laden teilen · wallbox bridge · chain devnet (scripted guest) · charger evcc
20:04:07  evcc 0.316.1 (demo mode) at http://127.0.0.1:7070 · evcc loadpoint 2 "Garage" · vehicle "white Model 3" · plugged in
20:04:07    mode=off connected=true charging=false chargedEnergy=0 Wh
20:04:07  treasury gnjANn6HJYbphXyT8fUkG4AUUNueykpzJ3VuWf1EMRD: 0.49994 SOL, 20 EURC
20:04:07  ephemeral keys saved to /home/alper_k/money-lab/2026-09-28/mvp/laden-teilen/.env.bridge-keys.json: guest 9X7qhZtvVJzfrwWwuKsJAxGnVKJHBFLnGhoARiE9oviP, owner 3JZi3ZPyJwJ8EdmKcTp4hjGQ1esJxXj14WfhQc1TwQH7, session F6nMbJdH8HHE4KamuSRGo2DUVUA3VzcM82dgFbQiVanu
20:04:09  funded the scripted guest with 0.02 SOL + 1 EURC   https://explorer.solana.com/tx/7RTZtHzV1APBHe6TyvstjV32cXoPhfkHUz166Yj8CZ6tk1TFEau58UtvG3c4hUdNCZHHmcFYDgNW1Qo9cAic4n5?cluster=devnet
20:04:09  scan to charge: https://lyvoralper.github.io/laden-teilen/#/charge?k=F6nMbJdH8HHE4KamuSRGo2DUVUA3VzcM82dgFbQiVanu&o=3JZi3ZPyJwJ8EdmKcTp4hjGQ1esJxXj14WfhQc1TwQH7&p=0.39&n=Laden+teilen+wallbox&cap=5
20:04:09  in Phantom:     https://phantom.app/ul/browse/https%3A%2F%2Flyvoralper.github.io%2Fladen-teilen%2F%23%2Fcharge%3Fk%3DF6nMbJdH8HHE4KamuSRGo2DUVUA3VzcM82dgFbQiVanu%26o%3D3JZi3ZPyJwJ8EdmKcTp4hjGQ1esJxXj14WfhQc1TwQH7%26p%3D0.39%26n%3DLaden%2Bteilen%2Bwallbox%26cap%3D5?ref=https%3A%2F%2Flyvoralper.github.io
20:04:09  price 0.39 EURC/kWh · step 100 Wh = 0.039 EURC · lead 100 Wh
20:04:09  waiting for the guest's start transaction (session F6nMbJdH)
20:04:13  scripted guest signed the start tx (cap 1 EURC)   https://explorer.solana.com/tx/5Z2M8is4RNvwGJnQnB3p5xHaCEA9xuYMq6Y8EKuPt3mYQbC1t4SGzjtSFDaUFjSovVCgw5nPA1PpRumUDKdXCuEu?cluster=devnet
20:04:14  guest 9X7qhZtv... approved 1 EURC, deposit 0.005 SOL   https://explorer.solana.com/tx/5Z2M8is4RNvwGJnQnB3p5xHaCEA9xuYMq6Y8EKuPt3mYQbC1t4SGzjtSFDaUFjSovVCgw5nPA1PpRumUDKdXCuEu?cluster=devnet
20:04:16  pay #1   0.039 EURC   paid 100 Wh   https://explorer.solana.com/tx/2mK3N8aqRGXeuzj1NS7SwdNAZLxWcGKRsnyMMyGciBkLGa6HNBcAE7rdYvr8DyZTQj31DPxrQYqcKdsXFo2W6gXD?cluster=devnet
20:04:16  evcc loadpoint 2 "Garage": switched ON (POST /api/loadpoints/2/mode/now)
20:04:16  meter 0.0 Wh >= paid 100 Wh - lead 100 Wh -> pull the next step
20:04:18  pay #2   0.039 EURC   paid 200 Wh   https://explorer.solana.com/tx/2YWaPDwjNSgU3sc6ZRaLvP4TKksBudxaKq8nGMAvxNuLkN3GNU3oBPXYWeDATZfMow2A6ga2HJcLkPwYzaC5G5ri?cluster=devnet
20:04:32  meter   27.6 Wh   11.0 kW   paid 200 Wh
20:04:42  meter   55.2 Wh   11.0 kW   paid 200 Wh
20:04:50  meter   82.8 Wh   11.0 kW   paid 200 Wh
20:05:00  meter  110.4 Wh   11.0 kW   paid 200 Wh
20:05:00  meter 110.4 Wh >= paid 200 Wh - lead 100 Wh -> pull the next step
20:05:02  pay #3   0.039 EURC   paid 300 Wh   https://explorer.solana.com/tx/3TtVtwJ9aDWprLL9TWJFN6Q6VqdL9kp3MGSPERHWweLPtt2tt12m84yfZwYJL66c7cL8QA9rF8wUoT36fgMyAkuA?cluster=devnet
20:05:08  meter  138.0 Wh   11.0 kW   paid 300 Wh
20:05:18  meter  165.6 Wh   11.0 kW   paid 300 Wh
20:05:26  meter  193.2 Wh   11.0 kW   paid 300 Wh
20:05:36  meter  220.8 Wh   11.0 kW   paid 300 Wh
20:05:36  meter 220.8 Wh >= paid 300 Wh - lead 100 Wh -> pull the next step
20:05:36  pay #4   0.039 EURC   paid 400 Wh   https://explorer.solana.com/tx/3TqgvcD358kT1KK8zCB1EYn87H9t4CSv5idUTjUh2aNqHUk4id5PuEiuLCm4VACGZMVCBKtVQXAuYEiLa1tpS5nE?cluster=devnet
20:05:38  scripted guest pressed "Stop & revoke"   https://explorer.solana.com/tx/45LQDFadEjircfyWAgLYseDcaKsSgWWQfQy925qgkkYo1PyHns4hyV7QPg6B7TZUwfHP8yBKbvSvTyvdhv1fhGJu?cluster=devnet
20:05:45  meter  248.4 Wh   11.0 kW   paid 400 Wh
20:05:53  meter  276.0 Wh   11.0 kW   paid 400 Wh
20:06:03  meter  303.6 Wh   11.0 kW   paid 400 Wh
20:06:03  meter 303.6 Wh >= paid 400 Wh - lead 100 Wh -> pull the next step
20:06:03  ending: revoked (the guest revoked the allowance)
20:06:03  delivering the energy already paid for: metered 303.6 of 400 Wh
20:06:11  meter  331.2 Wh   11.0 kW   paid 400 Wh
20:06:21  meter  358.8 Wh   11.0 kW   paid 400 Wh
20:06:29  meter  386.4 Wh   11.0 kW   paid 400 Wh
20:06:39  meter  414.0 Wh   11.0 kW   paid 400 Wh
20:06:39  evcc loadpoint 2 "Garage": switched OFF (POST /api/loadpoints/2/mode/off)
20:06:41  meter  419.5 Wh   0.0 kW   paid 400 Wh
20:06:49  final meter reading: 419.5 Wh delivered, 400 Wh paid
20:06:51  session ended: revoked (the guest revoked the allowance) · 4 payments · 0.156 EURC · metered 419.5 Wh · refund 0.00348656 SOL   https://explorer.solana.com/tx/KQBzwfvGicq7Hzc9aSJFCbsuFuVm7hmiS3KjU8ghRxJWTe5qLWrPaLhhJykjLP2yABsutrm67iZX7k1qaeo6iw8?cluster=devnet

20:06:51  Checks (via RPC)
20:06:51    PASS  charger switched on after pay #1 and off at the end: on=true off=true
20:06:51    PASS  session ended and refunded: reason=revoked
20:06:51    PASS  pull before deliver: metered <= paid while charging: max(metered - paid) = -79.2 Wh
20:06:51    PASS  session key balance == 0: 0 lamports
20:06:51    PASS  guest token account delegate == null: delegate=null
20:06:51    PASS  owner received 4 x 0.039 EURC: 0.156 EURC
20:06:52    PASS  end memo on the guest wallet carries the metered Wh: LT1|end|F6nMbJdH|419|156000|revoked

20:06:53  reclaim owner   https://explorer.solana.com/tx/5PUb8eP2tcLJegAGABGkQuS11uYoirD5eUT5D4ZZwRCP8AXoMwKaCsoqJwdXJHweCkEYJUJb3wWVoYK8kFHcGKzD?cluster=devnet
20:06:56  reclaim guest   https://explorer.solana.com/tx/2THnu8LQBKBGDmT8htmXJYXbTRS1y1PTsBpfdvTRCj6s8aDmvE2RYTyUX2q65p3KNtAZN2iTsRbP6chn72B3VD2Y?cluster=devnet

20:06:56  Explorer links
20:06:56    fund guest (treasury)    https://explorer.solana.com/tx/7RTZtHzV1APBHe6TyvstjV32cXoPhfkHUz166Yj8CZ6tk1TFEau58UtvG3c4hUdNCZHHmcFYDgNW1Qo9cAic4n5?cluster=devnet
20:06:56    start (guest)            https://explorer.solana.com/tx/5Z2M8is4RNvwGJnQnB3p5xHaCEA9xuYMq6Y8EKuPt3mYQbC1t4SGzjtSFDaUFjSovVCgw5nPA1PpRumUDKdXCuEu?cluster=devnet
20:06:56    pay #1                   https://explorer.solana.com/tx/2mK3N8aqRGXeuzj1NS7SwdNAZLxWcGKRsnyMMyGciBkLGa6HNBcAE7rdYvr8DyZTQj31DPxrQYqcKdsXFo2W6gXD?cluster=devnet
20:06:56    pay #2                   https://explorer.solana.com/tx/2YWaPDwjNSgU3sc6ZRaLvP4TKksBudxaKq8nGMAvxNuLkN3GNU3oBPXYWeDATZfMow2A6ga2HJcLkPwYzaC5G5ri?cluster=devnet
20:06:56    pay #3                   https://explorer.solana.com/tx/3TtVtwJ9aDWprLL9TWJFN6Q6VqdL9kp3MGSPERHWweLPtt2tt12m84yfZwYJL66c7cL8QA9rF8wUoT36fgMyAkuA?cluster=devnet
20:06:56    pay #4                   https://explorer.solana.com/tx/3TqgvcD358kT1KK8zCB1EYn87H9t4CSv5idUTjUh2aNqHUk4id5PuEiuLCm4VACGZMVCBKtVQXAuYEiLa1tpS5nE?cluster=devnet
20:06:56    stop (guest revoke)      https://explorer.solana.com/tx/45LQDFadEjircfyWAgLYseDcaKsSgWWQfQy925qgkkYo1PyHns4hyV7QPg6B7TZUwfHP8yBKbvSvTyvdhv1fhGJu?cluster=devnet
20:06:56    end (revoked, refund)    https://explorer.solana.com/tx/KQBzwfvGicq7Hzc9aSJFCbsuFuVm7hmiS3KjU8ghRxJWTe5qLWrPaLhhJykjLP2yABsutrm67iZX7k1qaeo6iw8?cluster=devnet
20:06:56    reclaim owner            https://explorer.solana.com/tx/5PUb8eP2tcLJegAGABGkQuS11uYoirD5eUT5D4ZZwRCP8AXoMwKaCsoqJwdXJHweCkEYJUJb3wWVoYK8kFHcGKzD?cluster=devnet
20:06:56    reclaim guest            https://explorer.solana.com/tx/2THnu8LQBKBGDmT8htmXJYXbTRS1y1PTsBpfdvTRCj6s8aDmvE2RYTyUX2q65p3KNtAZN2iTsRbP6chn72B3VD2Y?cluster=devnet
20:06:56    owner token account      https://explorer.solana.com/address/91dtXDTHmqhFess7tikWKKypdgaDEXkEDQCcUXvcE5sc?cluster=devnet
20:06:56  RESULT: PASS (10 confirmed transactions)
```
<!-- devnet-run:end -->

## Limitations

- evcc's `chargedEnergy` is an energy-manager value, not a calibrated, signed meter reading; see
  the safety note. Billing is per 100 Wh step, the memo records the metered total.
- Meter granularity: evcc books energy per control cycle (~9 s demo, 30 s default). Pulls are
  timed against that, hence the lead; the owner can lose the few Wh evcc books after `off`.
- One bridge process per loadpoint and one session at a time.
- go-e: untested on hardware. evcc: tested with the `--demo` site and a non-demo instance with a
  fixed-value demo charger, not with a physical wallbox.
- The demo cannot unplug a car through the API, so unplug handling is covered by unit tests only.
