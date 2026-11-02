import { Account, Address, Keypair, StrKey, TransactionBuilder, authorizeInvocation, rpc, xdr } from '@stellar/stellar-sdk'
import type { Transaction } from '@stellar/stellar-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { BadRequestError, UpstreamError } from '../src/errors'
import type { Simulation } from '../src/interfaces/soroban'
import { SorobanService } from '../src/interfaces/soroban'
import type * as Retry from '../src/lib/retry'

vi.mock('../src/lib/retry', async importOriginal => {
  const actual = await importOriginal<typeof Retry>()
  // The real `retry` is kept (send()/simulate() rely on its retry semantics); only the
  // real 1s `sleep` used by send()'s NOT_FOUND polling loop is replaced so tests stay fast.
  return { ...actual, sleep: vi.fn().mockResolvedValue(undefined) }
})

const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'
const contractId = StrKey.encodeContract(Buffer.alloc(32, 7))

function buildInvocation(functionName = 'transfer') {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contractId).toScAddress(),
        functionName,
        args: [],
      })
    ),
    subInvocations: [],
  })
}

/** A real, fully-signed address-credentialed auth entry for `signer`. */
async function buildAddressEntry(signer: Keypair, validUntilLedger: number): Promise<xdr.SorobanAuthorizationEntry> {
  return authorizeInvocation(signer, validUntilLedger, buildInvocation(), signer.publicKey(), NETWORK_PASSPHRASE)
}

function buildSourceAccountEntry(): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    rootInvocation: buildInvocation(),
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
  })
}

/** Minimal rpc.Server stand-in; only the methods SorobanService actually calls need to exist. */
function fakeRpc(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    simulateTransaction: vi.fn(),
    getLatestLedger: vi.fn(),
    getAccount: vi.fn(),
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
    ...overrides,
  } as any
}

function successSim(overrides: Partial<Simulation> = {}): Simulation {
  return {
    id: '1',
    latestLedger: 100,
    events: [],
    _parsed: true,
    transactionData: {},
    minResourceFee: '100',
    ...overrides,
  } as any
}

function errorSim(error = 'boom') {
  return { id: '1', latestLedger: 100, events: [], _parsed: true, error } as any
}

function buildTxWithOperation(service: InstanceType<typeof SorobanService>): Transaction {
  const source = new Account(Keypair.random().publicKey(), '0')
  const op = service.buildOperation({ contractId, method: 'transfer', args: [] })
  return new TransactionBuilder(source, { fee: '100', networkPassphrase: NETWORK_PASSPHRASE }).addOperation(op).setTimeout(30).build()
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildOperation / withAuth', () => {
  it('builds an invokeHostFunction operation with no auth by default', () => {
    const service = new SorobanService(fakeRpc())
    const op = service.buildOperation({ contractId, method: 'transfer', args: [] })
    expect(op.body().switch().name).toBe('invokeHostFunction')
    expect(op.body().invokeHostFunctionOp().auth()).toHaveLength(0)
  })

  it('attaches provided auth entries at build time', async () => {
    const service = new SorobanService(fakeRpc())
    const entry = await buildAddressEntry(Keypair.random(), 1000)
    const op = service.buildOperation({ contractId, method: 'transfer', args: [] }, [entry])
    expect(op.body().invokeHostFunctionOp().auth()).toHaveLength(1)
  })

  it('withAuth replaces auth while preserving the host function', async () => {
    const service = new SorobanService(fakeRpc())
    const op = service.buildOperation({ contractId, method: 'transfer', args: [] })
    const entry = await buildAddressEntry(Keypair.random(), 1000)

    const updated = service.withAuth(op, [entry])

    expect(updated.body().invokeHostFunctionOp().auth()).toHaveLength(1)
    expect(updated.body().invokeHostFunctionOp().hostFunction().invokeContract().functionName().toString()).toBe('transfer')
  })
})

describe('isAddressEntry', () => {
  it('matches an address-credentialed entry for the right address', async () => {
    const service = new SorobanService(fakeRpc())
    const signer = Keypair.random()
    const entry = await buildAddressEntry(signer, 1000)
    expect(service.isAddressEntry(entry, signer.publicKey())).toBe(true)
  })

  it('does not match a different address', async () => {
    const service = new SorobanService(fakeRpc())
    const entry = await buildAddressEntry(Keypair.random(), 1000)
    expect(service.isAddressEntry(entry, Keypair.random().publicKey())).toBe(false)
  })

  it('does not match a source-account-credentialed entry', () => {
    const service = new SorobanService(fakeRpc())
    const entry = buildSourceAccountEntry()
    expect(service.isAddressEntry(entry, Keypair.random().publicKey())).toBe(false)
  })
})

describe('findAuthEntry / requiredSigners', () => {
  it('finds the matching entry and lists only address-credentialed signers', async () => {
    const service = new SorobanService(fakeRpc())
    const signerA = Keypair.random()
    const signerB = Keypair.random()
    const entryA = await buildAddressEntry(signerA, 1000)
    const entryB = await buildAddressEntry(signerB, 1000)
    const sourceEntry = buildSourceAccountEntry()
    const simulation = successSim({ result: { auth: [entryA, entryB, sourceEntry], retval: xdr.ScVal.scvVoid() } })

    expect(service.findAuthEntry(simulation, signerA.publicKey())).toBeDefined()
    expect(service.findAuthEntry(simulation, Keypair.random().publicKey())).toBeUndefined()
    expect(service.requiredSigners(simulation).sort()).toEqual([signerA.publicKey(), signerB.publicKey()].sort())
  })

  it('returns nothing when the simulation has no result', () => {
    const service = new SorobanService(fakeRpc())
    const simulation = successSim()
    expect(service.findAuthEntry(simulation, Keypair.random().publicKey())).toBeUndefined()
    expect(service.requiredSigners(simulation)).toEqual([])
  })
})

