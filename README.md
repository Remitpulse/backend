# RemitPulse casino and sportsbook backend

This Node.js 24 service owns game outcomes, sports tickets, and an exact XLM ledger in SQLite. Every XLM equals 10,000,000 stroops.

## Start locally

```sh
npm ci
npm start
```

The default bind address is `127.0.0.1:4010`. Copy `.env.example` to `.env` for local overrides. Run `npm run typecheck` and `npm test` to verify the service.

## Games and sportsbook

- Each new demo account receives 1,000 simulated XLM. Wagers, payouts and balances use integer stroops. Server-side random draws determine casino outcomes.
- Mines stores the full board on the server, locks the selected mine count, and returns the current and next-safe-tile payout estimates. The board is revealed when the round ends.
- Casino results include the data needed for the interface to show the outcome, such as drawn cards, Keno numbers, or the Plinko path.
- The default sportsbook offers fictional football, basketball and tennis fixtures with server-quoted decimal odds. The sportsbook enforces the kickoff cutoff, reserves the stake and settles each eligible ticket once against a shared match result. Simulated fixture tickets settle when the player refreshes the market or session.
- The shared ledger keeps simulated credits separate from withdrawable Testnet XLM.

## Dice verification

The Dice client requests a SHA-256 commitment before generating its client
seed. The settlement consumes that commitment once, calculates the roll
using HMAC-SHA256 with rejection sampling, and records the revealed seed,
roll, target, stake, and payout in an Activity receipt. The contracts
checkout provides an independent receipt verifier.

## Football data

Set `CASINO_FOOTBALL_DATA_TOKEN` in the backend environment to use
[football-data.org](https://docs.football-data.org/general/v4/match.html)
for football fixtures and regulation-time results. The sportsbook still uses
simulated odds and simulated XLM. When the configured feed is unavailable,
new provider football tickets are paused. Existing tickets wait for a valid
result. Cancelled or awarded fixtures are voided and refunded. A provider
score revision is displayed separately from the original settlement.

## Stellar Testnet and passkeys

Set `CASINO_TESTNET_TREASURY_SECRET` to a funded Testnet-only Stellar account to enable native XLM deposits and withdrawals. Freighter signs deposits. The backend credits a verified transaction hash once. Withdrawals reserve Testnet funds and send them to the linked wallet. Retries use the same signed envelope. The player and operator can check the same transaction hash after an interruption. A failed withdrawal receipt returns its reserve, and a failed deposit closes without credit. An expired envelope with no Horizon receipt remains pending for operator investigation.

Set `CASINO_ADMIN_TOKEN` to enable the operator report. Set `CASINO_PUBLIC_ORIGIN` to the exact frontend origin for passkeys. Use HTTPS and `CASINO_SECURE_COOKIE=1` outside local development.

## Deploy both services

Place the frontend and backend checkouts side by side, with the frontend directory named `frontend`. From the backend checkout, run `docker compose up --build --wait`. The frontend binds to loopback on port 3000. The private backend stores the ledger on the `casino-ledger` volume.

On a remote host, forward HTTPS requests to `127.0.0.1:3000`. Set `CASINO_PUBLIC_ORIGIN` without a trailing slash and `CASINO_SECURE_COOKIE=1` in the backend checkout’s `.env`. Keep Testnet signing secrets outside Git. Back up the database using SQLite-aware tools. Real-money authorization and jurisdiction checks are outside this milestone.

See [Mainnet launch readiness](docs/mainnet-launch-readiness.md) for the current release decision and production verification requirements.

## Ledger recovery drill

Create a snapshot in a restricted directory on the backup volume. Give each
snapshot a new filename. The command uses SQLite's backup API, checks database
integrity, and refuses to replace an existing destination.

```sh
npm run ledger:backup -- /secure-backups/ledger-2026-11-23.sqlite
```

Restore to an isolated directory and pass the backup as the source.

```sh
mkdir -m 700 /secure-backups/restore-drill
npm run ledger:backup -- /secure-backups/restore-drill/ledger.sqlite /secure-backups/ledger-2026-11-23.sqlite
```

From the contracts checkout, compare the snapshot with the restored copy:

```sh
npm run treasury:audit -- /secure-backups/ledger-2026-11-23.sqlite /secure-backups/restore-drill/ledger.sqlite
```

The audit checks integrity, individual Testnet balances, and pending transfers.
Keep the restore drill disconnected from the treasury signer. Before replacing a live
database, stop the service, preserve its database and WAL files together, and
reconcile on-chain transfers since the snapshot.
