import type { Request } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'

import { env } from '../../../config/env'
import { TooManyRequestsError } from '../../../errors'

export const keyByUserOrIp = (req: Request): string => req.auth?.userId ?? (req.ip ? ipKeyGenerator(req.ip) : 'unknown')

const handler = (): never => {
  throw new TooManyRequestsError()
}

/** General API limiter. */
export const apiRateLimit = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler,
})

/** Tighter limiter for endpoints that spend money (relay, fee-bump) or hit anchors. */
export const sensitiveRateLimit = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.SENSITIVE_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: keyByUserOrIp,
  handler,
})