describe('authPayload', () => {
  it('is deterministic for the same entry and ledger, and changes when the ledger changes', async () => {
    const service = new SorobanService(fakeRpc())
    const entry = await buildAddressEntry(Keypair.random(), 1000)

    const payload1 = service.authPayload(entry, 1000)
    const payload2 = service.authPayload(entry, 1000)
    const payload3 = service.authPayload(entry, 1001)

    expect(payload1).toHaveLength(32)
    expect(payload1.equals(payload2)).toBe(true)
    expect(payload1.equals(payload3)).toBe(false)
  })
})

describe('attachSignature', () => {
  it('returns a new entry carrying the signature and expiration, without mutating the original', async () => {
    const service = new SorobanService(fakeRpc())
    const entry = await buildAddressEntry(Keypair.random(), 1000)
    const originalXdr = entry.toXDR('base64')
    const signature = xdr.ScVal.scvBytes(Buffer.alloc(8, 1))

    const signed = service.attachSignature(entry, 2000, signature)

    expect(signed.credentials().address().signatureExpirationLedger()).toBe(2000)
    expect(signed.credentials().address().signature().bytes().toString('hex')).toBe(Buffer.alloc(8, 1).toString('hex'))
    expect(entry.toXDR('base64')).toBe(originalXdr)
  })
})

describe('simulate', () => {
  it('resolves on a successful simulation', async () => {
    const simulateTransaction = vi.fn().mockResolvedValue(successSim())
    const service = new SorobanService(fakeRpc({ simulateTransaction }))

    await expect(service.simulate(buildTxWithOperation(service))).resolves.toMatchObject({ minResourceFee: '100' })
  })

  it('throws BadRequestError with SIMULATION_FAILED on a simulation error', async () => {
    const simulateTransaction = vi.fn().mockResolvedValue(errorSim('contract trapped'))
    const service = new SorobanService(fakeRpc({ simulateTransaction }))

    await expect(service.simulate(buildTxWithOperation(service))).rejects.toMatchObject({
      constructor: BadRequestError,
      code: 'SIMULATION_FAILED',
    })
  })
})

describe('latestLedger / validUntilLedger', () => {
  it('resolves the latest ledger sequence', async () => {
    const getLatestLedger = vi.fn().mockResolvedValue({ sequence: 500, id: 'x', protocolVersion: '20' })
    const service = new SorobanService(fakeRpc({ getLatestLedger }))

    await expect(service.latestLedger()).resolves.toBe(500)
  })

  it('adds ceil(ttlSeconds / 5) ledgers (5s ledger close time) to the latest sequence', async () => {
    const getLatestLedger = vi.fn().mockResolvedValue({ sequence: 500, id: 'x', protocolVersion: '20' })
    const service = new SorobanService(fakeRpc({ getLatestLedger }))

    await expect(service.validUntilLedger(11)).resolves.toBe(500 + Math.ceil(11 / 5))
    await expect(service.validUntilLedger(10)).resolves.toBe(500 + 2)
  })
})

describe('send', () => {
  it('resolves with hash/ledger once getTransaction reports SUCCESS, polling past a NOT_FOUND', async () => {
    const getTransaction = vi
      .fn()
      .mockResolvedValueOnce({ status: rpc.Api.GetTransactionStatus.NOT_FOUND })
      .mockResolvedValueOnce({ status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 42 })
    const sendTransaction = vi.fn().mockResolvedValue({ status: 'PENDING', hash: 'abc123' })
    const service = new SorobanService(fakeRpc({ sendTransaction, getTransaction }))

    await expect(service.send(buildTxWithOperation(service))).resolves.toMatchObject({ hash: 'abc123', ledger: 42 })
    expect(getTransaction).toHaveBeenCalledTimes(2)
  })

  it('throws UpstreamError when sendTransaction reports ERROR', async () => {
    const sendTransaction = vi.fn().mockResolvedValue({ status: 'ERROR', hash: 'abc123' })
    const service = new SorobanService(fakeRpc({ sendTransaction }))

    await expect(service.send(buildTxWithOperation(service))).rejects.toBeInstanceOf(UpstreamError)
  })

  it('throws UpstreamError when the transaction fails on-chain', async () => {
    const sendTransaction = vi.fn().mockResolvedValue({ status: 'PENDING', hash: 'abc123' })
    const getTransaction = vi.fn().mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.FAILED,
      resultXdr: { toXDR: () => 'deadbeef' },
    })
    const service = new SorobanService(fakeRpc({ sendTransaction, getTransaction }))

    await expect(service.send(buildTxWithOperation(service))).rejects.toBeInstanceOf(UpstreamError)
  })
})

describe('parseTransaction', () => {
  it('round-trips valid transaction XDR', () => {
    const service = new SorobanService(fakeRpc())
    const tx = buildTxWithOperation(service)

    const parsed = service.parseTransaction(tx.toXDR())

    expect(parsed.toXDR()).toBe(tx.toXDR())
  })

  it('throws BadRequestError with INVALID_XDR on garbage input', () => {
    const service = new SorobanService(fakeRpc())

    expect(() => service.parseTransaction('not-valid-xdr')).toThrow(BadRequestError)
    expect(() => service.parseTransaction('not-valid-xdr')).toThrow(expect.objectContaining({ code: 'INVALID_XDR' }))
  })
})
