import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'

import { Account, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Sep10 from '../src/interfaces/anchors/sep10'
import type * as Sep24 from '../src/interfaces/anchors/sep24'
import type * as Toml from '../src/interfaces/anchors/toml'

process.env.ANCHOR_ALLOW_HTTP ??= 'true'

const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'
const HOME_DOMAIN = 'remitpulse.app'

// ---------------------------------------------------------------------------
// Mock anchor server
// ---------------------------------------------------------------------------

type ChallengeTimeBounds = 'missing' | 'expired' | 'too-long' | 'valid'

interface MockAnchorState {
  signingKeypair: Keypair
  challengeExpired: boolean
  challengeTimeBounds: ChallengeTimeBounds
  verifyShouldFail: boolean
  depositInteractiveShouldFail: boolean
  withdrawInteractiveShouldFail: boolean
  transactionShouldFail: boolean
  lastTransactionId: string
  lastDepositRequest: unknown
  lastWithdrawRequest: unknown
}

const state: MockAnchorState = {
  signingKeypair: Keypair.random(),
  challengeExpired: false,
  challengeTimeBounds: 'valid',
  verifyShouldFail: false,
  depositInteractiveShouldFail: false,
  withdrawInteractiveShouldFail: false,
  transactionShouldFail: false,
  lastTransactionId: 'tx-123',
  lastDepositRequest: null,
  lastWithdrawRequest: null,
}

function resetState() {
  state.challengeExpired = false
  state.challengeTimeBounds = 'valid'
  state.verifyShouldFail = false
  state.depositInteractiveShouldFail = false
  state.withdrawInteractiveShouldFail = false
  state.transactionShouldFail = false
  state.lastTransactionId = 'tx-123'
  state.lastDepositRequest = null
  state.lastWithdrawRequest = null
}

let server: Server
let baseUrl: string
let anchorDomain: string

function buildToml(): string {
  return [
    'VERSION="2.0.0"',
    `NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE}"`,
    `SIGNING_KEY="${state.signingKeypair.publicKey()}"`,
    `WEB_AUTH_ENDPOINT="${baseUrl}/auth"`,
    `TRANSFER_SERVER_SEP0024="${baseUrl}/sep24"`,
  ].join('\n')
}

/** Builds a syntactically valid SEP-10 challenge transaction for `clientAccount`. */
function buildChallengeXdr(clientAccount: string, timeBounds: ChallengeTimeBounds = state.challengeTimeBounds): string {
  const source = new Account(state.signingKeypair.publicKey(), '-1')
  const builder = new TransactionBuilder(source, { fee: '100', networkPassphrase: NETWORK_PASSPHRASE }).addOperation(
    Operation.manageData({ name: `${HOME_DOMAIN} auth`, value: randomBytes(64), source: clientAccount })
  )

  const now = Math.floor(Date.now() / 1000)
  switch (timeBounds) {
    case 'missing':
      // No time bounds at all.
      break
    case 'expired':
      builder.setTimebounds(now - 3600, now - 1800)
      break
    case 'too-long':
      builder.setTimebounds(now, now + 7 * 24 * 3600)
      break
    case 'valid':
      builder.setTimebounds(now, now + 15 * 60)
      break
  }

  const tx = builder.build()
  tx.sign(state.signingKeypair)
  return tx.toXDR()
}

function startMockAnchor(): Promise<void> {
  const app = express()
  app.use(express.json())
  app.use(express.urlencoded({ extended: true }))

  app.get('/.well-known/stellar.toml', (_req, res) => {
    res.type('text/plain').send(buildToml())
  })

  app.get('/auth', (req, res) => {
    const account = req.query.account as string | undefined
    if (!account) {
      res.status(400).json({ error: 'missing account' })
      return
    }
    if (state.challengeExpired) {
      res.status(400).json({ error: 'challenge expired' })
      return
    }
    res.json({ transaction: buildChallengeXdr(account), network_passphrase: NETWORK_PASSPHRASE })
  })

  app.post('/auth', (_req, res) => {
    if (state.verifyShouldFail) {
      res.status(400).json({ error: 'invalid signature' })
      return
    }
    // A JWT so `authenticateWithAnchor`'s jwt.decode(...) doesn't throw.
    const token = [
      Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
      Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'),
      'sig',
    ].join('.')
    res.json({ token })
  })

  app.post('/sep24/transactions/deposit/interactive', (req, res) => {
    state.lastDepositRequest = req.body
    if (state.depositInteractiveShouldFail) {
      res.status(500).json({ error: 'anchor exploded' })
      return
    }
    res.json({ type: 'interactive_customer_info_needed', url: `${baseUrl}/interactive/deposit`, id: 'deposit-1' })
  })

  app.post('/sep24/transactions/withdraw/interactive', (req, res) => {
    state.lastWithdrawRequest = req.body
    if (state.withdrawInteractiveShouldFail) {
      res.status(500).json({ error: 'anchor exploded' })
      return
    }
    res.json({ type: 'interactive_customer_info_needed', url: `${baseUrl}/interactive/withdraw`, id: 'withdraw-1' })
  })

  app.get('/sep24/transaction', (req, res) => {
    if (state.transactionShouldFail) {
      res.status(500).json({ error: 'anchor exploded' })
      return
    }
    const id = (req.query.id as string) || state.lastTransactionId
    res.json({
      transaction: {
        id,
        kind: 'withdrawal',
        status: 'completed',
        amount_in: '10.00',
        amount_out: '9.90',
        amount_fee: '0.10',
        message: 'ok',
      },
    })
  })

  return new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        baseUrl = `http://127.0.0.1:${addr.port}`
        anchorDomain = `127.0.0.1:${addr.port}`
      }
      resolve()
    })
  })
}

