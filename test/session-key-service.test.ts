import { randomBytes, randomUUID } from 'node:crypto'

import { Keypair, StrKey } from '@stellar/stellar-sdk'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { SessionKeyService } from '../src/api/session-keys/service'
import { prisma } from '../src/config/database'
import { env } from '../src/config/env'
import { toBaseUnits } from '../src/lib/money'

function fakeContractId(): string {
  return StrKey.encodeContract(randomBytes(32))
}

function makeFakeInvocations(allowed: Set<string>) {
  return {
    prepare: vi.fn().mockResolvedValue({ invocationId: randomUUID() }),
    allowedContracts: vi.fn().mockResolvedValue(allowed),
  }
}

function makeFakeSoroban(validUntilLedger = 1000) {
  return { validUntilLedger: vi.fn().mockResolvedValue(validUntilLedger) }
}

const userIds: string[] = []

async function createUser(contractAddress?: string) {
  const id = randomUUID()
  userIds.push(id)
  await prisma.user.create({ data: { id, email: `${id}@example.com`, contractAddress } })
  return id
}

afterAll(async () => {
  await prisma.sessionKey.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
})

describe('SessionKeyService.issue', () => {
  const token = fakeContractId()

  it('rejects a perTxLimit above the configured maximum', async () => {
    const userId = await createUser(fakeContractId())
    const service = new SessionKeyService(makeFakeInvocations(new Set([token])) as any, makeFakeSoroban() as any)

    await expect(
      service.issue(userId, {
        publicKey: Keypair.random().publicKey(),
        tokenContract: token,
        perTxLimit: String(Number(env.SESSION_KEY_MAX_PER_TX) + 1),
        totalLimit: env.SESSION_KEY_MAX_TOTAL,
        ttlSeconds: 3600,
      })
    ).rejects.toMatchObject({ code: 'SESSION_KEY_LIMIT' })
  })

  it('rejects a totalLimit above the configured maximum', async () => {
    const userId = await createUser(fakeContractId())
    const service = new SessionKeyService(makeFakeInvocations(new Set([token])) as any, makeFakeSoroban() as any)

    await expect(
      service.issue(userId, {
        publicKey: Keypair.random().publicKey(),
        tokenContract: token,
        perTxLimit: env.SESSION_KEY_MAX_PER_TX,
        totalLimit: String(Number(env.SESSION_KEY_MAX_TOTAL) + 1),
        ttlSeconds: 3600,
      })
    ).rejects.toMatchObject({ code: 'SESSION_KEY_LIMIT' })
  })

  it('rejects a perTxLimit greater than totalLimit', async () => {
    const userId = await createUser(fakeContractId())
    const service = new SessionKeyService(makeFakeInvocations(new Set([token])) as any, makeFakeSoroban() as any)

    await expect(
      service.issue(userId, {
        publicKey: Keypair.random().publicKey(),
        tokenContract: token,
        perTxLimit: '10',
        totalLimit: '5',
        ttlSeconds: 3600,
      })
    ).rejects.toThrow('perTxLimit cannot exceed totalLimit')
  })

  it('rejects a ttlSeconds above the configured maximum', async () => {
    const userId = await createUser(fakeContractId())
    const service = new SessionKeyService(makeFakeInvocations(new Set([token])) as any, makeFakeSoroban() as any)

    await expect(
      service.issue(userId, {
        publicKey: Keypair.random().publicKey(),
        tokenContract: token,
        perTxLimit: '1',
        totalLimit: '2',
        ttlSeconds: env.SESSION_KEY_MAX_TTL_SECONDS + 1,
      })
    ).rejects.toMatchObject({ code: 'SESSION_KEY_LIMIT' })
  })

  it('rejects when the wallet has not been deployed', async () => {
    const userId = await createUser(undefined)
    const service = new SessionKeyService(makeFakeInvocations(new Set([token])) as any, makeFakeSoroban() as any)

    await expect(
      service.issue(userId, {
        publicKey: Keypair.random().publicKey(),
        tokenContract: token,
        perTxLimit: '1',
        totalLimit: '2',
        ttlSeconds: 3600,
      })
    ).rejects.toMatchObject({ code: 'WALLET_NOT_DEPLOYED' })
  })

  it('rejects a token that is not in the allow-list', async () => {
    const userId = await createUser(fakeContractId())
    const service = new SessionKeyService(makeFakeInvocations(new Set(['someOtherContract'])) as any, makeFakeSoroban() as any)

    await expect(
      service.issue(userId, {
        publicKey: Keypair.random().publicKey(),
        tokenContract: token,
        perTxLimit: '1',
        totalLimit: '2',
        ttlSeconds: 3600,
      })
    ).rejects.toThrow('Token is not supported for session keys')
  })

  it('rejects a duplicate publicKey', async () => {
    const userId = await createUser(fakeContractId())
    const publicKey = Keypair.random().publicKey()
    await prisma.sessionKey.create({
      data: {
        userId,
        publicKey,
        tokenContract: token,
        perTxLimit: '10000000',
        totalLimit: '20000000',
        expiresAtLedger: 100,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    })
    const service = new SessionKeyService(makeFakeInvocations(new Set([token])) as any, makeFakeSoroban() as any)

    await expect(
      service.issue(userId, { publicKey, tokenContract: token, perTxLimit: '1', totalLimit: '2', ttlSeconds: 3600 })
    ).rejects.toMatchObject({
      statusCode: 409,
    })
  })

  it('creates a session key with correctly converted limits on the happy path', async () => {
    const userId = await createUser(fakeContractId())
    const invocations = makeFakeInvocations(new Set([token]))
    const soroban = makeFakeSoroban(777)
    const service = new SessionKeyService(invocations as any, soroban as any)
    const publicKey = Keypair.random().publicKey()

    const { sessionKey, invocation } = await service.issue(userId, {
      publicKey,
      tokenContract: token,
      perTxLimit: '5',
      totalLimit: '20',
      ttlSeconds: 3600,
    })

    expect(sessionKey.status).toBe('pending')
    expect(sessionKey.perTxLimit).toBe('5.0000000')
    expect(sessionKey.totalLimit).toBe('20.0000000')
    expect(invocation).toEqual({ invocationId: expect.any(String) })
    expect(invocations.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ userId, kind: 'session_key_register', signer: 'passkey', sessionKeyId: sessionKey.id })
    )

    const row = await prisma.sessionKey.findUniqueOrThrow({ where: { id: sessionKey.id } })
    expect(row.perTxLimit.toString()).toBe(toBaseUnits('5').toString())
    expect(row.totalLimit.toString()).toBe(toBaseUnits('20').toString())
    expect(row.expiresAtLedger).toBe(777)
  })
})

