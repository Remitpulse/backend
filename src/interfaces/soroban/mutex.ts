import { createHash } from 'crypto'
import { prisma } from '../../config/database'

/**
 * Cross-process relayer lock backed by Postgres advisory locks.
 *
 * IMPORTANT: This lock is CROSS-PROCESS, not just in-process. It is used to
 * serialize relayer-account transaction submission (and therefore sequence
 * number usage) across ALL backend replicas.
 *
 * Deployment assumption: every replica of this service must share the SAME
 * Postgres instance (the one exposed via `src/config/database.ts`). If replicas
 * are pointed at different databases, the advisory lock provides no mutual
 * exclusion between them and `tx_bad_seq` races can reappear.
 *
 * We use `pg_advisory_xact_lock` inside a transaction so the lock is
 * automatically released when the transaction ends — on success, on failure,
 * and even if the process dies mid-flight (the connection drops and Postgres
 * releases the session/transaction lock). This makes the lock timeout-safe and
 * avoids leaking locks.
 */

/** Derive a stable signed 64-bit advisory lock key from the relayer public key. */
export function deriveRelayerLockKey(relayerPublicKey: string): bigint {
  const digest = createHash('sha256').update(relayerPublicKey).digest()
  // Take the first 8 bytes as a signed 64-bit bigint (Postgres bigint range).
  return digest.readBigInt64BE(0)
}

export class PostgresAdvisoryLock {
  private readonly key: bigint

  constructor(relayerPublicKey: string) {
    this.key = deriveRelayerLockKey(relayerPublicKey)
  }

  /** The derived advisory lock key (exposed for logging/testing). */
  get lockKey(): bigint {
    return this.key
  }

  /**
   * Run `fn` while holding the cross-process advisory lock for this relayer.
   *
   * The lock is acquired with `pg_advisory_xact_lock` inside a transaction and
   * released automatically when the transaction commits or rolls back, so it is
   * always released on both success and failure paths.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    return prisma.$transaction(
      async tx => {
        // Blocks until the advisory lock is acquired. Scoped to this transaction.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${this.key})`
        return fn()
      },
      // Allow long-running relayer submissions; the lock itself is bounded by
      // the transaction lifetime and released automatically.
      { timeout: 60_000, maxWait: 60_000 }
    )
  }
}

/** Convenience helper: run `fn` under the cross-process lock for a relayer key. */
export function withRelayerLock<T>(relayerPublicKey: string, fn: () => Promise<T>): Promise<T> {
  return new PostgresAdvisoryLock(relayerPublicKey).run(fn)
}