function stopMockAnchor(): Promise<void> {
  return new Promise(resolve => {
    if (server) server.close(() => resolve())
    else resolve()
  })
}

// ---------------------------------------------------------------------------
// Module imports (after env setup / mock server start)
// ---------------------------------------------------------------------------

let authenticateWithAnchor: typeof Sep10.authenticateWithAnchor
let startDeposit: typeof Sep24.startDeposit
let startWithdrawal: typeof Sep24.startWithdrawal
let fetchTransaction: typeof Sep24.fetchTransaction
let verifyWebhookSignature: typeof Sep24.verifyWebhookSignature
let invalidateAnchorTomlCache: typeof Toml.invalidateAnchorTomlCache

beforeAll(async () => {
  await startMockAnchor()

  const sep10 = await import('../src/interfaces/anchors/sep10')
  const sep24 = await import('../src/interfaces/anchors/sep24')
  const toml = await import('../src/interfaces/anchors/toml')

  authenticateWithAnchor = sep10.authenticateWithAnchor
  startDeposit = sep24.startDeposit
  startWithdrawal = sep24.startWithdrawal
  fetchTransaction = sep24.fetchTransaction
  verifyWebhookSignature = sep24.verifyWebhookSignature
  invalidateAnchorTomlCache = toml.invalidateAnchorTomlCache
})

afterAll(async () => {
  await stopMockAnchor()
})

beforeEach(() => {
  resetState()
  invalidateAnchorTomlCache()
})

// ---------------------------------------------------------------------------
// SEP-10 authentication
// ---------------------------------------------------------------------------

