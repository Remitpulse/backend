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
- Fictional football, basketball and tennis fixtures have server-quoted decimal odds. The sportsbook enforces the kickoff cutoff, reserves the stake and settles each eligible ticket once against a shared match result. Due tickets settle when the player refreshes the market or session.
- The shared ledger keeps simulated credits separate from withdrawable Testnet XLM. Public seed verification is outside this milestone.

## Stellar Testnet and passkeys

Set `CASINO_TESTNET_TREASURY_SECRET` to a funded Testnet-only Stellar account to enable native XLM deposits and withdrawals. Freighter signs deposits. The backend credits a verified transaction hash once. Withdrawals reserve Testnet funds and send them to the linked wallet. Retries use the same signed envelope. Unresolved transfers after expiry require operator reconciliation against the recorded transaction hash.

Set `CASINO_ADMIN_TOKEN` to enable the operator report. Set `CASINO_PUBLIC_ORIGIN` to the exact frontend origin for passkeys. Use HTTPS and `CASINO_SECURE_COOKIE=1` outside local development.

## Deploy both services

Place the frontend and backend checkouts side by side, with the frontend directory named `frontend`. From the backend checkout, run `docker compose up --build --wait`. The frontend binds to loopback on port 3000. The private backend stores the ledger on the `casino-ledger` volume.

On a remote host, forward HTTPS requests to `127.0.0.1:3000`. Set `CASINO_PUBLIC_ORIGIN` without a trailing slash and `CASINO_SECURE_COOKIE=1` in the backend checkout’s `.env`. Keep Testnet signing secrets outside Git. Back up the database using SQLite-aware tools. Real-money authorization and jurisdiction checks are outside this milestone.
