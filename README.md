# RemitPulse Backend

[![CI](https://github.com/Remitpulse/backend/actions/workflows/ci.yml/badge.svg)](https://github.com/Remitpulse/backend/actions/workflows/ci.yml)

Passkey smart wallets, a sponsored Soroban relay/paymaster, and SEP-10/SEP-24 remittance
corridors with FX quoting, on Stellar.

## Readiness

This is an experimental backend, not a verified production remittance service. Real SDK/RPC
and database code exists, but automated tests mostly use mocked WebAuthn verification and
Soroban responses or a local mock anchor. No deployed contract ABI, live anchor settlement,
or end-to-end frontend integration was verified in the [2026-11-05 review](docs/READINESS_REVIEW.md).
The current frontend main branch is **not API-compatible** with this backend. SEP-45 is an
unused, unvalidated scaffold and must not be used to sign anchor challenges.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting and
[ATTRIBUTION.md](ATTRIBUTION.md) for licensing and dependency attribution.

## What this service implements

- **Passkey smart wallets** — WebAuthn (ES256/P-256) enrollment and login (`/v1/auth`), smart
  wallet deployment and a two-phase relay for Soroban contract calls (`/v1/wallet`), with backend-managed relayer and sponsor keys. Live contract compatibility remains unverified.
- **Scoped session keys** — Ed25519 signers a user's wallet can authorize for low-value payments
  within per-transaction and total limits, without a passkey prompt each time (`/v1/wallet/session-keys`).
- **Paymaster / fee-bump sponsorship** — wraps user transactions in a fee-bump signed by a
  sponsor account, checking a contract allow-list, fee caps and a rolling daily
  budget per user (with the concurrency limitation below), plus optional on-chain subsidy-allowance reads (`/v1/paymaster`).
- **Remittance corridors** — configurable fiat corridors (`USDC`/`EURC`/`ARST`/`BRLA` seeded by
  default) with RemitPulse's markup/fee schedule (`/v1/corridors`, admin via `/v1/admin/corridors`).
- **SEP-10 / SEP-24 anchor integration** — authenticates with each corridor's anchor and starts
  interactive deposit/withdrawal flows, with a webhook receiver and status tracking in
  Postgres (`/v1/anchors`, `/v1/remittances`).
- **FX rates & fee quoting** — static reference rates by default, with optional HTTP/SEP-38 providers and a corridor fee/amount calculator
  (`/v1/fx`).

## Architecture notes

- **Contract auth payloads.** `POST /v1/wallet/invocations` simulates a Soroban call against the
  user's smart wallet, extracts the `SorobanAuthorizationEntry` it must sign and returns the
  exact 32-byte payload (`sha256(HashIdPreimageSorobanAuthorization)`); the client signs it with
  either a WebAuthn assertion (passkey) or a raw Ed25519 signature (session key), and
  `POST /v1/wallet/invocations/:id/submit` attaches it, re-simulates, signs as the relayer,
  fee-bumps via the paymaster and submits.
- **Anchor custody accounts.** Classic SEP-10/SEP-24 anchors transact with plain Stellar (`G...`)
  accounts, not Soroban contract addresses. For each user RemitPulse deterministically
  derives a dedicated Ed25519 "custody" account (`HMAC-SHA256(ANCHOR_CUSTODY_SEED, "anchor-custody:" + userId)`,
  distinct from both `RELAYER_SECRET_KEY` and the user's own smart wallet) and funds/sponsors its
  reserve and trustline on demand. No extra key material is stored in the database.
- **Withdrawal preparation.** `POST /v1/anchors/:code/withdraw` starts an interactive
  SEP-24 flow and then prepares a wallet-to-custody payment in `funding.preparedInvocation`.
  Alternatively use `/withdraw/funding`, submit its invocation, then `/withdraw/start`.
  These initiation endpoints do not enforce funding confirmation or provide request idempotency;
  retries may create another anchor flow. There is no implemented custody-to-anchor payment
  submission or deposit sweep back to the smart wallet.
- **Anchor web auth.** The active service uses classic SEP-10 with the per-user custody account.
  `src/interfaces/anchors/sep45.ts` is unused scaffolding; it does not validate an anchor's
  authorization intent and is not a supported SEP-45 implementation.
- **Lifecycle tracking.** Every SEP-24 transaction is mirrored into `remittance_transactions`,
  normalised from the anchor's raw status into `incomplete | pending_user_transfer |
  pending_anchor | completed | failed`, with an append-only `remittance_events` audit trail
  populated from initiation, the anchor's webhook callback, or an explicit
  `POST /v1/remittances/:id/sync` poll.
- **Background remittance poller.** A scheduled job in the server process periodically picks up
  non-terminal `remittance_transactions` (`status` not in `completed`/`failed`) whose `updatedAt`
  is older than `REMITTANCE_POLL_STALE_AFTER_SECONDS`, and calls `syncTransaction` for each in
  small batches (one tick every `REMITTANCE_POLL_INTERVAL_SECONDS`), logging per-transaction
  failures without aborting the tick. This keeps statuses fresh even when an anchor's webhook
  delivery fails and the client never retries the manual sync.
- **Relayer sequence locking (cross-process).** Relayer-sourced Soroban submissions are
  serialized across *all* backend replicas with a Postgres advisory lock
  (`pg_advisory_xact_lock`) keyed by the relayer account's public key — not an in-process mutex,
  which would only protect a single process. The lock is released when its database transaction ends. Its 60-second lifetime can expire
  before an RPC submission finishes; custody/Horizon transactions do not use this lock. This assumes every
  replica connects to the **same** Postgres instance (`DATABASE_URL`); all replicas must share this database for mutual exclusion. This is necessary but does not
  resolve the timeout and custody-transaction limitations above.
- **Webhook authenticity.** `POST /v1/anchors/:code/webhook` verifies the anchor's
  `Signature: t=<unix>, s=<base64 ed25519 sig>` header against the `SIGNING_KEY` published in its
  `stellar.toml`, rejecting stale or unsigned
  callbacks when `WEBHOOK_REQUIRE_SIGNATURE=true`. Compatibility with a specific anchor
  platform's callback convention remains unverified.
- **Error reporting.** Setting `SENTRY_DSN` reports unhandled 5xx errors, uncaught exceptions and
  unhandled promise rejections to Sentry; leaving it blank disables reporting entirely (the
  default) with no other behavior change.

## Known limitations

- **Seed data is not partner verification.** The seed hardcodes `centre.io` for USDC/EURC
  and `testanchor.stellar.org` for ARST/BRLA. It validates issuer syntax only; tests derive
  asset contract IDs locally. Neither proves current anchor support, issuer provenance,
  network compatibility, KYC access, or settlement. Verify each corridor independently.
- **Sponsorship accounting.** The inner fee cap is `PAYMASTER_MAX_FEE_STROOPS`; the outer
  fee-bump cap is twice that amount. Daily budget checks are not atomic with reservation.
  Timeout outcomes need chain reconciliation before retrying or releasing allowances.
- **Custody.** The backend can derive every anchor custody private key from one seed. This
  leg is custodial. Seed loss/compromise affects all these accounts; rotation and recovery
  are not implemented. Adding/removing login passkeys does not update on-chain wallet keys.

## Getting started

### Prerequisites

- Node.js 22 (`.nvmrc`); dependency engine compatibility must also be checked. The review ran on Node 24.21.0.
- PostgreSQL 14+
- A funded Stellar account for `RELAYER_SECRET_KEY` and one for `PAYMASTER_SECRET_KEY`
  (testnet: fund via https://friendbot.stellar.org)
- The compiled account-factory and subsidy contracts deployed to your target network, for
  `ACCOUNT_CONTRACT_ID` / `SUBSIDY_CONTRACT_ID`

### Environment variables

```bash
cp .env.example .env
```

Fill in every value — `src/config/env.ts` validates them at boot (via Zod) and the process exits
immediately with a readable error if anything is missing or malformed. See the comments in
`.env.example` for what each group of variables controls; the "Architecture notes" above explain
`ANCHOR_CUSTODY_SEED`, `ENCRYPTION_KEY`, the paymaster policy variables and the background
remittance poller (`REMITTANCE_POLL_INTERVAL_SECONDS`, `REMITTANCE_POLL_STALE_AFTER_SECONDS`) in
more detail.

### Local development (without Docker)

```bash
npm ci
npm run prisma:generate
npm run db:migrate     # applies prisma/schema.prisma to DATABASE_URL
npm run db:seed        # loads hardcoded example corridors; verify anchors and network before use
npm run dev            # tsx watch src/server.ts, http://localhost:8080
```

- Swagger UI: `http://localhost:8080/docs`
- Raw OpenAPI document: `http://localhost:8080/openapi.json` (or `npm run openapi:export` to
  write `openapi.json` to disk without starting the server)

### Tests, linting and formatting

```bash
npm test              # requires migrated AND seeded Postgres (see test/setup-env.ts for defaults)
npm run test:coverage # same, with a v8 coverage report (text + coverage/index.html)
npm run type-check
npm run lint           # eslint; npm run lint:fix to auto-fix
npm run format:check   # prettier --check; npm run format to rewrite in place
```

CI (`.github/workflows/ci.yml`) runs all of the above against a Postgres service container on
every push to `main` and every pull request, plus a separate job that builds the production
Docker image.

### Docker

```bash
cp .env.example .env    # fill in real values; DATABASE_URL is overridden by docker-compose
docker compose build
docker compose up -d postgres
docker compose run --rm backend npx prisma migrate deploy
docker compose run --rm backend npx prisma db seed
docker compose up -d backend
```

The `Dockerfile` is a multi-stage build (`npm run build` under Node 25, then a slim runtime image
running `node dist/server.js` as the non-root `node` user). `docker-compose.yml` adds a Postgres
16 service; migrations are run explicitly (above) rather than on every container start, matching
how you'd run them against a managed database in production.

## API reference

| Prefix | Purpose |
| --- | --- |
| `/v1/health` | Liveness/readiness (DB connectivity) |
| `/v1/auth` | Passkey (WebAuthn) enrollment, login, session |
| `/v1/wallet` | Smart wallet deployment, contract auth payloads, relay, payments |
| `/v1/wallet/session-keys` | Issue/list/revoke scoped Ed25519 session keys |
| `/v1/paymaster` | Sponsorship policy status, fee-bump of a signed transaction |
| `/v1/corridors`, `/v1/admin/corridors` | List/get corridors; admin create/update pricing & availability |
| `/v1/anchors` | SEP-10 auth, SEP-24 initiation, withdrawal payment preparation, anchor webhook |
| `/v1/remittances` | Paginated list/get of the current user's transfers, force a status re-sync |
| `/v1/fx` | Reference FX rates, corridor fee/amount quotes |

Request validation and documented response schemas are available in Swagger UI at `/docs`.
Responses are not runtime-validated against those schemas. All successful responses are wrapped as
`{ "data": ... }`; errors as `{ "error": { "code", "message", "details?" } }`. A Prisma
not-found/unique/foreign-key error that reaches the error handler unmapped is itself translated
into the matching 404/409/400 rather than leaking as a 500.

`GET /v1/remittances` uses keyset pagination: `?limit=20&cursor=<id>`, returning
`{ "data": { "items": [...], "nextCursor": "<id>" | null } }` — pass the previous response's
`nextCursor` to fetch the next page.

Authentication: `Authorization: Bearer <JWT>` (issued by `/v1/auth/passkey/*`) for user routes,
`x-api-key: <key>` (one of `ADMIN_API_KEYS`) for `/v1/admin/*`. General endpoints are capped at
`RATE_LIMIT_MAX` requests per `RATE_LIMIT_WINDOW_MS`; endpoints that spend relayer/paymaster funds
or hit anchors use the tighter `SENSITIVE_RATE_LIMIT_MAX`.

## Contract deployment key bindings

This service assumes the account-factory and subsidy contract ABIs documented in
`src/interfaces/contracts/bindings.ts` — see that file for the exact Rust signatures expected
(`deploy`, `add_session_key`, `revoke_session_key`, `__check_auth`, `allowance`, `claim`). If your
deployed WASM differs, review bindings, signature formats, and all dependent service logic together. Point `ACCOUNT_CONTRACT_ID` and
`SUBSIDY_CONTRACT_ID` at your deployed contract addresses on the network named by
`STELLAR_NETWORK_PASSPHRASE`; `RELAY_ALLOWED_CONTRACTS` can list any additional contracts (beyond
those two and active corridor asset contracts) users may invoke through the relay.
