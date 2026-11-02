import { randomUUID } from 'node:crypto'

import { Account, Contract, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk'
import type { FeeBumpTransaction } from '@stellar/stellar-sdk'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { prisma } from '../src/config/database'
import { env } from '../src/config/env'
import { STELLAR } from '../src/config/stellar'
import { ForbiddenError, TooManyRequestsError } from '../src/errors'
import { Paymaster } from '../src/interfaces/paymaster'
import type { SorobanService } from '../src/interfaces/soroban'

const ALLOWED_CONTRACT = env.ACCOUNT_CONTRACT_ID
const OTHER_CONTRACT = env.SUBSIDY_CONTRACT_ID

function buildInner(overrides: { source?: string; fee?: string; networkPassphrase?: string; sign?: boolean; contractId?: string } = {}) {
  const sourceKeypair = Keypair.random()
  const source = new Account(overrides.source ?? sourceKeypair.publicKey(), '100')
  const op = new Contract(overrides.contractId ?? ALLOWED_CONTRACT).call('transfer')
  const tx = new TransactionBuilder(source, {
    fee: overrides.fee ?? '1000',
    networkPassphrase: overrides.networkPassphrase ?? STELLAR.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(60)
    .build()
  if (overrides.sign !== false) tx.sign(sourceKeypair)
  return tx
}

describe('Paymaster.assertSponsorable', () => {
  const paymaster = new Paymaster()
  const allowed = new Set([ALLOWED_CONTRACT])

  it('rejects an already fee-bumped transaction', () => {
    const inner = buildInner()
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(STELLAR.paymaster, '2000', inner, STELLAR.networkPassphrase)
    expect(() => paymaster.assertSponsorable(feeBump as unknown as FeeBumpTransaction, allowed)).toThrow(/already fee-bumped/i)
  })

  it('rejects a transaction built for a different network', () => {
    const inner = buildInner({ networkPassphrase: 'Some Other Network ; 2024' })
    expect(() => paymaster.assertSponsorable(inner, allowed)).toThrow(/different network/i)
  })

  it('rejects the paymaster itself as the inner transaction source', () => {
    const inner = buildInner({ source: STELLAR.paymaster.publicKey(), sign: false })
    inner.sign(STELLAR.paymaster)
    expect(() => paymaster.assertSponsorable(inner, allowed)).toThrow(ForbiddenError)
  })

  it('rejects a transaction with more than one operation', () => {
    const sourceKeypair = Keypair.random()
    const source = new Account(sourceKeypair.publicKey(), '100')
    const tx = new TransactionBuilder(source, { fee: '1000', networkPassphrase: STELLAR.networkPassphrase })
      .addOperation(new Contract(ALLOWED_CONTRACT).call('transfer'))
      .addOperation(new Contract(ALLOWED_CONTRACT).call('transfer'))
      .setTimeout(60)
      .build()
    tx.sign(sourceKeypair)
    expect(() => paymaster.assertSponsorable(tx, allowed)).toThrow(/single InvokeHostFunction/i)
  })

  it('rejects a non-InvokeHostFunction operation', () => {
    const sourceKeypair = Keypair.random()
    const source = new Account(sourceKeypair.publicKey(), '100')
    const tx = new TransactionBuilder(source, { fee: '1000', networkPassphrase: STELLAR.networkPassphrase })
      .addOperation(Operation.bumpSequence({ bumpTo: '101' }))
      .setTimeout(60)
      .build()
    tx.sign(sourceKeypair)
    expect(() => paymaster.assertSponsorable(tx, allowed)).toThrow(/single InvokeHostFunction/i)
  })

  it('rejects a contract that is not in the allow-list', () => {
    const inner = buildInner({ contractId: OTHER_CONTRACT })
    expect(() => paymaster.assertSponsorable(inner, allowed)).toThrow(ForbiddenError)
  })

  it('rejects a fee above PAYMASTER_MAX_FEE_STROOPS', () => {
    const inner = buildInner({ fee: String(env.PAYMASTER_MAX_FEE_STROOPS + 1) })
    expect(() => paymaster.assertSponsorable(inner, allowed)).toThrow(/exceeds sponsorship cap/i)
  })

  it('rejects an unsigned inner transaction', () => {
    const inner = buildInner({ sign: false })
    expect(() => paymaster.assertSponsorable(inner, allowed)).toThrow(/must be signed/i)
  })

  it('accepts a well-formed, signed, allowed, in-budget transaction', () => {
    const inner = buildInner({ fee: String(env.PAYMASTER_MAX_FEE_STROOPS - 1) })
    expect(() => paymaster.assertSponsorable(inner, allowed)).not.toThrow()
  })
})

describe('Paymaster.wrap', () => {
  const paymaster = new Paymaster()

  it('produces a fee-bump signed by the paymaster', () => {
    const inner = buildInner({ fee: '1000' })
    const feeBump = paymaster.wrap(inner)
    expect(feeBump.feeSource).toBe(STELLAR.paymaster.publicKey())
    expect(feeBump.innerTransaction.hash().toString('hex')).toBe(inner.hash().toString('hex'))
    expect(feeBump.signatures.length).toBeGreaterThan(0)
  })

  it('throws if the resulting fee-bump fee would exceed 2x the sponsorship cap', () => {
    const inner = buildInner({ fee: String(env.PAYMASTER_MAX_FEE_STROOPS + 1) })
    expect(() => paymaster.wrap(inner)).toThrow(/fee-bump fee exceeds sponsorship cap/i)
  })
})

describe('Paymaster.sponsor / spentLast24h (DB-backed)', () => {
  const userIds: string[] = []

  afterAll(async () => {
    await prisma.sponsoredTransaction.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  })

  async function makeUser(): Promise<string> {
    const id = randomUUID()
    await prisma.user.create({ data: { id, email: `${id}@example.com` } })
    userIds.push(id)
    return id
  }

  it('sponsors an in-budget transaction, calls soroban.send, and records a succeeded row', async () => {
    const userId = await makeUser()
    const send = vi.fn().mockResolvedValue({ hash: 'tx-hash-ok', ledger: 12345, feeCharged: 900n })
    const paymaster = new Paymaster({ send } as unknown as SorobanService)
    const inner = buildInner({ fee: '1000' })

    const result = await paymaster.sponsor(inner, { userId, allowedContracts: new Set([ALLOWED_CONTRACT]) })

    expect(send).toHaveBeenCalledTimes(1)
    expect(result.hash).toBe('tx-hash-ok')
    expect(result.innerHash).toBe(inner.hash().toString('hex'))

    const row = await prisma.sponsoredTransaction.findUniqueOrThrow({ where: { innerHash: inner.hash().toString('hex') } })
    expect(row.status).toBe('succeeded')
    expect(row.feeCharged).toBe(900n)

    expect(await paymaster.spentLast24h(userId)).toBe(900n)
  })

  it('throws TooManyRequestsError and never calls soroban.send once the daily budget is exhausted', async () => {
    const userId = await makeUser()
    const budget = BigInt(env.PAYMASTER_DAILY_BUDGET_STROOPS)
    const existingInner = buildInner({ fee: '1000' })
    await prisma.sponsoredTransaction.create({
      data: {
        userId,
        innerHash: existingInner.hash().toString('hex'),
        feeBumpHash: `prior-${randomUUID()}`,
        maxFee: budget,
        feeCharged: budget,
        status: 'succeeded',
      },
    })

    const send = vi.fn().mockResolvedValue({ hash: 'should-not-be-called', ledger: 1 })
    const paymaster = new Paymaster({ send } as unknown as SorobanService)
    const inner = buildInner({ fee: '100' })

    await expect(paymaster.sponsor(inner, { userId, allowedContracts: new Set([ALLOWED_CONTRACT]) })).rejects.toThrow(TooManyRequestsError)
    expect(send).not.toHaveBeenCalled()
  })

  it('records a failed row (and excludes it from spentLast24h) when soroban.send rejects', async () => {
    const userId = await makeUser()
    const send = vi.fn().mockRejectedValue(new Error('network blip'))
    const paymaster = new Paymaster({ send } as unknown as SorobanService)
    const inner = buildInner({ fee: '1000' })

    await expect(paymaster.sponsor(inner, { userId, allowedContracts: new Set([ALLOWED_CONTRACT]) })).rejects.toThrow('network blip')

    const row = await prisma.sponsoredTransaction.findUniqueOrThrow({ where: { innerHash: inner.hash().toString('hex') } })
    expect(row.status).toBe('failed')
    expect(row.error).toBe('network blip')

    expect(await paymaster.spentLast24h(userId)).toBe(0n)
  })
})
