# RemitPulse Mainnet launch readiness

**Release decision:** Keep the existing preview on Stellar Testnet. The repository review found a working separation between simulated wagers and Testnet transfers, but no verified real-money authorization or production settlement path. A network switch alone cannot launch this product.

| Area | Current implementation | Evidence required before launch |
| --- | --- | --- |
| Operator authorization | The wallet accepts a Testnet participation checkbox. | Record the legal operator, permitted jurisdictions, license or authorization references, and scope for casino, sportsbook, and XLM payments. Verify the applicable eligibility and access controls. |
| Player funds | New players receive 1,000 simulated XLM. Games and tickets debit that demo balance. | Open a separate production ledger with zero starting liabilities. Verify that only confirmed Mainnet credits or explicitly funded promotions can increase spendable balances. Reconcile player liabilities against the treasury. |
| Stellar transfers | The backend uses Horizon Testnet and the Testnet passphrase. | Provision a dedicated production treasury and signing controls. Verify that deposits and withdrawals use the same configured Mainnet identity across UI and backend. Exercise replay protection, withdrawal retries, and recovery when confirmation is delayed. |
| Casino settlement | Nine games settle in simulated stroops. | Verify game rules and payouts, run any required independent checks, and confirm atomic stake reservation and settlement using funded integer stroops. |
| Sportsbook | Fictional fixtures settle against generated scores. | Integrate an authorized feed for real fixtures, odds and results. Verify market suspensions, stale quotes, voids, result corrections and protection against duplicate settlements. |
| Production operations | The preview uses SQLite and operator reconciliation for some unresolved transfers. | Demonstrate backup and restore, balance reconciliation, monitoring, and the ability to pause wagering and withdrawals independently. |

Never import demo balances or Testnet deposits as Mainnet funds. Record the final release approval against a specific build after the authorization and verification evidence is available.

Code reviewed in the backend checkout: `casino/stellar.ts`, `casino/store.ts`, `casino/game.ts`, `casino/table-games.ts`, and `casino/sports.ts`.
