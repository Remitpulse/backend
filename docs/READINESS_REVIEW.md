# Backend readiness and security review — 2026-11-05

## Scope and conclusion

Reviewed backend main `4d088e91e31a784d29c052074eedcaf79af78ba1`, its
source, Prisma schema/migration, tests, package lock, CI and history; compared
frontend **current main** `7319d4e3cc4a27a477c8718eb34fd865cfff8339`
(`lib/api/client.ts`, `types.ts`, config and smart-account signing code).
Backend remote main matched the local base during review.

Real Stellar SDK, WebAuthn and Postgres integrations exist. This is meaningful
open-source implementation work, but **not production-ready**. Passing mocked
protocol tests do not establish deployed-contract compatibility or anchor
settlement. No network transaction was submitted, no funds moved, no deployment
or merge performed. Local Postgres and local HTTP anchors were used for tests.

## Validation

Environment: Node 24.21.0, npm 11.19.0, isolated Postgres 16 Alpine container.
CI targets Node 22; Docker currently targets Node 25. Those runtimes and the
Docker image build were not executed in this review.

- Clean `npm ci`: passed, 525 packages installed. Initial restricted-network
  attempt failed with EAI_AGAIN; retry with approved network access passed.
  npm warned about deprecated `@stellar/stellar-base` and esbuild install-script
  approval metadata. No lockfile dependency upgrades were made.
- `npm run prisma:generate`: passed.
- `prisma migrate deploy`: passed against the new isolated test database.
- Seed: passed using `node --import tsx --import ./test/setup-env.ts prisma/seed.ts`.
  Standalone `npm run db:seed` without the other required env vars fails at env
  validation; a migrated but unseeded database causes two existing corridor tests
  to fail. Seed only validates public-key syntax, not issuer/anchor authenticity.
- `npm run build`, `npm run type-check`, `npm run lint`, `npm run format:check`:
  passed after fixes (final results below).
- Full tests and coverage: see final validation results below. Initial restricted
  runs could not reach Postgres/bind local servers; reruns used approved access.
- `npm audit --json`: 13 moderate, 0 high, 0 critical; exits 1 because moderate
  advisories remain. Advisory metadata counts affected dependency nodes, not 13
  independent exploits. `glob` (GHSA-3g3m-2fjr-6pw4) and `minimatch`
  (GHSA-g3hv-75wg-m249) affect Sentry's bundler dependency and ESLint/TypeScript
  tooling trees. Review compatible updates separately; do not apply the suggested
  forced ESLint/TypeScript-ESLint major changes blindly.

Coverage includes mocked verification and RPC responses. Weak areas in the first
passing coverage run: custody 3.03% lines, FX service 0%, SEP-45 0%, anchor service
38.80%. High WebAuthn coverage does not mean real browser credentials were tested.

## Fixes included

| Severity | Reproducible issue | Change and regression evidence |
| --- | --- | --- |
| High | WebAuthn reads then deletes challenges without checking which request deleted them; concurrent verifications can both proceed | Delete the exact challenge ID and require count=1. Test forces both reads to return the same row and asserts only one verifier succeeds. Also avoids deleting newly issued options by subject. |
| High | SEP-10 signs without verifying the anchor signature or validating remaining operations | Verify Ed25519 anchor signature, operation types/sources, client-domain binding and web-auth domain before signing. Adversarial mock challenges must fail before the token endpoint receives a custody signature. Sequence-zero check already limits direct ledger execution; this remains a mutual-authentication failure. |
| Medium | SEP-10 uses the wallet domain as every anchor's home domain and accepts arbitrary 64-byte nonces | Bind request and challenge to the selected anchor domain; require the SEP-10 base64 encoding of 48 bytes. Remove the misleading global SEP10_HOME_DOMAIN setting. Test wrong home domain, nonce and reported network. |
| Medium | HTTP helper automatically repeats POST after lost responses, potentially creating multiple SEP-24 flows | Retry GET only. Local mock processes a POST then closes its connection; test asserts one request. This does not make initiation endpoints idempotent. |
| Medium | Sensitive limiter keys unauthenticated IPv6 callers by full address, enabling address rotation within one subnet | Use express-rate-limit ipKeyGenerator. Regression checks same-subnet addresses share a key and another subnet differs. Store remains per process. |

README now separates implemented code, simulations, tested behavior and unverified
integration; the older audit is explicitly marked superseded. SECURITY.md and
ATTRIBUTION.md were added. No financial settlement logic or contract ABI was
invented to conceal integration gaps.

## Unresolved security and integration risks

