import { randomBytes, randomUUID } from 'node:crypto'

import { Keypair, StrKey } from '@stellar/stellar-sdk'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { reserveSessionSpend, WalletService } from '../src/api/wallet/service'
import { prisma } from '../src/config/database'
import { toBaseUnits } from '../src/lib/money'

function fakeContractId(): string {
  return StrKey.encodeContract(randomBytes(32))
}

function makeFakeInvocations() {
  return {
    prepare: vi.fn().mockResolvedValue({ invocationId: randomUUID() }),
    submit: vi.fn().mockResolvedValue({ invocationId: randomUUID(), status: 'succeeded', txHash: 'hash-1' }),
    get: vi.fn(),
  }
}

const userIds: string[] = []

async function createUser(contractAddress?: string, withPasskey = false) {
  const id = randomUUID()
  userIds.push(id)
  await prisma.user.create({ data: { id, email: `${id}@example.com`, contractAddress } })
  if (withPasskey) {
    await prisma.passkey.create({
      data: {
        userId: id,
        credentialId: `cred-${id}`,
        credentialPublicKey: Buffer.from('pub'),
        hexPublicKey: Buffer.from('pub').toString('hex'),
        counter: 0,
        deviceType: 'singleDevice',
        backedUp: false,
      },
    })
  }
  return id
}

afterAll(async () => {
  await prisma.sessionKey.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.passkey.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
})

const token = fakeContractId()

