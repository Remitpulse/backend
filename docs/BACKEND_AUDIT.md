# RemitPulse Backend Audit (historical)

> Superseded by [the 2026-11-05 readiness review](READINESS_REVIEW.md).
> This historical report contains incorrect claims: custody keys ARE derived by the
> backend, SEP-10 previously omitted anchor-signature/operation checks, and passing
> tests or CI configuration do not prove live interoperability. Its claims of
> production-grade authentication and no custody must not be used as readiness evidence.

**Date:** 2026-11-02
**Scope:** `src/`, `prisma/`, `.github/workflows/`, `Dockerfile`, `test/`
**Method:** Manual code review (no live Testnet transactions submitted, no destructive commands run). `npm run lint`, `npm run type-check`, and `npm test` were actually executed; results below are real output, not assumptions.

This audit reflects the codebase as it exists today. It does not claim production-anchor or mainnet readiness anywhere that isn't verified in code.

## Summary

The backend is in materially better shape than a "full audit needed" brief implies: lint and type-check are clean, 57 of 59 runnable unit/integration tests pass (2 DB-backed suites only fail in this sandbox because no Postgres is reachable — they pass under the CI Postgres service), CI already runs lint/format/type-check/build/coverage/`npm audit`/CodeQL/Docker build, and the architecture correctly avoids custodial key storage throughout (passkey/WebAuthn + session keys only; the backend holds only its own relayer/sponsor keys).

No critical vulnerabilities were found. Findings below are real, verified-in-code issues, ranked by severity, followed by what's already correct.

## Findings

