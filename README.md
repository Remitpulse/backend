# RemitPulse Backend

[![CI](https://github.com/Remitpulse/backend/actions/workflows/ci.yml/badge.svg)](https://github.com/Remitpulse/backend/actions/workflows/ci.yml)

Passkey smart wallets, a sponsored Soroban relay/paymaster, and SEP-10/SEP-24 remittance
corridors with FX quoting, on Stellar.

## What this service does

- **Passkey smart wallets** — WebAuthn (ES256/P-256) enrollment and login (`/v1/auth`), smart
  wallet deployment and a two-phase relay for Soroban contract calls (`/v1/wallet`), so users
  never hold a seed phrase or pay network fees directly.
- **Scoped session keys** — Ed25519 signers a user's wallet can authorize for low-value payments
  within per-transaction and total limits, without a passkey prompt each time (`/v1/wallet/session-keys`).
- **Paymaster / fee-bump sponsorship** — wraps user transactions in a fee-bump signed by a
  sponsor account, enforcing a contract allow-list, a per-transaction fee cap and a rolling daily
  budget per user, with optional on-chain subsidy-allowance checks (`/v1/paymaster`).
- **Remittance corridors** — configurable fiat corridors (`USDC`/`EURC`/`ARST`/`BRLA` seeded by
  default) with RemitPulse's markup/fee schedule (`/v1/corridors`, admin via `/v1/admin/corridors`).
- **SEP-10 / SEP-24 anchor integration** — authenticates with each corridor's anchor and starts
  interactive deposit/withdrawal flows, with a webhook receiver and full lifecycle tracking in
  Postgres (`/v1/anchors`, `/v1/remittances`).
- **FX rates & fee quoting** — live reference rates and a corridor fee/amount calculator
  (`/v1/fx`).

## Architecture notes

- **Contract auth payloads.** `POST /v1/wallet/invocations` simulates a Soroban call against the
  user's smart wallet, extracts the `SorobanAuthorizationEntry` it must sign and returns the
  exact 32-byte payload (`sha256(HashIdPreimageSorobanAuthorization)`); the client signs it with
  either a WebAuthn assertion (passkey) or a raw Ed25519 signature (session key), and
  `POST /v1/wallet/invocations/:id/submit` attaches it, re-simulates, signs as the relayer,
  fee-bumps via the paymaster and submits.
- **Anchor custody accounts.** Classic SEP-10/SEP-24 anchors transact with plain Stellar (`G...`)
  accounts, not Soroban contract addresses. For each user/corridor pair RemitPulse deterministically
  derives a dedicated Ed25519 "custody" account (`HMAC-SHA256(ANCHOR_CUSTODY_SEED, userId)`,
  distinct from both `RELAYER_SECRET_KEY` and the user's own smart wallet) and funds/sponsors its
  reserve and trustline on demand. No extra key material is stored in the database.
- **Automated withdrawal funding.** `POST /v1/anchors/:code/withdraw` prepares the transfer that
  moves the withdrawal `amount` from the user's smart wallet into the custody account the anchor
  will debit, reusing the same invocation-relay machinery as `POST /v1/wallet/invocations`. The
  response includes a `PreparedInvocation` (and the custody `account`); the client signs it with
  the passkey (or a session key) and submits it via `POST /v1/wallet/invocations/:id/submit`. The
  returned SEP-24 interactive URL is only usable once that transfer has landed — call
  `POST /v1/anchors/:code/withdraw/:id/start` (idempotent) to begin the interactive flow after
  submitting the funding invocation.
- **Anchor web auth selection.** `authenticate`/`ensureAnchorSession` read the anchor's
  `stellar.toml` and pick the auth scheme per anchor: if it advertises SEP-45
  (`WEB_AUTH_CONTRACT_ID`), RemitPulse authenticates directly as the user's smart-wallet contract
  address using a Soroban authorization entry (built and signed exactly like a wallet invocation);
  otherwise it falls back to classic SEP-10 with the per-user custody account described above.
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
  (`pg_advisory_lock`) keyed by the relayer account's public key — not an in-process mutex,
  which would only protect a single process. The lock is released on both success and failure
  paths (timeout-safe), so a failed submission never wedges the relayer. This assumes every
  replica connects to the **same** Postgres instance (`DATABASE_URL`); horizontal scaling is
  safe as long as that shared-Postgres assumption holds, since replicas that don't share a
  database would not see each other's locks and could race on the relayer's sequence number.
- **Webhook authenticity.** `POST /v1/anchors/:code/webhook` verifies the anchor's
  `Signature: t=<unix>, s=<base64 ed25519 sig>` header against the `SIGNING_KEY` published in its
  `stellar.toml` (the convention used by Stellar's Anchor Platform), rejecting stale or unsigned
  callbacks when `WEBHOOK_REQUIRE_SIGNATURE=true`.
- **Error reporting.** Setting `SENTRY_DSN` reports unhandled 5xx errors, uncaught exceptions and
  unhandled promise rejections to Sentry; leaving it blank disables reporting entirely (the
  default) with no other behavior change.

## Known limitations

- **Reference anchor domain.** Seeded corridors point at `testanchor.stellar.org` (Stellar's public
  SEP test anchor) with randomly generated, unfunded placeholder asset issuers — replace both via
  `PATCH /v1/admin/corridors/:code` before connecting to a production anchor.
- **Seeded corridor issuers.** Each seeded corridor's `assetIssuer` and `anchorDomain` come from
  the real anchor's published `stellar.toml` (`CURRENCIES` section) for the anchor(s) RemitPulse
  integrates with, so `asset.contractId` resolves to the actual Stellar Asset Contract. Both can
  still be overridden per corridor via `PATCH /v1/admin/corridors/:code` (e.g. when switching to a
  different anchor or network).

## Getting started

### Prerequisites

- Node.js 20+ (`.nvmrc` pins 22)
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
npm install
npm run db:migrate     # applies prisma/schema.prisma to DATABASE_URL
npm run db:seed        # seeds the USDC/EURC/ARST/BRLA corridors with their real anchor issuers
npm run dev            # tsx watch src/server.ts, http://localhost:8080
```

- Swagger UI: `http://localhost:8080/docs`
- Raw OpenAPI document: `http://localhost:8080/openapi.json` (or `npm run openapi:export` to
  write `openapi.json` to disk without starting the server)

### Tests, linting and formatting

```bash
npm test              # vitest run — needs DATABASE_URL reachable (see test/setup-env.ts for defaults)
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

The `Dockerfile` is a multi-stage build (`npm run build` under Node 22, then a slim runtime image
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
| `/v1/anchors` | SEP-10/SEP-45 auth, SEP-24 deposit/withdraw initiation (with automated funding), anchor webhook |
| `/v1/remittances` | Paginated list/get of the current user's transfers, force a status re-sync |
| `/v1/fx` | Reference FX rates, corridor fee/amount quotes |

Full request/response schemas (generated from the same Zod schemas the routes validate against,
so they can't drift) are in Swagger UI at `/docs`. All successful responses are wrapped as
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
deployed WASM differs, that is the only file you need to change. Point `ACCOUNT_CONTRACT_ID` and
`SUBSIDY_CONTRACT_ID` at your deployed contract addresses on the network named by
`STELLAR_NETWORK_PASSPHRASE`; `RELAY_ALLOWED_CONTRACTS` can list any additional contracts (beyond
those two and active corridor asset contracts) users may invoke through the relay.
