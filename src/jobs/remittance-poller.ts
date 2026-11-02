import type { PrismaClient } from '@prisma/client'

import { logger } from '../config/logger'

const TERMINAL_STATUSES: ('completed' | 'failed')[] = ['completed', 'failed']

export type RunRemittancePollTickOptions = {
  prisma: Pick<PrismaClient, 'remittanceTransaction'>
  syncTransaction: (transactionId: string) => Promise<void>
  /** Marks a transaction failed without contacting the anchor again. Required to use `expireAfterSeconds`. */
  expireTransaction?: (transactionId: string) => Promise<void>
  staleAfterSeconds: number
  /** Non-terminal transactions older than this are expired instead of synced. Omit to never expire. */
  expireAfterSeconds?: number
  batchSize: number
}

/**
 * Finds non-terminal remittance transactions whose `updatedAt` is older than
 * `staleAfterSeconds` and re-syncs each with its anchor, one small batch at a time.
 * Any transaction older than `expireAfterSeconds` (e.g. an abandoned SEP-24 interactive
 * session) is marked failed via `expireTransaction` instead of being synced again.
 * Failures are logged per-transaction and never abort the batch.
 */
export async function runRemittancePollTick(options: RunRemittancePollTickOptions): Promise<void> {
  const { prisma, syncTransaction, expireTransaction, staleAfterSeconds, expireAfterSeconds, batchSize } = options
  const staleBefore = new Date(Date.now() - staleAfterSeconds * 1000)
  const expireBefore = expireAfterSeconds !== undefined ? new Date(Date.now() - expireAfterSeconds * 1000) : null

  const stale = await prisma.remittanceTransaction.findMany({
    where: { status: { notIn: TERMINAL_STATUSES }, updatedAt: { lt: staleBefore } },
    orderBy: { updatedAt: 'asc' },
    take: batchSize,
    select: { id: true, updatedAt: true },
  })

  for (const { id, updatedAt } of stale) {
    try {
      if (expireBefore && expireTransaction && updatedAt < expireBefore) {
        await expireTransaction(id)
      } else {
        await syncTransaction(id)
      }
    } catch (error) {
      logger.error({ err: error, transactionId: id }, 'Remittance poller: failed to process transaction')
    }
  }
}