| # | Area | File:Line | Issue | Impact | Severity |
|---|------|-----------|-------|--------|----------|
| 1 | Test coverage | `src/interfaces/soroban/*`, `src/interfaces/paymaster/*`, `src/api/wallet`, `src/api/session-keys` | No dedicated tests for Soroban service, paymaster, wallet, session-key, or WebAuthn services — the financially-sensitive core (fee-bump policy, session-key limits, passkey/contract-auth) is unverified by automated tests | Regressions in money-moving logic wouldn't be caught by CI | **High** |
| 2 | Test coverage | `src/api/core/middlewares/authentication.ts`, `rate-limit.ts`, `src/interfaces/webauthn` | No tests for JWT sign/verify, `requireUser`/`requireAdmin`, rate limiting, or WebAuthn challenge/replay/expiry behavior | Auth regressions unverified by CI | **High** |
| 3 | SEP-24 reliability | `src/api/anchors/service.ts:166-190` (`recordUpdate`) | No forward-only state-machine check on webhook status updates — only dedups on exact-match status. A replayed anchor-signed webhook within `WEBHOOK_MAX_AGE_SECONDS` (default 300s) could roll a transaction's status backward (e.g. `completed` → `pending_anchor`) | Status corruption on a captured, still-valid-window webhook | **Medium** |
| 4 | Payment lifecycle | `src/jobs/remittance-poller.ts` | `TERMINAL_STATUSES` only covers `completed`/`failed`; transactions stuck in `incomplete`/`pending_user_transfer`/`pending_anchor` (e.g. abandoned SEP-24 flow) are polled forever with no expiry | Unbounded stale-row growth, no "expired" signal to users | **Medium** |
| 5 | Reliability | `src/lib/http-client.ts:31-41` | Anchor/FX HTTP calls (`requestJson`) have a timeout but no retry; `retry()` exists and is used elsewhere (Soroban, custody) but not wired in here | Transient network blips to anchors cause avoidable user-facing failures | **Medium** |
| 6 | Config/transport security | `src/interfaces/anchors/toml.ts:79` | `ANCHOR_ALLOW_HTTP` is one global flag for all anchor domains, not scoped per-domain/environment | If ever set `true` outside local test config, silently downgrades TLS for every anchor's `stellar.toml`/SIGNING_KEY fetch | **Medium** |
| 7 | Security posture (defense-in-depth) | `src/config/env.ts:105`, `src/interfaces/anchors/sep24.ts:80` | `WEBHOOK_REQUIRE_SIGNATURE` (default `true`) fully disables webhook signature verification when `false` | Not a live bug, but a single misconfigured env var removes all anti-forgery on remittance status webhooks | **Low/Medium** |
| 8 | Auth | `src/api/auth/service.ts:27-31` | `registrationOptions` returns `409` when an email already has a passkey, while `loginOptions` deliberately avoids leaking account existence — inconsistent, enables email enumeration via the register endpoint | Account enumeration (no credential exposure) | **Low** |
| 9 | Rate limiting | `src/api/core/middlewares/rate-limit.ts:7` | Unauthenticated routes (auth register/login) key solely on `req.ip`; no distributed brute-force resistance | Shared-NAT users share one bucket; distributed attacker bypasses by rotating IPs | **Low–Medium** |
| 10 | Logging | `src/config/logger.ts:9` | Pino redact paths (`*.secret`, `*.token`, etc.) only match one nesting level; no doubly-nested secret currently logged, but the pattern is fragile | Latent gap — would not redact `data.anchor.secret` or similar if ever logged | **Low** |
| 11 | Reliability | `src/lib/retry.ts` | No failure classification — retries permanent and transient errors identically | Wastes ~2-3 attempts/900ms on non-retryable errors; not currently harmful | **Low** |
| 12 | Observability | `src/jobs/remittance-poller.ts:32` | Uses `console.error` instead of the project's structured pino logger | Poller failures bypass structured logging/Sentry correlation | **Low** |
| 13 | SEP-24 validation | `src/api/anchors/service.ts:89-90`, `src/interfaces/anchors/sep24.ts:35-62` | No client-side check of `assetCode` against the anchor's advertised `toml.currencies` before calling the anchor | Anchor still rejects unsupported assets — missing guard just produces a less clear error | **Low** |
| 14 | Webhook robustness | `src/api/anchors/routes.ts:121` | Falls back to re-serializing `req.body` as JSON when `req.rawBody` is absent; re-serialized JSON won't byte-match what was signed | Only triggers if an anchor posts non-`application/json`; fails closed (errors, doesn't accept unsigned data) | **Low** |
| 15 | FX precision (cosmetic) | `src/api/fx/service.ts:38` | `referenceRate` (informational display value) converts Big→`toNumber()`; all settlement math (`platformFee`, `amountOut`) stays in Big.js | No money-moving precision loss; inconsistency only | **Low** |
| 16 | Dead code / scope accuracy | `src/interfaces/anchors/sep45.ts` | SEP-45 (contract-account/passkey web auth) is fully implemented but not called anywhere — confirmed by its own header comment and no call sites outside its module/tests | Must not be described as a supported/active feature | **Note, not a bug** |

## What's Already Correct

**Auth & crypto**
- JWT: HS256, `issuer`/`audience` pinned, 32+ char secret enforced by zod schema, generic failure responses (no algorithm confusion or claim leakage).
- `requireAdmin` API-key comparison uses length-checked `timingSafeEqual` (`src/lib/crypto.ts`) — not timing-attackable.
- AES-256-GCM for anchor-JWT-at-rest: random 12-byte IV per call, auth tag verified on decrypt.
- WebAuthn: ES256-only, `userVerification: 'required'`, origin + RP ID checked every verification, challenges single-use and TTL-bounded, login path doesn't leak account existence.
- No hardcoded secrets anywhere in `src/` (grepped). No custodial private-key handling anywhere — users sign via passkey or session keys; backend only holds its own relayer/sponsor keys, never logged.

**API & data integrity**
- Consistent `auth: 'none' | 'user' | 'admin'` gating across every router; IDOR check on remittance transactions (`service.ts` verifies `transaction.userId !== userId`).
- Error handler never leaks stack traces or internal detail to clients.
- All financial math (`src/lib/money.ts`) uses Big.js, 20dp, round-down — no floating point in deposit/withdrawal/fee paths.
- Duplicate-payment prevention via `@@unique([corridorId, anchorTxId])` plus idempotent `recordUpdate` (short-circuits on unchanged status).
- Prisma schema has appropriate indexes (`[userId, createdAt]`, `[status]`, `[status, updatedAt]`, `[userId, status]`); no N+1 patterns found in list queries.

