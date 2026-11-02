import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type * as Sep24 from '../src/interfaces/anchors/sep24'
import { prisma } from '../src/config/database'

vi.mock('../src/interfaces/anchors/sep24', async importOriginal => {
  const actual = await importOriginal<typeof Sep24>()
  return { ...actual, verifyWebhookSignature: vi.fn().mockResolvedValue(undefined) }
})

const userId = randomUUID()
const corridorCode = `AST${randomUUID().slice(0, 4).toUpperCase()}`
let corridorId: string

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } })
  const corridor = await prisma.corridor.create({
    data: {
      code: corridorCode,
      name: 'Anchor Service Test Corridor',
      assetCode: corridorCode,
      assetIssuer: 'GCUZ37M45SEMGYFYYZE7IBTS3ISKGPDLFRNHS73ORSTMNYM64NLEQO76',
      fiatCurrency: 'USD',
      anchorDomain: 'testanchor.stellar.org',
    },
  })
  corridorId = corridor.id
})

afterAll(async () => {
  await prisma.remittanceTransaction.deleteMany({ where: { userId } })
  await prisma.corridor.deleteMany({ where: { code: corridorCode } })
  await prisma.user.delete({ where: { id: userId } })
})

async function createTransaction(status: 'incomplete' | 'pending_anchor' | 'completed' | 'failed', anchorTxId: string) {
  return prisma.remittanceTransaction.create({
    data: {
      userId,
      corridorId,
      kind: 'deposit',
      account: 'GCUZ37M45SEMGYFYYZE7IBTS3ISKGPDLFRNHS73ORSTMNYM64NLEQO76',
      anchorTxId,
      status,
      anchorStatus: status,
    },
  })
}

describe('handleWebhook status transitions', () => {
  it('applies a forward transition from a non-terminal status', async () => {
    const { handleWebhook } = await import('../src/api/anchors/service')
    const tx = await createTransaction('pending_anchor', `fwd-${randomUUID()}`)

    const payload = JSON.stringify({ transaction: { id: tx.anchorTxId, kind: 'deposit', status: 'completed' } })
    await handleWebhook(corridorCode, Buffer.from(payload), 'irrelevant-because-mocked')

    const updated = await prisma.remittanceTransaction.findUniqueOrThrow({ where: { id: tx.id } })
    expect(updated.status).toBe('completed')
  })

  it('ignores a webhook that would roll a terminal (completed) transaction backward', async () => {
    const { handleWebhook } = await import('../src/api/anchors/service')
    const tx = await createTransaction('completed', `replay-${randomUUID()}`)

    const payload = JSON.stringify({ transaction: { id: tx.anchorTxId, kind: 'deposit', status: 'pending_anchor' } })
    await handleWebhook(corridorCode, Buffer.from(payload), 'irrelevant-because-mocked')

    const updated = await prisma.remittanceTransaction.findUniqueOrThrow({ where: { id: tx.id } })
    expect(updated.status).toBe('completed')

    const events = await prisma.remittanceEvent.findMany({ where: { transactionId: tx.id } })
    expect(events).toHaveLength(0)
  })

  it('ignores a webhook that would roll a terminal (failed) transaction forward to a non-terminal status', async () => {
    const { handleWebhook } = await import('../src/api/anchors/service')
    const tx = await createTransaction('failed', `replay-failed-${randomUUID()}`)

    const payload = JSON.stringify({ transaction: { id: tx.anchorTxId, kind: 'deposit', status: 'pending_user_transfer_start' } })
    await handleWebhook(corridorCode, Buffer.from(payload), 'irrelevant-because-mocked')

    const updated = await prisma.remittanceTransaction.findUniqueOrThrow({ where: { id: tx.id } })
    expect(updated.status).toBe('failed')
  })
})

describe('expireTransaction', () => {
  it('marks a non-terminal transaction as failed', async () => {
    const { expireTransaction } = await import('../src/api/anchors/service')
    const tx = await createTransaction('pending_anchor', `expire-${randomUUID()}`)

    const updated = await expireTransaction(tx.id)

    expect(updated.status).toBe('failed')
    expect(updated.statusMessage).toMatch(/expired/i)
  })

  it('is a no-op on an already-terminal transaction', async () => {
    const { expireTransaction } = await import('../src/api/anchors/service')
    const tx = await createTransaction('completed', `expire-noop-${randomUUID()}`)

    await expireTransaction(tx.id)

    const updated = await prisma.remittanceTransaction.findUniqueOrThrow({ where: { id: tx.id } })
    expect(updated.status).toBe('completed')
    expect(updated.statusMessage).toBeNull()
  })
})
