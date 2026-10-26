import type { FeeBumpTransaction, Transaction } from '@stellar/stellar-sdk'
import { Account, Address, Contract, hash, Operation, rpc, TransactionBuilder, xdr } from '@stellar/stellar-sdk'

import { logger } from '../../config/logger'
import { STELLAR } from '../../config/stellar'
import { BadRequestError, UpstreamError } from '../../errors'
import { retry, sleep } from '../../lib/retry'
import { withRelayerLock } from './mutex'

export type Simulation = rpc.Api.SimulateTransactionSuccessResponse

export type InvocationInput = {
  contractId: string
  method: string
  args: xdr.ScVal[]
}

export type SubmittedTransaction = {
  hash: string
  ledger: number
  feeCharged?: bigint
  returnValue?: xdr.ScVal
}

/** Approximate ledger close time on Stellar, used to convert TTLs into ledger counts. */
const LEDGER_SECONDS = 5

/**
 * Soroban RPC wrapper: builds relayer-sourced invocations, derives the auth
 * payloads users must sign, re-assembles signed transactions and submits them.
 */
export class SorobanService {
  private static instance?: SorobanService
  public readonly rpc: rpc.Server

  constructor(server?: rpc.Server) {
    this.rpc =
      server ??
      new rpc.Server(STELLAR.rpcUrl, {
        allowHttp: STELLAR.rpcUrl.startsWith('http://'),
        timeout: 30_000,
        headers: STELLAR.rpcHeaders,
      })
  }

  static getInstance(): SorobanService {
    SorobanService.instance ??= new SorobanService()
    return SorobanService.instance
  }

  /** Builds an InvokeHostFunction operation for `contractId.method(args)`. */
  buildOperation({ contractId, method, args }: InvocationInput, auth?: xdr.SorobanAuthorizationEntry[]): xdr.Operation {
    const op = new Contract(contractId).call(method, ...args)
    return auth ? this.withAuth(op, auth) : op
  }

  /** Builds and simulates a relayer-sourced transaction carrying a single operation. */
  async simulateOperation(operation: xdr.Operation): Promise<{ tx: Transaction; simulation: Simulation }> {
    const source = await this.loadRelayerAccount()
    const tx = this.buildTx(source, operation)
    const simulation = await this.simulate(tx)
    return { tx, simulation }
  }

  /** Read-only contract call (no submission). Returns the simulated return value. */
  async read({ contractId, method, args }: InvocationInput): Promise<xdr.ScVal> {
    // Reads never consume the sequence number, so a static account is sufficient
    const source = new Account(STELLAR.relayer.publicKey(), '0')
    const tx = this.buildTx(source, this.buildOperation({ contractId, method, args }))
    const simulation = await this.simulate(tx)
    if (!simulation.result) throw new UpstreamError('soroban', `${method} returned no value`)
    return simulation.result.retval
  }

  async simulate(tx: Transaction): Promise<Simulation> {
    const simulation = await retry(() => this.rpc.simulateTransaction(tx))
    if (!rpc.Api.isSimulationSuccess(simulation)) {
      const error = rpc.Api.isSimulationError(simulation) ? simulation.error : 'simulation restore required'
      logger.warn({ error }, 'SorobanService | simulate | failed')
      throw new BadRequestError('Contract simulation failed', { error }, 'SIMULATION_FAILED')
    }
    return simulation
  }

  /** Returns the address-credential auth entry that `address` must sign, if any. */
  findAuthEntry(simulation: Simulation, address: string): xdr.SorobanAuthorizationEntry | undefined {
    return (simulation.result?.auth ?? []).find(entry => this.isAddressEntry(entry, address))
  }

  /** Lists every address that the simulated invocation requires non-source-account auth from. */
  requiredSigners(simulation: Simulation): string[] {
    return (simulation.result?.auth ?? [])
      .filter(entry => entry.credentials().switch().value === xdr.SorobanCredentialsType.sorobanCredentialsAddress().value)
      .map(entry => Address.fromScAddress(entry.credentials().address().address()).toString())
  }

  /** Ledger sequence after which a signature produced now should stop being accepted. */
  async validUntilLedger(ttlSeconds: number): Promise<number> {
    const latest = await retry(() => this.rpc.getLatestLedger())
    return latest.sequence + Math.ceil(ttlSeconds / LEDGER_SECONDS)
  }

  async latestLedger(): Promise<number> {
    return (await retry(() => this.rpc.getLatestLedger())).sequence
  }