describe('SessionKeyService.revoke', () => {
  const token = fakeContractId()

  it('throws NotFoundError for a nonexistent key', async () => {
    const userId = await createUser(fakeContractId())
    const service = new SessionKeyService(makeFakeInvocations(new Set([token])) as any, makeFakeSoroban() as any)

    await expect(service.revoke(userId, randomUUID())).rejects.toMatchObject({ statusCode: 404 })
  })

  it("throws NotFoundError for another user's key", async () => {
    const owner = await createUser(fakeContractId())
    const intruder = await createUser(fakeContractId())
    const key = await prisma.sessionKey.create({
      data: {
        userId: owner,
        publicKey: Keypair.random().publicKey(),
        tokenContract: token,
        perTxLimit: '1',
        totalLimit: '2',
        expiresAtLedger: 1,
        expiresAt: new Date(Date.now() + 3600_000),
        status: 'active',
      },
    })
    const service = new SessionKeyService(makeFakeInvocations(new Set([token])) as any, makeFakeSoroban() as any)

    await expect(service.revoke(intruder, key.id)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('revokes an active key and prepares the on-chain revoke invocation', async () => {
    const userId = await createUser(fakeContractId())
    const key = await prisma.sessionKey.create({
      data: {
        userId,
        publicKey: Keypair.random().publicKey(),
        tokenContract: token,
        perTxLimit: '1',
        totalLimit: '2',
        expiresAtLedger: 1,
        expiresAt: new Date(Date.now() + 3600_000),
        status: 'active',
      },
    })
    const invocations = makeFakeInvocations(new Set([token]))
    const service = new SessionKeyService(invocations as any, makeFakeSoroban() as any)

    const { sessionKey, invocation } = await service.revoke(userId, key.id)

    expect(sessionKey.status).toBe('revoked')
    expect(invocation).not.toBeNull()
    expect(invocations.prepare).toHaveBeenCalledWith(expect.objectContaining({ kind: 'session_key_revoke', sessionKeyId: key.id }))

    const row = await prisma.sessionKey.findUniqueOrThrow({ where: { id: key.id } })
    expect(row.status).toBe('revoked')
  })

  it('revokes a pending (never-registered) key without preparing an on-chain revoke', async () => {
    const userId = await createUser(fakeContractId())
    const key = await prisma.sessionKey.create({
      data: {
        userId,
        publicKey: Keypair.random().publicKey(),
        tokenContract: token,
        perTxLimit: '1',
        totalLimit: '2',
        expiresAtLedger: 1,
        expiresAt: new Date(Date.now() + 3600_000),
        status: 'pending',
      },
    })
    const invocations = makeFakeInvocations(new Set([token]))
    const service = new SessionKeyService(invocations as any, makeFakeSoroban() as any)

    const { sessionKey, invocation } = await service.revoke(userId, key.id)

    expect(sessionKey.status).toBe('revoked')
    expect(invocation).toBeNull()
    expect(invocations.prepare).not.toHaveBeenCalled()
  })
})