describe('SEP-10 authentication', () => {
  it('authenticates against the mock anchor (happy path)', async () => {
    const userKeypair = Keypair.random()
    const result = await authenticateWithAnchor(anchorDomain, userKeypair)

    expect(result).toBeDefined()
    expect(typeof result.token).toBe('string')
    expect(result.expiresAt).toBeInstanceOf(Date)
  })

  it('fails when the challenge is expired', async () => {
    state.challengeExpired = true
    const userKeypair = Keypair.random()

    await expect(authenticateWithAnchor(anchorDomain, userKeypair)).rejects.toThrow()
  })

  it('fails when the anchor rejects the signed challenge', async () => {
    state.verifyShouldFail = true
    const userKeypair = Keypair.random()

    await expect(authenticateWithAnchor(anchorDomain, userKeypair)).rejects.toThrow()
  })

  it('rejects a challenge with no time bounds', async () => {
    state.challengeTimeBounds = 'missing'
    const userKeypair = Keypair.random()

    await expect(authenticateWithAnchor(anchorDomain, userKeypair)).rejects.toThrow(/time bounds/i)
  })

  it('rejects a challenge whose time bounds are already expired', async () => {
    state.challengeTimeBounds = 'expired'
    const userKeypair = Keypair.random()

    await expect(authenticateWithAnchor(anchorDomain, userKeypair)).rejects.toThrow(/time bounds/i)
  })

  it('rejects a challenge with an implausibly long validity window', async () => {
    state.challengeTimeBounds = 'too-long'
    const userKeypair = Keypair.random()

    await expect(authenticateWithAnchor(anchorDomain, userKeypair)).rejects.toThrow(/time bounds/i)
  })

  it('accepts a challenge with a valid ~15 minute window', async () => {
    state.challengeTimeBounds = 'valid'
    const userKeypair = Keypair.random()

    const result = await authenticateWithAnchor(anchorDomain, userKeypair)
    expect(result).toBeDefined()
    expect(typeof result.token).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// SEP-24 deposit / withdraw / transaction
// ---------------------------------------------------------------------------

describe('SEP-24 flows', () => {
  it('starts a deposit (happy path)', async () => {
    const result = await startDeposit(anchorDomain, 'mock-sep10-token', {
      assetCode: 'USDC',
      account: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    })

    expect(result).toBeDefined()
    expect(result.url).toContain('/interactive/deposit')
    expect(result.id).toBe('deposit-1')
    expect(state.lastDepositRequest).toBeTruthy()
  })

  it('surfaces a 5xx from the deposit endpoint', async () => {
    state.depositInteractiveShouldFail = true

    await expect(
      startDeposit(anchorDomain, 'mock-sep10-token', {
        assetCode: 'USDC',
        account: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      })
    ).rejects.toThrow()
  })

  it('starts a withdrawal (happy path)', async () => {
    const result = await startWithdrawal(anchorDomain, 'mock-sep10-token', {
      assetCode: 'USDC',
      account: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      amount: '10.00',
    })

    expect(result).toBeDefined()
    expect(result.url).toContain('/interactive/withdraw')
    expect(result.id).toBe('withdraw-1')
    expect(state.lastWithdrawRequest).toBeTruthy()
  })

  it('surfaces a 5xx from the withdraw endpoint', async () => {
    state.withdrawInteractiveShouldFail = true

    await expect(
      startWithdrawal(anchorDomain, 'mock-sep10-token', {
        assetCode: 'USDC',
        account: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        amount: '10.00',
      })
    ).rejects.toThrow()
  })

  it('fetches a transaction (happy path)', async () => {
    const result = await fetchTransaction(anchorDomain, 'mock-sep10-token', 'tx-123')

    expect(result).toBeDefined()
    expect(result.id).toBe('tx-123')
    expect(result.status).toBe('completed')
  })

  it('surfaces a 5xx from the transaction endpoint', async () => {
    state.transactionShouldFail = true

    await expect(fetchTransaction(anchorDomain, 'mock-sep10-token', 'tx-123')).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

describe('verifyWebhookSignature', () => {
  function signHeader(payload: string, keypair: Keypair, timestamp = Math.floor(Date.now() / 1000)): string {
    const signature = keypair.sign(Buffer.from(`${timestamp}.${payload}`))
    return `t=${timestamp}, s=${signature.toString('base64')}`
  }

  it('accepts a valid signature from the anchor signing key', async () => {
    const payload = JSON.stringify({ id: 'tx-123', status: 'completed' })
    const header = signHeader(payload, state.signingKeypair)

    await expect(verifyWebhookSignature(anchorDomain, Buffer.from(payload), header)).resolves.toBeUndefined()
  })

  it('rejects a signature from the wrong key', async () => {
    const payload = JSON.stringify({ id: 'tx-123', status: 'completed' })
    const header = signHeader(payload, Keypair.random())

    await expect(verifyWebhookSignature(anchorDomain, Buffer.from(payload), header)).rejects.toThrow()
  })

  it('rejects a tampered payload', async () => {
    const payload = JSON.stringify({ id: 'tx-123', status: 'completed' })
    const header = signHeader(payload, state.signingKeypair)
    const tampered = JSON.stringify({ id: 'tx-123', status: 'failed' })

    await expect(verifyWebhookSignature(anchorDomain, Buffer.from(tampered), header)).rejects.toThrow()
  })

  it('rejects a missing Signature header', async () => {
    const payload = JSON.stringify({ id: 'tx-123', status: 'completed' })

    await expect(verifyWebhookSignature(anchorDomain, Buffer.from(payload), undefined)).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Remittance poller
// ---------------------------------------------------------------------------

describe('remittance poller', () => {
  it('refreshes a stale non-terminal transaction within one tick', async () => {
    const { runRemittancePollTick } = await import('../src/jobs/remittance-poller')

    const staleTx = { id: 'rem-1', status: 'pending_anchor', updatedAt: new Date(Date.now() - 10 * 60 * 1000) }

    const findMany = vi.fn().mockResolvedValue([staleTx])
    const prisma = { remittanceTransaction: { findMany } } as any

    const syncSpy = vi.fn().mockResolvedValue(undefined)

    await runRemittancePollTick({ prisma, syncTransaction: syncSpy, staleAfterSeconds: 60, batchSize: 10 })

    expect(findMany).toHaveBeenCalledTimes(1)
    expect(syncSpy).toHaveBeenCalledTimes(1)
    expect(syncSpy).toHaveBeenCalledWith('rem-1')
  })

  it('does not abort the batch when one transaction fails to sync', async () => {
    const { runRemittancePollTick } = await import('../src/jobs/remittance-poller')

    const txs = [
      { id: 'rem-1', status: 'pending_anchor', updatedAt: new Date(0) },
      { id: 'rem-2', status: 'pending_user_transfer', updatedAt: new Date(0) },
      { id: 'rem-3', status: 'pending_anchor', updatedAt: new Date(0) },
    ]

    const findMany = vi.fn().mockResolvedValue(txs)
    const prisma = { remittanceTransaction: { findMany } } as any

    const syncSpy = vi.fn().mockImplementation(async (id: string) => {
      if (id === 'rem-2') throw new Error('anchor exploded')
    })

    await expect(runRemittancePollTick({ prisma, syncTransaction: syncSpy, staleAfterSeconds: 60, batchSize: 10 })).resolves.toBeUndefined()

    expect(syncSpy).toHaveBeenCalledTimes(3)
    expect(syncSpy).toHaveBeenCalledWith('rem-1')
    expect(syncSpy).toHaveBeenCalledWith('rem-2')
    expect(syncSpy).toHaveBeenCalledWith('rem-3')
  })

  it('queries only non-terminal transactions older than the stale threshold', async () => {
    const { runRemittancePollTick } = await import('../src/jobs/remittance-poller')

    const findMany = vi.fn().mockResolvedValue([])
    const prisma = { remittanceTransaction: { findMany } } as any

    const syncSpy = vi.fn()

    await runRemittancePollTick({ prisma, syncTransaction: syncSpy, staleAfterSeconds: 120, batchSize: 5 })

    expect(findMany).toHaveBeenCalledTimes(1)
    const args = findMany.mock.calls[0][0]
    expect(args.where.status.notIn).toEqual(['completed', 'failed'])
    expect(args.where.updatedAt.lt).toBeInstanceOf(Date)
    expect(args.take).toBe(5)
    expect(syncSpy).not.toHaveBeenCalled()
  })
})