  /**
   * The 32-byte payload a smart account's `__check_auth` receives as `signature_payload`:
   * sha256(HashIdPreimage::SorobanAuthorization { networkId, nonce, expiration, invocation }).
   */
  authPayload(entry: xdr.SorobanAuthorizationEntry, validUntilLedger: number): Buffer {
    const credentials = entry.credentials().address()
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(STELLAR.networkPassphrase)),
        nonce: credentials.nonce(),
        signatureExpirationLedger: validUntilLedger,
        invocation: entry.rootInvocation(),
      })
    )
    return hash(preimage.toXDR())
  }

  /** Returns a copy of `entry` carrying the given signature and expiration. */
  attachSignature(entry: xdr.SorobanAuthorizationEntry, validUntilLedger: number, signature: xdr.ScVal): xdr.SorobanAuthorizationEntry {
    const signed = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR())
    const credentials = signed.credentials().address()
    credentials.signatureExpirationLedger(validUntilLedger)
    credentials.signature(signature)
    return signed
  }

  /**
   * Builds a fresh relayer-sourced transaction carrying `operation` (whose auth
   * entries are already signed), re-simulates it so the `__check_auth` footprint
   * is included, assembles resources and signs it with the relayer key.
   *
   * Call inside `withRelayer` and submit before releasing the lock.
   */
  async prepareSigned(operation: xdr.Operation): Promise<{ tx: Transaction; simulation: Simulation }> {
    const source = await this.loadRelayerAccount()
    const draft = this.buildTx(source, operation)
    const simulation = await this.simulate(draft)
    const tx = rpc.assembleTransaction(draft, simulation).build()
    tx.sign(STELLAR.relayer)
    return { tx, simulation }
  }

  /** Returns `operation` with its auth entries replaced by `auth`. */
  withAuth(operation: xdr.Operation, auth: xdr.SorobanAuthorizationEntry[]): xdr.Operation {
    const func = operation.body().invokeHostFunctionOp().hostFunction()
    return Operation.invokeHostFunction({ func, auth })
  }

  isAddressEntry(entry: xdr.SorobanAuthorizationEntry, address: string): boolean {
    return (
      entry.credentials().switch().value === xdr.SorobanCredentialsType.sorobanCredentialsAddress().value &&
      Address.fromScAddress(entry.credentials().address().address()).toString() === address
    )
  }

  /**
   * Runs `fn` while holding the relayer sequence lock.
   *
   * The lock is cross-process: it is a Postgres advisory lock keyed by the
   * relayer account's public key, so concurrent submissions from multiple
   * backend replicas are serialised on the relayer's sequence number. This
   * relies on every replica sharing the same Postgres instance (the one behind
   * the shared `prisma` client). Acquisition is timeout-bounded so a stuck
   * holder cannot block forever, and the lock is released on both success and
   * failure paths.
   */
  withRelayer<T>(fn: () => Promise<T>): Promise<T> {
    return withRelayerLock(STELLAR.relayer.publicKey(), fn)
  }

  /** Submits a (fee-bumped) transaction and waits for it to be applied. */
  async send(tx: Transaction | FeeBumpTransaction): Promise<SubmittedTransaction> {
    const response = await retry(() => this.rpc.sendTransaction(tx), { attempts: 2 })
    if (response.status === 'ERROR' || response.status === 'TRY_AGAIN_LATER') {
      throw new UpstreamError('soroban', `transaction rejected (${response.status})`, {
        hash: response.hash,
        errorResult: response.errorResult?.toXDR('base64'),
      })
    }

    const deadline = Date.now() + 60_000
    let result = await this.rpc.getTransaction(response.hash)
    while (result.status === rpc.Api.GetTransactionStatus.NOT_FOUND && Date.now() < deadline) {
      await sleep(1_000)
      result = await this.rpc.getTransaction(response.hash)
    }

    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return {
        hash: response.hash,
        ledger: result.ledger,
        feeCharged: result.resultXdr ? BigInt(result.resultXdr.feeCharged().toString()) : undefined,
        returnValue: result.returnValue,
      }
    }
    throw new UpstreamError('soroban', `transaction ${result.status.toLowerCase()}`, {
      hash: response.hash,
      resultXdr: result.status === rpc.Api.GetTransactionStatus.FAILED ? result.resultXdr.toXDR('base64') : undefined,
    })
  }

  parseTransaction(txXdr: string): Transaction | FeeBumpTransaction {
    try {
      return TransactionBuilder.fromXDR(txXdr, STELLAR.networkPassphrase)
    } catch {
      throw new BadRequestError('Invalid transaction XDR', undefined, 'INVALID_XDR')
    }
  }

  private async loadRelayerAccount(): Promise<Account> {
    const account = await retry(() => this.rpc.getAccount(STELLAR.relayer.publicKey()))
    return new Account(account.accountId(), account.sequenceNumber())
  }

  private buildTx(source: Account, operation: xdr.Operation): Transaction {
    return new TransactionBuilder(source, {
      fee: String(STELLAR.baseFee),
      networkPassphrase: STELLAR.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(STELLAR.txTimeoutSeconds)
      .build()
  }
}
