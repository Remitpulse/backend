# Licensing and attribution

RemitPulse source is licensed under the [MIT license](LICENSE), copyright 2026
Remitpulse. Preserve existing contributor history and third-party notices.

Core upstream dependencies used by this backend include:

| Upstream | Use | Lockfile license |
| --- | --- | --- |
| [Stellar JavaScript SDK](https://github.com/stellar/js-stellar-sdk) | XDR, Soroban RPC, Horizon, signatures and fee bumps | Apache-2.0 |
| [SimpleWebAuthn](https://github.com/MasterKale/SimpleWebAuthn) | WebAuthn options and credential verification | MIT |
| [Prisma](https://github.com/prisma/prisma) | PostgreSQL ORM and client | Apache-2.0 |
| [Express](https://github.com/expressjs/express) | HTTP routing | MIT |
| [Zod](https://github.com/colinhacks/zod) | Request and configuration validation | MIT |
| [Sentry JavaScript](https://github.com/getsentry/sentry-javascript) | Optional error reporting | MIT |
| [dotenv](https://github.com/motdotla/dotenv) | Environment loading | BSD-2-Clause |

This table identifies major dependencies, not a complete redistribution notice
bundle. `package-lock.json` records all resolved packages and their declared
licenses; installed packages contain the authoritative license/NOTICE files.
Retain required notices when distributing bundled dependencies or container images.

Anchor interfaces follow the Stellar protocol specifications
[SEP-10](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md),
[SEP-24](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md),
and the draft [SEP-45](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0045.md).
Protocol references do not imply certification, partnership, or upstream endorsement.
Contract bindings are locally handwritten assumptions, not verified generated bindings.

The 2026-11-05 review found no explicit vendored upstream source or removed license
headers in the reviewed source/history. This is not a complete provenance or legal
audit. Identify any copied/adapted source with its original URL, commit, author and
license before accepting it; preserve upstream notices rather than replacing them
with the repository's MIT header.