These are code-review findings, not claims of a completed exploit. Resolve and
exercise the high-priority items before exposing a funded deployment.

| Priority | Area / evidence | Remaining risk and required work |
| --- | --- | --- |
| High | Paymaster `sponsor` calls assertBudget before creating the sponsorship row | Concurrent direct fee-bump requests can all pass the same remaining budget. Atomically reserve the actual outer cap per user in a database transaction; add concurrent request tests. Relayer locking does not protect the direct fee-bump route. |
| High | Soroban `send`, paymaster catch and invocation catch | A timeout/poll error may follow successful ledger submission. Code marks failed, excludes spend and releases session allowance; a caller can prepare another invocation. Persist hashes/outcomes and reconcile unknown states before freeing reservations or retrying. Uniqueness of innerHash only protects an identical envelope. |
| High | Invocation preparation automatically uses relayer source; source-account auth is preserved | User-controlled calls to allow-listed contracts may exercise relayer source authority. Contract allow-list alone is not a method/argument/auth-tree policy. Validate all source authorization and sensitive wallet methods against deployed ABIs, or use a dedicated relayer with no token/admin authority. No deployed ABI/relayer privileges were available to verify impact. |
| High | Custody HMAC seed, custody/Horizon transactions | One seed derives every user's custody key (same user key across corridors). No key rotation, recovery or independent signing service. Horizon account/trustline operations do not acquire the Soroban relayer sequence lock; replicas can race and reserve sponsorship can be consumed. No local custody integration coverage beyond derivation. |
| High | SEP-24 withdrawal/deposit orchestration | Funding is wallet-to-custody only; no custody-to-anchor transfer with memo or deposit sweep is implemented. `/withdraw/start` does not check a confirmed funding invocation and initiation has no request idempotency key. An anchor flow can exist even when later payment preparation fails. These routes do not establish complete remittance settlement. |
| High if activated | Unused `sep45.ts` | Hardcoded endpoints, nonstandard TOML endpoint name and single-entry response; no challenge account/contract/function/arguments/subinvocation/server-signature validation. A signer would sign arbitrary returned authorization. Do not wire in this scaffold. Implement current draft SEP-45, full intent validation and simulation-footprint checks first. |
| Medium–High | Passkey management vs wallet contract | Adding/removing a login credential changes Postgres only. Deployment binds the first credential; subsequent login credentials need not work on-chain, while removed credentials may remain authorized on-chain. Implement contract key lifecycle and recovery with deployed-contract tests. |
| Medium | WebAuthn counters and account mutation | Counter writes are unconditional and can overwrite a newer counter during concurrent distinct assertions. Challenge issuance is per email/purpose, so callers can invalidate another login's options; registration and add-passkey share a purpose. Concurrent remove/add/register transactions lack per-user serialization. Email possession is not verified; registration discloses existence. |
| Medium | Webhook verification and state updates | Raw JSON body, Ed25519 verification and timestamp window exist; signature disabling remains configurable. Replays within the window have no event ID cache. recordUpdate reads before writing, allows terminal-to-terminal changes, and can race with another webhook/poll/expiry. Same-status observations drop changed amount/hash fields. Confirm anchor-specific signing convention and use atomic event ordering/state policy. |
| Medium | TOML/HTTP trust boundaries | Admin-configured domains and advertised URLs use unrestricted fetch, redirects and regex TOML parsing; endpoint HTTPS/private-network validation and body-size caps are absent. TLS is enforced for nonlocal TOML discovery, but not for advertised endpoints. Restrict egress and verify endpoint origins before sending bearer tokens. |
| Medium | Paymaster policy | One contract call, target allow-list, presence of a signature, fee bounds and duplicate-hash uniqueness are enforced. Signature presence is not cryptographic source verification; network validation is authoritative. Parsing XDR with the configured passphrase cannot prove its original network. Subcalls/methods/beneficiary are not fully bound to the authenticated user. Optional subsidy is a read, not an atomic debit/claim, and is skipped without a beneficiary. |
| Medium | Relayer advisory lock | Real Postgres concurrency tests pass, but its 60s transaction timeout can expire while 60s polling plus RPC/retries continue. JS work is not cancelled by transaction expiry. Shared-Postgres requirement also applies; do not infer horizontal safety solely from lock tests. |
| Medium | Database and operational secrets | Prisma queries and session-spend SQL use parameters, anchor JWTs use AES-GCM with fresh IVs. Connection TLS/least privilege/backups, retention/PII controls and deployed roles are unverified. Encryption accepts hashed passphrases; env placeholders need replacing with entropy. No rotation or row-bound encryption context. JWT revocation and distributed rate limiting are absent. Logger redaction has limited nesting; Sentry payload filtering needs review. |
| Medium | Seed/FX | `centre.io` and testanchor pairings, issuer provenance and network have not been validated. Tests accepting a G-address or deriving a SAC ID prove syntax only. Static rates are default; SEP-38 can fall back to static rates and quotes are not executable anchor offers. |

