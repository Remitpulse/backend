import { randomBytes, randomUUID } from 'node:crypto'

import { Address, Contract, StrKey, xdr } from '@stellar/stellar-sdk'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { InvocationService } from '../src/api/wallet/invocation-service'
import { prisma } from '../src/config/database'
import { env } from '../src/config/env'

// ---------------------------------------------------------------------------
// XDR fixtures
//
// `InvocationService.submit` parses `pending.txXdr`/`pending.authEntryXdr` with the
// real `@stellar/stellar-sdk` xdr module before handing them to the (mocked) soroban
// collaborator, so these need to be genuinely valid XDR — their semantic content
// doesn't matter since everything downstream of parsing is a mock in these tests.
// ---------------------------------------------------------------------------

function buildRealOperation(contractId: string, method = 'transfer'): xdr.Operation {
  return new Contract(contractId).call(method)
}

function buildRealAuthEntry(wallet: string, contractId: string, method = 'transfer'): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(wallet).toScAddress(),
        nonce: xdr.Int64.fromString('1'),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(contractId).toScAddress(),
          functionName: method,
          args: [],
        })
      ),
      subInvocations: [],
    }),
  })
}

function buildOperationXdr(contractId: string, method = 'transfer'): string {
  return buildRealOperation(contractId, method).toXDR('base64')
}

function buildAuthEntryXdr(wallet: string, contractId: string, method = 'transfer'): string {
  return buildRealAuthEntry(wallet, contractId, method).toXDR('base64')
}

function fakeContractId(): string {
  return StrKey.encodeContract(randomBytes(32))
}

function makeFakeSoroban() {
  return {
    // `prepare()` calls `.toXDR('base64')` on this return value to persist it, so it
    // must be a real xdr.Operation even though downstream (submit-time) consumers are mocked.
    buildOperation: vi.fn((input: { contractId: string; method: string }) => buildRealOperation(input.contractId, input.method)),
    simulateOperation: vi.fn(),
    requiredSigners: vi.fn().mockReturnValue([]),
    findAuthEntry: vi.fn(),
    validUntilLedger: vi.fn().mockResolvedValue(1000),
    latestLedger: vi.fn().mockResolvedValue(10),
    authPayload: vi.fn().mockReturnValue(Buffer.alloc(32, 1)),
    attachSignature: vi.fn((entry: unknown) => entry),
    withAuth: vi.fn((operation: unknown) => operation),
    isAddressEntry: vi.fn().mockReturnValue(true),
    withRelayer: vi.fn((fn: () => Promise<unknown>) => fn()),
    prepareSigned: vi.fn().mockResolvedValue({ tx: {} }),
    send: vi.fn(),
  }
}

function makeFakePaymaster() {
  return {
    sponsor: vi
      .fn()
      .mockResolvedValue({ hash: 'fee-bump-hash', ledger: 42, feeCharged: 100n, innerHash: 'inner', feeBumpHash: 'bump', maxFee: '100' }),
  }
}

function makeFakeWebauthn() {
  return { contractSigningOptions: vi.fn().mockResolvedValue({ challenge: 'chal' }), verifyContractAssertion: vi.fn() }
}

const userIds: string[] = []

async function createUser(contractAddress?: string) {
  const id = randomUUID()
  userIds.push(id)
  await prisma.user.create({ data: { id, email: `${id}@example.com`, contractAddress } })
  return id
}

afterAll(async () => {
  await prisma.pendingInvocation.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
})