describe('WalletService.preparePayment', () => {
  it('rejects when the wallet has not been deployed', async () => {
    const userId = await createUser(undefined)
    const service = new WalletService(makeFakeInvocations() as any)

    await expect(service.preparePayment(userId, { token, to: fakeContractId(), amount: '1', signer: 'passkey' })).rejects.toMatchObject({
      code: 'WALLET_NOT_DEPLOYED',
    })
  })

  it('rejects a non-positive amount', async () => {
    const userId = await createUser(fakeContractId())
    const service = new WalletService(makeFakeInvocations() as any)

    await expect(service.preparePayment(userId, { token, to: fakeContractId(), amount: '0', signer: 'passkey' })).rejects.toThrow(
      'Amount must be greater than zero'
    )
  })

  it('requires a sessionKeyId when signer is session_key', async () => {
    const userId = await createUser(fakeContractId())
    const service = new WalletService(makeFakeInvocations() as any)

    await expect(service.preparePayment(userId, { token, to: fakeContractId(), amount: '1', signer: 'session_key' })).rejects.toThrow(
      'sessionKeyId is required'
    )
  })

  it("rejects another user's session key", async () => {
    const owner = await createUser(fakeContractId())
    const spender = await createUser(fakeContractId())
    const key = await prisma.sessionKey.create({
      data: {
        userId: owner,
        publicKey: Keypair.random().publicKey(),
        tokenContract: token,
        perTxLimit: '100',
        totalLimit: '1000',
        expiresAtLedger: 1,
        expiresAt: new Date(Date.now() + 3600_000),
        status: 'active',
      },
    })
    const service = new WalletService(makeFakeInvocations() as any)

    await expect(
      service.preparePayment(spender, { token, to: fakeContractId(), amount: '1', signer: 'session_key', sessionKeyId: key.id })
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('rejects an inactive session key', async () => {
    const userId = await createUser(fakeContractId())
    const key = await prisma.sessionKey.create({
      data: {
        userId,
        publicKey: Keypair.random().publicKey(),
        tokenContract: token,
        perTxLimit: '100',
        totalLimit: '1000',
        expiresAtLedger: 1,
        expiresAt: new Date(Date.now() + 3600_000),
        status: 'revoked',
      },
    })
    const service = new WalletService(makeFakeInvocations() as any)

    await expect(
      service.preparePayment(userId, { token, to: fakeContractId(), amount: '1', signer: 'session_key', sessionKeyId: key.id })
    ).rejects.toMatchObject({ code: 'SESSION_KEY_INACTIVE' })
  })

  it('rejects a session key scoped to a different token', async () => {
    const userId = await createUser(fakeContractId())
    const key = await prisma.sessionKey.create({
      data: {
        userId,
        publicKey: Keypair.random().publicKey(),
        tokenContract: fakeContractId(),
        perTxLimit: '100',
        totalLimit: '1000',
        expiresAtLedger: 1,
        expiresAt: new Date(Date.now() + 3600_000),
        status: 'active',
      },
    })
    const service = new WalletService(makeFakeInvocations() as any)

    await expect(
      service.preparePayment(userId, { token, to: fakeContractId(), amount: '1', signer: 'session_key', sessionKeyId: key.id })
    ).rejects.toMatchObject({ code: 'SESSION_KEY_SCOPE' })
  })

  it('rejects an amount exceeding the per-transaction limit', async () => {
    const userId = await createUser(fakeContractId())
    const key = await prisma.sessionKey.create({
      data: {
        userId,
        publicKey: Keypair.random().publicKey(),
        tokenContract: token,
        perTxLimit: toBaseUnits('5').toString(),
        totalLimit: toBaseUnits('1000').toString(),
        expiresAtLedger: 1,
        expiresAt: new Date(Date.now() + 3600_000),
        status: 'active',
      },
    })
    const service = new WalletService(makeFakeInvocations() as any)

    await expect(
      service.preparePayment(userId, { token, to: fakeContractId(), amount: '10', signer: 'session_key', sessionKeyId: key.id })
    ).rejects.toMatchObject({ code: 'SESSION_KEY_LIMIT' })
  })

  it('rejects an amount exceeding the remaining total allowance', async () => {
    const userId = await createUser(fakeContractId())
    const key = await prisma.sessionKey.create({
      data: {
        userId,
        publicKey: Keypair.random().publicKey(),
        tokenContract: token,
        perTxLimit: toBaseUnits('100').toString(),
        totalLimit: toBaseUnits('10').toString(),
        spent: toBaseUnits('8').toString(),
        expiresAtLedger: 1,
        expiresAt: new Date(Date.now() + 3600_000),
        status: 'active',
      },
    })
    const service = new WalletService(makeFakeInvocations() as any)

    await expect(
      service.preparePayment(userId, { token, to: fakeContractId(), amount: '5', signer: 'session_key', sessionKeyId: key.id })
    ).rejects.toMatchObject({ code: 'SESSION_KEY_LIMIT' })
  })

  it('prepares a passkey-signed payment on the happy path', async () => {
    const userId = await createUser(fakeContractId())
    const invocations = makeFakeInvocations()
    const service = new WalletService(invocations as any)

    await service.preparePayment(userId, { token, to: fakeContractId(), amount: '1.5', signer: 'passkey' })

    expect(invocations.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ userId, kind: 'payment', signer: 'passkey', metadata: expect.objectContaining({ token }) })
    )
  })

  it('prepares a session-key payment within limits', async () => {
    const userId = await createUser(fakeContractId())
    const key = await prisma.sessionKey.create({
      data: {
        userId,
        publicKey: Keypair.random().publicKey(),
        tokenContract: token,
        perTxLimit: toBaseUnits('100').toString(),
        totalLimit: toBaseUnits('1000').toString(),
        expiresAtLedger: 1,
        expiresAt: new Date(Date.now() + 3600_000),
        status: 'active',
      },
    })
    const invocations = makeFakeInvocations()
    const service = new WalletService(invocations as any)

    await service.preparePayment(userId, { token, to: fakeContractId(), amount: '10', signer: 'session_key', sessionKeyId: key.id })

    expect(invocations.prepare).toHaveBeenCalledWith(expect.objectContaining({ signer: 'session_key', sessionKeyId: key.id }))
  })
})

describe('WalletService.deploy', () => {
  it('requires a passkey before deploying', async () => {
    const userId = await createUser(undefined, false)
    const service = new WalletService(makeFakeInvocations() as any)

    await expect(service.deploy(userId)).rejects.toMatchObject({ code: 'PASSKEY_REQUIRED' })
  })

  it('short-circuits when already deployed', async () => {
    const wallet = fakeContractId()
    const userId = await createUser(wallet, true)
    const invocations = makeFakeInvocations()
    const service = new WalletService(invocations as any)

    const result = await service.deploy(userId)

    expect(result).toEqual({ contractAddress: wallet, txHash: null, alreadyDeployed: true })
    expect(invocations.prepare).not.toHaveBeenCalled()
  })

  it('deploys the wallet and persists the returned contract address', async () => {
    const userId = await createUser(undefined, true)
    const newWallet = fakeContractId()
    const invocations = makeFakeInvocations()
    invocations.submit.mockResolvedValue({ invocationId: randomUUID(), status: 'succeeded', txHash: 'deploy-hash', returnValue: newWallet })
    const service = new WalletService(invocations as any)

    const result = await service.deploy(userId)

    expect(result).toEqual({ contractAddress: newWallet, txHash: 'deploy-hash', alreadyDeployed: false })
    const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
    expect(row.contractAddress).toBe(newWallet)
  })

  it('throws when the factory does not return a valid contract address', async () => {
    const userId = await createUser(undefined, true)
    const invocations = makeFakeInvocations()
    invocations.submit.mockResolvedValue({
      invocationId: randomUUID(),
      status: 'succeeded',
      txHash: 'deploy-hash',
      returnValue: 'not-a-contract',
    })
    const service = new WalletService(invocations as any)

    await expect(service.deploy(userId)).rejects.toThrow('Factory did not return a wallet address')
  })

  it('reports a conflict when the deployed address is already bound to another user', async () => {
    const takenWallet = fakeContractId()
    await createUser(takenWallet, false)
    const userId = await createUser(undefined, true)
    const invocations = makeFakeInvocations()
    invocations.submit.mockResolvedValue({
      invocationId: randomUUID(),
      status: 'succeeded',
      txHash: 'deploy-hash',
      returnValue: takenWallet,
    })
    const service = new WalletService(invocations as any)

    await expect(service.deploy(userId)).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('WalletService.submit kind-specific bookkeeping', () => {
  it('registers the session key active on a successful session_key_register submission', async () => {
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
    const invocations = makeFakeInvocations()
    invocations.get.mockResolvedValue({ kind: 'session_key_register', sessionKeyId: key.id, signer: 'passkey' })
    const service = new WalletService(invocations as any)

    await service.submit(userId, 'inv-1', { type: 'none' } as any)

    expect(invocations.submit).toHaveBeenCalledOnce()
    const hooks = invocations.submit.mock.calls[0][3]
    await hooks.onSuccess('tx-hash-register')

    const row = await prisma.sessionKey.findUniqueOrThrow({ where: { id: key.id } })
    expect(row.status).toBe('active')
    expect(row.registerTxHash).toBe('tx-hash-register')
  })

  it('reserves session spend for a session-key payment submission', async () => {
    const userId = await createUser(fakeContractId())
    const key = await prisma.sessionKey.create({
      data: {
        userId,
        publicKey: Keypair.random().publicKey(),
        tokenContract: token,
        perTxLimit: toBaseUnits('100').toString(),
        totalLimit: toBaseUnits('100').toString(),
        expiresAtLedger: 1,
        expiresAt: new Date(Date.now() + 3600_000),
        status: 'active',
      },
    })
    const invocations = makeFakeInvocations()
    invocations.get.mockResolvedValue({
      kind: 'payment',
      signer: 'session_key',
      sessionKeyId: key.id,
      metadata: { amount: toBaseUnits('10').toString() },
    })
    const service = new WalletService(invocations as any)

    await service.submit(userId, 'inv-2', { type: 'session_key', signature: Buffer.alloc(64) } as any)

    const hooks = invocations.submit.mock.calls[0][3]
    const release = await hooks.reserve()

    const afterReserve = await prisma.sessionKey.findUniqueOrThrow({ where: { id: key.id } })
    expect(afterReserve.spent.toString()).toBe(toBaseUnits('10').toString())

    await release()
    const afterRelease = await prisma.sessionKey.findUniqueOrThrow({ where: { id: key.id } })
    expect(afterRelease.spent.toString()).toBe('0')
  })

  it('refuses to submit a wallet_deploy invocation through the generic submit path', async () => {
    const userId = await createUser(fakeContractId())
    const invocations = makeFakeInvocations()
    invocations.get.mockResolvedValue({ kind: 'wallet_deploy', signer: 'none' })
    const service = new WalletService(invocations as any)

    await expect(service.submit(userId, 'inv-3', { type: 'none' } as any)).rejects.toThrow('POST /v1/wallet/deploy')
    expect(invocations.submit).not.toHaveBeenCalled()
  })

  it('submits a passkey payment without extra hooks', async () => {
    const userId = await createUser(fakeContractId())
    const invocations = makeFakeInvocations()
    invocations.get.mockResolvedValue({ kind: 'payment', signer: 'passkey' })
    const service = new WalletService(invocations as any)

    await service.submit(userId, 'inv-4', { type: 'passkey', assertion: {} } as any)

    expect(invocations.submit).toHaveBeenCalledOnce()
    const [calledUserId, calledInvocationId, calledInput] = invocations.submit.mock.calls[0]
    expect(calledUserId).toBe(userId)
    expect(calledInvocationId).toBe('inv-4')
    expect(calledInput).toEqual({ type: 'passkey', assertion: {} })
  })
})

describe('reserveSessionSpend', () => {
  it('reserves within limits and the release callback refunds it', async () => {
    const userId = await createUser(fakeContractId())
    const key = await prisma.sessionKey.create({
      data: {
        userId,
        publicKey: Keypair.random().publicKey(),
        tokenContract: token,
        perTxLimit: toBaseUnits('50').toString(),
        totalLimit: toBaseUnits('100').toString(),
        expiresAtLedger: 1,
        expiresAt: new Date(Date.now() + 3600_000),
        status: 'active',
      },
    })

    const release = await reserveSessionSpend(key.id, toBaseUnits('20'))
    let row = await prisma.sessionKey.findUniqueOrThrow({ where: { id: key.id } })
    expect(row.spent.toString()).toBe(toBaseUnits('20').toString())

    await release()
    row = await prisma.sessionKey.findUniqueOrThrow({ where: { id: key.id } })
    expect(row.spent.toString()).toBe('0')
  })

  it('refuses to reserve above the per-transaction limit', async () => {
    const userId = await createUser(fakeContractId())
    const key = await prisma.sessionKey.create({
      data: {
        userId,
        publicKey: Keypair.random().publicKey(),
        tokenContract: token,
        perTxLimit: toBaseUnits('5').toString(),
        totalLimit: toBaseUnits('100').toString(),
        expiresAtLedger: 1,
        expiresAt: new Date(Date.now() + 3600_000),
        status: 'active',
      },
    })

    await expect(reserveSessionSpend(key.id, toBaseUnits('10'))).rejects.toMatchObject({ code: 'SESSION_KEY_LIMIT' })
  })

  it('refuses to reserve against an inactive key', async () => {
    const userId = await createUser(fakeContractId())
    const key = await prisma.sessionKey.create({
      data: {
        userId,
        publicKey: Keypair.random().publicKey(),
        tokenContract: token,
        perTxLimit: toBaseUnits('50').toString(),
        totalLimit: toBaseUnits('100').toString(),
        expiresAtLedger: 1,
        expiresAt: new Date(Date.now() + 3600_000),
        status: 'revoked',
      },
    })

    await expect(reserveSessionSpend(key.id, toBaseUnits('10'))).rejects.toMatchObject({ code: 'SESSION_KEY_LIMIT' })
  })
})