## Frontend/backend compatibility

Frontend realApi uses the paths below; setting backendUrl to `/v1` cannot fix
missing path segments, bodies, envelope or signing-model mismatches. No end-to-end
real-mode browser success is claimed; frontend demo fixtures are not evidence.

| Frontend main expectation | Backend implementation | Result |
| --- | --- | --- |
| `/auth/register/options` with displayName; verification without email | `/v1/auth/passkey/register/*`, email required | Incompatible enrollment |
| Discoverable `/auth/login/options` without body | `/v1/auth/passkey/login/*`, email required | Incompatible login |
| Direct `{options}` / `{token,contractId,credentialId,displayName}` | `{data: options}` / `{data:{token,user}}`, separate wallet deploy | Incompatible envelope and session model |
| `/quotes` with send/receive currency and quoteId/payTo | `/v1/fx/quote` with corridor/amount/kind; informational quote | No executable quote contract |
| `/recipients`, `/transfers`, `/accounts/:id/balance`, transfer SSE | Remittances list/get/sync, wallet endpoints; no equivalent recipient/SSE service | Missing product APIs |
| `/sep24/interactive`, `/sep24/transactions/:id` | `/v1/anchors/:code/deposit` or withdraw routes, `/v1/remittances/:id` | Incompatible paths, flow and response |
| `/session-keys`, `/session-keys/confirm`, raw hex key/maxAmount/ttlMinutes | `/v1/wallet/session-keys`, G-address, token, perTxLimit/totalLimit/ttlSeconds and prepared invocation | Incompatible scope/units/signing |
| `/transfers` carrying signedXdr from client simulation source | Server prepares auth payload and accepts assertion/signature by invocation ID; direct fee-bump requires a signed inner source | No matching rebuild-and-relay transfer endpoint |
| Reads top-level message/code on errors | Backend returns `{error:{code,message,details?}}` | Loses actionable errors |

Agree a versioned API and contract ABI, then add cross-repository integration tests
before implementing adapters. Missing settlement/recipient functionality cannot
be safely replaced with aliases returning simulated success.

## Open-source and disclosure readiness

MIT license, reproducible lockfile, CI configuration, dependency-update config and
source history are present. Core direct runtime licenses are MIT, Apache-2.0 and
BSD-2-Clause per the lockfile. Added attribution records major upstream projects
and distinguishes protocol use from endorsement. No obvious vendored code or
removed third-party header was found; full provenance and transitive distribution
notice compliance remain unverified. Tests and seed comments previously called
syntactically valid issuers “real”; that assertion is not corroborated by the tests.

GitHub private vulnerability reporting was checked and is **disabled**. Attempting
to enable it returned **403 Resource not accessible by integration**. SECURITY.md
gives the private advisory URL and a no-details escalation path; a repository admin
must enable/monitor reporting. No verified private security email was supplied or
invented. This remains an operational prerequisite, not a working reporting SLA.

## Final validation results

| Check | Result |
| --- | --- |
| Clean installation / Prisma generation / migrations / fixture seed | Passed |
| TypeScript build / type-check | Passed |
| ESLint / Prettier | Passed |
| `npm test` | 21 files passed, 222 tests passed, 0 failed, 0 skipped (41.39s) |
| `npm run test:coverage` | 21 files passed, 222 tests passed (25.23s), thresholds passed |
| V8 coverage | Statements 67.35%, branches 59.40%, functions 66.05%, lines 69.70% |
| `npm audit --json` | Exit 1: 13 moderate, 0 high, 0 critical |
| `git diff --check` | Passed |

The PR adds 11 regression cases (8 adversarial SEP-10 variants, concurrent
challenge consumption, lost-response POST handling and IPv6 subnet limiting).
Existing tests also run; no coverage thresholds were lowered. Live browser
WebAuthn, live anchor authentication/settlement, contract WASM compatibility,
mainnet/testnet execution, Docker builds and CI results are unverified here.

An initial type-check caught a Prisma-mock return-type mismatch in the new
concurrency test; it was corrected and the final type-check passed. The first
Postgres-enabled full suite had 216 passes and two failures because corridor
fixtures were absent; after the explicit seed and final changes all tests passed.