describe('InvocationService.prepare', () => {
  it('throws WALLET_NOT_DEPLOYED when signer requires a wallet the user has not deployed', async () => {
    const userId = await createUser(undefined)
    const soroban = makeFakeSoroban()
    const service = new InvocationService(soroban as any, makeFakePaymaster() as any, makeFakeWebauthn() as any)

    await expect(
      service.prepare({
        userId,
        kind: 'contract_call',
        signer: 'passkey',
        invocation: { contractId: fakeContractId(), method: 'x', args: [] },
      })
    ).rejects.toMatchObject({ code: 'WALLET_NOT_DEPLOYED' })
  })

  it('throws CONTRACT_NOT_ALLOWED when the target contract is not in the allow-list', async () => {
    const wallet = fakeContractId()
    const userId = await createUser(wallet)
    const soroban = makeFakeSoroban()
    const service = new InvocationService(soroban as any, makeFakePaymaster() as any, makeFakeWebauthn() as any)

    await expect(
      service.prepare({
        userId,
        kind: 'contract_call',
        signer: 'passkey',
        invocation: { contractId: fakeContractId(), method: 'x', args: [] },
      })
    ).rejects.toMatchObject({ code: 'CONTRACT_NOT_ALLOWED' })
    expect(soroban.simulateOperation).not.toHaveBeenCalled()
  })

  it('throws UNSUPPORTED_AUTH when simulation requires a signer other than the user wallet', async () => {
    const wallet = fakeContractId()
    const userId = await createUser(wallet)
    const soroban = makeFakeSoroban()
    soroban.simulateOperation.mockResolvedValue({ tx: {}, simulation: { result: { auth: [] }, minResourceFee: '1' } })
    soroban.requiredSigners.mockReturnValue([wallet, fakeContractId()])
    const service = new InvocationService(soroban as any, makeFakePaymaster() as any, makeFakeWebauthn() as any)

    await expect(
      service.prepare({
        userId,
        kind: 'contract_call',
        signer: 'passkey',
        invocation: { contractId: env.ACCOUNT_CONTRACT_ID, method: 'x', args: [] },
      })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_AUTH' })
  })

  it('throws SIGNATURE_REQUIRED when signer is none but the simulation requires a wallet signature', async () => {
    const wallet = fakeContractId()
    const userId = await createUser(wallet)
    const soroban = makeFakeSoroban()
    soroban.simulateOperation.mockResolvedValue({ tx: {}, simulation: { result: { auth: [] }, minResourceFee: '1' } })
    soroban.requiredSigners.mockReturnValue([wallet])
    const service = new InvocationService(soroban as any, makeFakePaymaster() as any, makeFakeWebauthn() as any)

    await expect(
      service.prepare({
        userId,
        kind: 'contract_call',
        signer: 'none',
        invocation: { contractId: env.ACCOUNT_CONTRACT_ID, method: 'x', args: [] },
      })
    ).rejects.toMatchObject({ code: 'SIGNATURE_REQUIRED' })
  })

  it('throws NO_AUTH_REQUIRED when signer is not none but the simulation requires no wallet auth', async () => {
    const wallet = fakeContractId()
    const userId = await createUser(wallet)
    const soroban = makeFakeSoroban()
    soroban.simulateOperation.mockResolvedValue({ tx: {}, simulation: { result: { auth: [] }, minResourceFee: '1' } })
    soroban.requiredSigners.mockReturnValue([])
    soroban.findAuthEntry.mockReturnValue(undefined)
    const service = new InvocationService(soroban as any, makeFakePaymaster() as any, makeFakeWebauthn() as any)

    await expect(
      service.prepare({
        userId,
        kind: 'contract_call',
        signer: 'passkey',
        invocation: { contractId: env.ACCOUNT_CONTRACT_ID, method: 'x', args: [] },
      })
    ).rejects.toMatchObject({ code: 'NO_AUTH_REQUIRED' })
  })

  it('creates a pending invocation and returns webauthn options on the passkey happy path', async () => {
    const wallet = fakeContractId()
    const userId = await createUser(wallet)
    const soroban = makeFakeSoroban()
    soroban.simulateOperation.mockResolvedValue({ tx: {}, simulation: { result: { auth: [] }, minResourceFee: '1234' } })
    soroban.requiredSigners.mockReturnValue([wallet])
    soroban.findAuthEntry.mockReturnValue(buildRealAuthEntry(wallet, env.ACCOUNT_CONTRACT_ID))
    soroban.validUntilLedger.mockResolvedValue(555)
    soroban.authPayload.mockReturnValue(Buffer.alloc(32, 9))
    const webauthn = makeFakeWebauthn()
    const service = new InvocationService(soroban as any, makeFakePaymaster() as any, webauthn as any)

    const result = await service.prepare({
      userId,
      kind: 'contract_call',
      signer: 'passkey',
      invocation: { contractId: env.ACCOUNT_CONTRACT_ID, method: 'ping', args: [] },
    })

    expect(result.invocationId).toBeTruthy()
    expect(result.validUntilLedger).toBe(555)
    expect(result.authPayload?.hex).toBe(Buffer.alloc(32, 9).toString('hex'))
    expect(result.webauthnOptions).toEqual({ challenge: 'chal' })
    expect(webauthn.contractSigningOptions).toHaveBeenCalledOnce()

    const row = await prisma.pendingInvocation.findUniqueOrThrow({ where: { id: result.invocationId } })
    expect(row.signer).toBe('passkey')
    expect(row.status).toBe('awaiting_signature')
  })

  it('creates a pending invocation with no auth payload on the signer=none happy path', async () => {
    const userId = await createUser(undefined)
    const soroban = makeFakeSoroban()
    soroban.simulateOperation.mockResolvedValue({ tx: {}, simulation: { result: { auth: [] }, minResourceFee: '1' } })
    soroban.requiredSigners.mockReturnValue([])
    const service = new InvocationService(soroban as any, makeFakePaymaster() as any, makeFakeWebauthn() as any)

    const result = await service.prepare({
      userId,
      kind: 'wallet_deploy',
      signer: 'none',
      invocation: { contractId: env.ACCOUNT_CONTRACT_ID, method: 'deploy', args: [] },
    })

    expect(result.authPayload).toBeNull()
    expect(result.webauthnOptions).toBeNull()
  })
})

describe('InvocationService.submit', () => {
  async function createPendingRow(opts: {
    userId: string
    status?: 'awaiting_signature' | 'submitted' | 'succeeded' | 'failed' | 'expired'
    signer?: 'passkey' | 'session_key' | 'none'
    expiresAt?: Date
    withAuth?: boolean
    contractId?: string
  }) {
    const contractId = opts.contractId ?? fakeContractId()
    const wallet = fakeContractId()
    return prisma.pendingInvocation.create({
      data: {
        userId: opts.userId,
        kind: 'contract_call',
        contractId,
        method: 'ping',
        txXdr: buildOperationXdr(contractId),
        authEntryXdr: opts.withAuth ? buildAuthEntryXdr(wallet, contractId) : undefined,
        authPayload: opts.withAuth ? Buffer.alloc(32, 3).toString('base64url') : undefined,
        validUntilLedger: opts.withAuth ? 999 : undefined,
        signer: opts.signer ?? 'none',
        status: opts.status ?? 'awaiting_signature',
        expiresAt: opts.expiresAt ?? new Date(Date.now() + 60_000),
      },
    })
  }

  it('throws a conflict when the invocation is not awaiting a signature', async () => {
    const userId = await createUser(fakeContractId())
    const pending = await createPendingRow({ userId, status: 'succeeded' })
    const soroban = makeFakeSoroban()
    const service = new InvocationService(soroban as any, makeFakePaymaster() as any, makeFakeWebauthn() as any)

    await expect(service.submit(userId, pending.id, { type: 'none' })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('expires and rejects a submission past its expiry window', async () => {
    const userId = await createUser(fakeContractId())
    const pending = await createPendingRow({ userId, expiresAt: new Date(Date.now() - 1000) })
    const soroban = makeFakeSoroban()
    const service = new InvocationService(soroban as any, makeFakePaymaster() as any, makeFakeWebauthn() as any)

    await expect(service.submit(userId, pending.id, { type: 'none' })).rejects.toMatchObject({ code: 'INVOCATION_EXPIRED' })
    const row = await prisma.pendingInvocation.findUniqueOrThrow({ where: { id: pending.id } })
    expect(row.status).toBe('expired')
  })

  it('throws WRONG_SIGNER on a signer-type mismatch', async () => {
    const userId = await createUser(fakeContractId())
    const pending = await createPendingRow({ userId, signer: 'passkey' })
    const soroban = makeFakeSoroban()
    const service = new InvocationService(soroban as any, makeFakePaymaster() as any, makeFakeWebauthn() as any)

    await expect(service.submit(userId, pending.id, { type: 'session_key', signature: Buffer.alloc(64) })).rejects.toMatchObject({
      code: 'WRONG_SIGNER',
    })
  })

  it('allows only one of two concurrent submissions to claim the invocation', async () => {
    const userId = await createUser(fakeContractId())
    const pending = await createPendingRow({ userId })
    const soroban = makeFakeSoroban()
    const service = new InvocationService(soroban as any, makeFakePaymaster() as any, makeFakeWebauthn() as any)

    const results = await Promise.allSettled([
      service.submit(userId, pending.id, { type: 'none' }),
      service.submit(userId, pending.id, { type: 'none' }),
    ])

    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 })
  })

  it('marks the invocation failed and runs the release hook when submission fails downstream', async () => {
    const userId = await createUser(fakeContractId())
    const pending = await createPendingRow({ userId })
    const soroban = makeFakeSoroban()
    const paymaster = makeFakePaymaster()
    paymaster.sponsor.mockRejectedValue(new Error('network rejected'))
    const service = new InvocationService(soroban as any, paymaster as any, makeFakeWebauthn() as any)

    const release = vi.fn().mockResolvedValue(undefined)
    const reserve = vi.fn().mockResolvedValue(release)

    await expect(service.submit(userId, pending.id, { type: 'none' }, { reserve })).rejects.toThrow('network rejected')
    expect(release).toHaveBeenCalledOnce()

    const row = await prisma.pendingInvocation.findUniqueOrThrow({ where: { id: pending.id } })
    expect(row.status).toBe('failed')
    expect(row.error).toContain('network rejected')
  })

  it('succeeds end to end and invokes the onSuccess hook with the transaction hash', async () => {
    const userId = await createUser(fakeContractId())
    const pending = await createPendingRow({ userId })
    const soroban = makeFakeSoroban()
    const paymaster = makeFakePaymaster()
    const service = new InvocationService(soroban as any, paymaster as any, makeFakeWebauthn() as any)
    const onSuccess = vi.fn().mockResolvedValue(undefined)

    const result = await service.submit(userId, pending.id, { type: 'none' }, { onSuccess })

    expect(result.status).toBe('succeeded')
    expect(result.txHash).toBe('fee-bump-hash')
    expect(onSuccess).toHaveBeenCalledWith('fee-bump-hash')

    const row = await prisma.pendingInvocation.findUniqueOrThrow({ where: { id: pending.id } })
    expect(row.status).toBe('succeeded')
    expect(row.txHash).toBe('fee-bump-hash')
  })
})
