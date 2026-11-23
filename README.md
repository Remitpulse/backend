# RemitPulse casino backend

Use Node.js 24, run `npm ci`, then `npm start`. The service listens on `127.0.0.1:4010` by default. Use the same checkout layout as the frontend. Copy `.env.example` to `.env` to configure your own environment.

- **Simulation.** Every demo player starts with 1,000 simulated XLM. Cryptographic server draws and exact integer journal entries run inside SQLite transactions. The database stores native and simulated claims in separate balances. Every XLM equals 10,000,000 stroops. Public seed verification is outside this milestone.
- **Testnet custody.** Set `CASINO_TESTNET_TREASURY_SECRET` to a funded, dedicated Stellar Testnet account. The browser signs a native deposit with Freighter. The backend credits the verified transaction hash once and binds the wallet address. Withdrawals reserve native Testnet balance first and send to the linked wallet. The same signed envelope is retried during reconciliation.
- **Operator.** Set a strong `CASINO_ADMIN_TOKEN` to enable the XLM report. Reserve counts and available Testnet balances are reported separately. A pending transfer that stays unresolved after expiry requires operator reconciliation using the recorded hash and the Testnet ledger. Keep the treasury exclusive to the service to avoid sequence conflicts.
- **Passkeys.** Set `CASINO_PUBLIC_ORIGIN` to the exact browser origin. Use HTTPS and `CASINO_SECURE_COOKIE=1` outside local development. The default origin is `http://localhost:3000`.
- **Deployment.** This milestone expects a single backend service and a persistent volume for `CASINO_DATA_DIR`. Back up the database with SQLite-aware tools and keep treasury secrets outside Git.

`npm test` exercises exact stroop arithmetic, server game settlement, and Mines round state. The self-attestation in Testnet is a demo control. Real-money authorization, identity and jurisdiction checks, independent fairness review, and production payment operations are outside this milestone.

The sportsbook simulates football, basketball and tennis on a rolling schedule. It validates the quoted odds and market cutoff, reserves demo stroops at placement, and settles each ticket against one persisted result per match. Settlement runs when the player refreshes the market or session. Fixtures and odds are fictional. The native Stellar Testnet wallet uses a separate balance.
