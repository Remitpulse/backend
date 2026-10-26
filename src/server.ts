import { initSentry } from './config/sentry'

initSentry()

import { createApp } from './app'
import { prisma } from './config/database'
import { env } from './config/env'
import { logger } from './config/logger'
import { Sentry, sentryEnabled } from './config/sentry'
import { syncTransactionById } from './api/anchors/service'
import { runRemittancePollTick } from './jobs/remittance-poller'

process.on('uncaughtException', error => {
  logger.fatal({ err: error }, 'Uncaught exception')
  if (sentryEnabled) Sentry.captureException(error)
  process.exit(1)
})
process.on('unhandledRejection', reason => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection')
  if (sentryEnabled) Sentry.captureException(reason)
  process.exit(1)
})

const app = createApp()

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, network: env.STELLAR_NETWORK_PASSPHRASE }, 'RemitPulse backend listening')
})

let pollerRunning = false

async function pollStaleRemittances(): Promise<void> {
  if (pollerRunning) {
    logger.debug('Remittance poller tick skipped: previous tick still running')
    return
  }
  pollerRunning = true
  try {
    await runRemittancePollTick({
      prisma,
      syncTransaction: async id => {
        try {
          await syncTransactionById(id)
        } catch (err) {
          logger.error({ err, transactionId: id }, 'Remittance poller: failed to sync transaction')
          if (sentryEnabled) Sentry.captureException(err)
        }
      },
      staleAfterSeconds: env.REMITTANCE_POLL_STALE_AFTER_SECONDS,
      batchSize: env.REMITTANCE_POLL_BATCH_SIZE,
    })
  } catch (err) {
    logger.error({ err }, 'Remittance poller tick failed')
    if (sentryEnabled) Sentry.captureException(err)
  } finally {
    pollerRunning = false
  }
}

let pollerInterval: ReturnType<typeof setInterval> | null = null
if (env.REMITTANCE_POLL_INTERVAL_SECONDS > 0) {
  pollerInterval = setInterval(() => void pollStaleRemittances(), env.REMITTANCE_POLL_INTERVAL_SECONDS * 1000)
  if (typeof pollerInterval.unref === 'function') pollerInterval.unref()

  logger.info(
    {
      intervalSeconds: env.REMITTANCE_POLL_INTERVAL_SECONDS,
      staleAfterSeconds: env.REMITTANCE_POLL_STALE_AFTER_SECONDS,
      batchSize: env.REMITTANCE_POLL_BATCH_SIZE,
    },
    'Remittance poller started'
  )
} else {
  logger.info('Remittance poller disabled (REMITTANCE_POLL_INTERVAL_SECONDS=0)')
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down')
  if (pollerInterval) clearInterval(pollerInterval)
  server.close()
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