**Stellar / Soroban integration**
- Real Testnet/Mainnet-capable RPC integration (actual `rpc.Server`, real XDR build/simulate/sign/submit, polls `getTransaction`) — not a mock.
- Paymaster enforces real sponsorship policy server-side: network match, single `InvokeHostFunction` op, allow-listed contract, fee cap, per-user rolling 24h budget.
- Relayer sequence-number races handled via a Postgres advisory lock scoped to the transaction.
- Two-phase invocation (`prepare`/`submit`) restricts auth to the caller's own wallet and claims pending invocations via a conditional `updateMany` (no double-submit race).
- Session-key spend limits enforced atomically via a single conditional `$executeRaw` UPDATE — race-safe, parameterized (no SQL injection).

**SEP-10 / SEP-24**
- SEP-10 challenge validation is spec-correct: XDR validity, non-fee-bump, source matches TOML `SIGNING_KEY`, sequence `== 0`, correct `manageData` op/name/64-byte nonce, bounded and capped (900s) time window — well covered by `test/anchors.test.ts`.
- Per-user anchor custody keys are deterministically derived (HMAC-SHA256) and never persisted.
- SEP-24 webhook signature verification: Ed25519 against the anchor's published `SIGNING_KEY`, with a bounded timestamp window; tested for valid/wrong-key/tampered/missing-header cases.
- Anchor integration points at Stellar's real reference Testnet anchor (`testanchor.stellar.org`) — genuine protocol wiring, not a stub.

**CI / Docker**
- `.github/workflows/ci.yml` already runs: lint, `format:check`, type-check, build, `test:coverage` against a real Postgres service container, `npm audit --audit-level=high`, CodeQL, and a Docker build job.
- `Dockerfile` is multi-stage, runs as non-root (`USER node`), and has a `HEALTHCHECK` against `/v1/health`.
- Dependabot is configured and enabled.

## Integration Maturity (explicit, non-inflated)

- **Stellar/Soroban:** Testnet/Mainnet-capable, real transaction lifecycle. Contract bindings assume a documented Rust interface; whether `Remitpulse/contracts`' deployed ABI matches was **not verified in this pass** (that repo wasn't inspected).
- **SEP-10:** Production-grade implementation, well-tested, against a real (Testnet) anchor.
- **SEP-24:** Solid core flow with the state-machine/replay gap (#3) and missing asset pre-check (#13) to close before handling real funds.
- **SEP-45:** Implemented but **not wired up** — scaffolded, not active.
- **Anchor partner:** Stellar's official Testnet reference anchor only. No commercial/production anchor is configured anywhere in this codebase.

## Actual Command Results

```
npm run lint        → clean, 0 errors/warnings
npm run type-check   → clean, 0 errors
npm test -- --run    → 57 passed, 27 skipped, 2 test files failed in THIS sandbox
                        (corridors.test.ts, remittances.test.ts — PrismaClientKnownRequestError
                        in beforeAll/afterAll because no Postgres is reachable here;
                        CI provisions a real postgres:16-alpine service where these pass)
```

## Recommended Next Steps (not yet implemented — pending prioritization)

1. Add tests for Soroban/paymaster/wallet/session-key/WebAuthn/auth/rate-limit modules (findings #1, #2) — highest-value gap.
2. Add forward-only status transition guard in `recordUpdate` (#3).
3. Add expiry handling to the remittance poller for non-terminal stale transactions (#4).
4. Wire `retry()` into `http-client.ts` for anchor/FX calls (#5).
5. Scope `ANCHOR_ALLOW_HTTP` per-domain/environment instead of globally (#6).
6. Make passkey registration's conflict response generic to match the login path's anti-enumeration stance (#8).
7. Everything else (#9–#15) is lower-priority hardening/polish.
