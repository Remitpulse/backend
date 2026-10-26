import 'dotenv/config'

import { StrKey } from '@stellar/stellar-sdk'
import { z } from 'zod'

const csv = z
  .string()
  .default('')
  .transform(value =>
    value
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
  )

const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform(value => value === 'true' || value === '1')

const stellarSecret = z.string().refine(StrKey.isValidEd25519SecretSeed, 'must be a valid Stellar secret seed (S...)')
const contractId = z.string().refine(StrKey.isValidContract, 'must be a valid contract id (C...)')

const staticRates = z
  .string()
  .default('{"USD":1,"EUR":0.92,"ARS":1050,"BRL":5.6}')
  .transform((value, ctx) => {
    try {
      return JSON.parse(value) as unknown
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be valid JSON' })
      return z.NEVER
    }
  })
  .pipe(z.record(z.string().length(3), z.number().positive()))

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PUBLIC_BASE_URL: z.string().url(),
  CORS_ORIGINS: csv,
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  SENSITIVE_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),

  DATABASE_URL: z.string().min(1),

  // Admin API keys accepted in the x-api-key header (comma separated)
  ADMIN_API_KEYS: csv,
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRATION: z.string().default('7d'),
  // 32-byte key (hex or base64) used to encrypt anchor JWTs at rest
  ENCRYPTION_KEY: z.string().min(32),

  // Stellar network
  STELLAR_NETWORK_PASSPHRASE: z.string().min(1),
  STELLAR_RPC_URL: z.string().url(),
  STELLAR_HORIZON_URL: z.string().url(),
  STELLAR_RPC_AUTH_HEADER_NAME: z.string().optional(),
  STELLAR_RPC_AUTH_HEADER_VALUE: z.string().optional(),
  STELLAR_TX_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(60),
  // Inclusive fee bid for the inner (relayer-sourced) transaction, in stroops
  STELLAR_BASE_FEE: z.coerce.number().int().positive().default(100),

  // Contracts
  ACCOUNT_CONTRACT_ID: contractId,
  SUBSIDY_CONTRACT_ID: contractId,
  // Optional comma-separated list of extra contracts users may invoke through the relay
  RELAY_ALLOWED_CONTRACTS: csv,

  // Keys
  RELAYER_SECRET_KEY: stellarSecret,
  PAYMASTER_SECRET_KEY: stellarSecret,

  // Paymaster policy
  PAYMASTER_MAX_FEE_STROOPS: z.coerce.number().int().positive().default(5_000_000),
  PAYMASTER_DAILY_BUDGET_STROOPS: z.coerce.number().int().positive().default(50_000_000),
  PAYMASTER_ENFORCE_SUBSIDY: bool,

  // WebAuthn
  WEBAUTHN_RP_NAME: z.string().default('RemitPulse'),
  WEBAUTHN_RP_ID: z.string().min(1),
  WEBAUTHN_ORIGINS: csv.refine(list => list.length > 0, 'at least one origin is required'),
  WEBAUTHN_CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  // Session keys (amounts in whole token units, e.g. "25" = 25 USDC)
  SESSION_KEY_MAX_PER_TX: z.string().default('25'),
  SESSION_KEY_MAX_TOTAL: z.string().default('200'),
  SESSION_KEY_MAX_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(7 * 24 * 3600),

  // SEP-10 / SEP-24
  SEP10_CLIENT_DOMAIN: z.string().optional(),
  SEP10_CLIENT_DOMAIN_SECRET: stellarSecret.optional(),
  SEP10_HOME_DOMAIN: z.string().min(1).default('remitpulse.app'),
  ANCHOR_ALLOW_HTTP: bool,
  ANCHOR_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // Reject SEP-24 callbacks without a valid anchor signature
  WEBHOOK_REQUIRE_SIGNATURE: bool.default(true),
  WEBHOOK_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(300),
  // Background poller for remittance transactions stuck in a non-terminal state
  REMITTANCE_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  REMITTANCE_POLL_STALE_AFTER_SECONDS: z.coerce.number().int().positive().default(120),
  REMITTANCE_POLL_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  // HMAC key used to deterministically derive a per-user custodial Ed25519 account for
  // SEP-10 / SEP-24 anchor rails. Not related to RELAYER_SECRET_KEY or the user's smart wallet.
  ANCHOR_CUSTODY_SEED: z.string().min(32),

  // FX
  // 'sep38' fetches live per-corridor quotes from the corridor anchor's SEP-38 quote server
  // (the ANCHOR_QUOTE_SERVER advertised in its stellar.toml). A missing/unreachable quote
  // server is a hard error — it never silently falls back to FX_STATIC_RATES.
  FX_PROVIDER: z.enum(['static', 'sep38', 'http']).default('static'),
  // JSON map of fiat code -> units per 1 USD, used by the static provider and as a fallback
  FX_STATIC_RATES: staticRates,
  // HTTP provider: GET {FX_REFERENCE_URL}?base=USD returns { rates: { EUR: 0.92, ... } }
  FX_REFERENCE_URL: z.string().url().optional(),
  FX_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60),

  SENTRY_DSN: z.string().optional(),
})

export type Env = z.infer<typeof EnvSchema>

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  return parsed.data
}

export const env = loadEnv()

export const isTest = env.NODE_ENV === 'test'
export const isProduction = env.NODE_ENV === 'production'
