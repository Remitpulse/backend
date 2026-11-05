# Security policy

RemitPulse Backend is experimental. A passing test suite is not a security audit or
evidence of production anchor/contract compatibility. Only the latest `main` is
reviewed; there is no maintained stable release or backport commitment.

## Report privately

Do not put vulnerability details, credentials, personal data, or exploit payloads
in public issues, discussions, or pull requests.

Use GitHub's **Security → Report a vulnerability** for this repository:
https://github.com/Remitpulse/backend/security/advisories/new
This creates a private advisory when private vulnerability reporting is enabled.
As of the 2026-11-05 review, reporting is disabled and the automation token cannot
enable it (GitHub returned HTTP 403); a repository admin must enable it.
If GitHub does not offer that form, ask a maintainer to enable private reporting
using a public request containing no vulnerability details. No monitored security
email address is currently published here; do not guess one. Maintainers must
enable and monitor this channel before operating a public service.

Include the affected commit/version, prerequisites, minimal reproduction using
local fixtures or testnet, expected/actual behavior, and potential impact. Remove
real secrets and customer data. Do not move funds or test against other users.

Maintainers should acknowledge privately, reproduce with isolated fixtures,
coordinate a fix and regression test with the reporter, and agree a disclosure
date after affected operators can update. Response times are best-effort; no SLA
or bounty is promised. Disclose publicly only after coordination.

## Scope and key exposure

Relevant areas include WebAuthn, JWTs, Soroban authorization, sponsor budgets,
custody derivation, anchor protocols, callbacks, database access and dependencies.
The backend holds relayer/sponsor signing keys and a seed that derives all user
anchor custody keys. It is not fully noncustodial. Never include these secrets in
a report. Suspected live-key exposure requires immediate operator incident
handling and private coordination; this policy does not authorize moving funds.
