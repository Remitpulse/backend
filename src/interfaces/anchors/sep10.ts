import { Keypair, Transaction, TransactionBuilder } from '@stellar/stellar-sdk'
import jwt from 'jsonwebtoken'

import { env } from '../../config/env'
import { STELLAR } from '../../config/stellar'
import { UpstreamError } from '../../errors'
import { requestJson } from '../../lib/http-client'
import { getAnchorToml } from './toml'

type ChallengeResponse = { transaction: string; network_passphrase?: string }
type TokenResponse = { token: string }

/** SEP-10 recommends a short challenge validity window (default 15 minutes). */
const MAX_CHALLENGE_WINDOW_SECONDS = 900

/**
 * SEP-10 Web Authentication (classic accounts): fetches the anchor's challenge transaction,
 * signs it with the custody account (and, if configured, the wallet's client-domain key) and
 * exchanges it for a JWT. See https://stellar.org/protocol/sep-10.
 */
export async function authenticateWithAnchor(anchorDomain: string, account: Keypair): Promise<{ token: string; expiresAt: Date }> {
  const toml = await getAnchorToml(anchorDomain)
  if (!toml.webAuthEndpoint || !toml.signingKey) {
    throw new UpstreamError('anchor', `${anchorDomain} does not advertise WEB_AUTH_ENDPOINT / SIGNING_KEY`)
  }

  const challenge = await requestJson<ChallengeResponse>('anchor', toml.webAuthEndpoint, {
    query: {
      account: account.publicKey(),
      home_domain: env.SEP10_HOME_DOMAIN,
      client_domain: env.SEP10_CLIENT_DOMAIN,
    },
    timeoutMs: env.ANCHOR_REQUEST_TIMEOUT_MS,
  })

  const tx = parseChallenge(challenge.transaction, account.publicKey(), toml.signingKey)

  tx.sign(account)
  if (env.SEP10_CLIENT_DOMAIN_SECRET) tx.sign(Keypair.fromSecret(env.SEP10_CLIENT_DOMAIN_SECRET))

  const { token } = await requestJson<TokenResponse>('anchor', toml.webAuthEndpoint, {
    method: 'POST',
    json: { transaction: tx.toXDR(), network_passphrase: STELLAR.networkPassphrase },
    timeoutMs: env.ANCHOR_REQUEST_TIMEOUT_MS,
  })

  const claims = jwt.decode(token) as { exp?: number } | null
  const expiresAt = claims?.exp ? new Date(claims.exp * 1000) : new Date(Date.now() + 24 * 3600 * 1000)
  return { token, expiresAt }
}

/** Validates the anchor's challenge transaction before the caller signs it. */
function parseChallenge(xdrTx: string, account: string, anchorSigningKey: string): Transaction {
  let tx: Transaction | ReturnType<typeof TransactionBuilder.fromXDR>
  try {
    tx = TransactionBuilder.fromXDR(xdrTx, STELLAR.networkPassphrase)
  } catch {
    throw new UpstreamError('anchor', 'challenge transaction has invalid XDR')
  }
  if (!(tx instanceof Transaction)) throw new UpstreamError('anchor', 'challenge must not be a fee-bump transaction')
  if (tx.source !== anchorSigningKey) throw new UpstreamError('anchor', 'challenge source does not match stellar.toml SIGNING_KEY')
  if (tx.sequence !== '0') throw new UpstreamError('anchor', 'challenge transaction sequence must be 0')

  const first = tx.operations[0]
  if (!first || first.type !== 'manageData' || first.source !== account) {
    throw new UpstreamError('anchor', 'challenge first operation must be ManageData sourced by the client account')
  }
  if (first.name !== `${env.SEP10_HOME_DOMAIN} auth`) {
    throw new UpstreamError('anchor', `challenge home domain mismatch (expected "${env.SEP10_HOME_DOMAIN} auth")`)
  }
  const value = first.value
  if (!value || value.length !== 64) throw new UpstreamError('anchor', 'challenge nonce must be 64 random bytes')

  const timeBounds = tx.timeBounds
  if (!timeBounds) throw new UpstreamError('anchor', 'challenge transaction is missing time bounds')
  if (timeBounds.minTime === '0' || timeBounds.maxTime === '0' || timeBounds.maxTime === 'TimeoutInfinite') {
    throw new UpstreamError('anchor', 'challenge time bounds must be bounded (minTime and maxTime required)')
  }
  const minTime = Number(timeBounds.minTime)
  const maxTime = Number(timeBounds.maxTime)
  if (!Number.isFinite(minTime) || !Number.isFinite(maxTime)) {
    throw new UpstreamError('anchor', 'challenge time bounds are not valid unix timestamps')
  }
  const now = Math.floor(Date.now() / 1000)
  if (now < minTime) throw new UpstreamError('anchor', 'challenge is not yet valid (current time is before minTime)')
  if (now > maxTime) throw new UpstreamError('anchor', 'challenge has expired (current time is after maxTime)')
  if (maxTime - minTime > MAX_CHALLENGE_WINDOW_SECONDS) {
    throw new UpstreamError('anchor', `challenge validity window is too long (max ${MAX_CHALLENGE_WINDOW_SECONDS}s)`)
  }

  return tx
}
