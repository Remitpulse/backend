import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express'
import express from 'express'
import request from 'supertest'
import { beforeAll, describe, expect, it } from 'vitest'

// Small, fast limits so the tests don't need hundreds of requests or a long window. Must be
// set before `config/env` is first touched — which happens as soon as ANYTHING that transitively
// imports it is loaded, so even `error-handler.ts` must be imported dynamically below, *after*
// these are set: a static top-level `import` is hoisted above these assignments by the ES module
// spec, so a static import here would load `env` with its defaults before we ever get to run.
process.env.RATE_LIMIT_WINDOW_MS = '5000'
process.env.RATE_LIMIT_MAX = '3'
process.env.SENSITIVE_RATE_LIMIT_MAX = '2'

let apiRateLimit: RequestHandler
let sensitiveRateLimit: RequestHandler
let errorHandler: ErrorRequestHandler
let notFoundHandler: RequestHandler

beforeAll(async () => {
  const rateLimitMod = await import('../src/api/core/middlewares/rate-limit')
  apiRateLimit = rateLimitMod.apiRateLimit
  sensitiveRateLimit = rateLimitMod.sensitiveRateLimit

  const errorHandlerMod = await import('../src/api/core/middlewares/error-handler')
  errorHandler = errorHandlerMod.errorHandler
  notFoundHandler = errorHandlerMod.notFoundHandler
})

function appWithApiLimiter() {
  const app = express()
  app.use(apiRateLimit)
  app.get('/x', (_req, res) => res.json({ ok: true }))
  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}

function appWithSensitiveLimiter() {
  const app = express()
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const userId = req.header('x-user')
    if (userId) req.auth = { userId, email: `${userId}@example.com` }
    next()
  })
  app.use(sensitiveRateLimit)
  app.get('/y', (_req, res) => res.json({ ok: true }))
  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}

describe('apiRateLimit', () => {
  it('allows requests up to the limit and rejects the next one with 429', async () => {
    const app = appWithApiLimiter()

    for (let i = 0; i < 3; i++) {
      const response = await request(app).get('/x')
      expect(response.status).toBe(200)
    }

    const limited = await request(app).get('/x')
    expect(limited.status).toBe(429)
    expect(limited.body.error.code).toBe('TOO_MANY_REQUESTS')
  })
})

describe('sensitiveRateLimit', () => {
  it('keys by userId rather than IP: a different user gets an independent bucket', async () => {
    const app = appWithSensitiveLimiter()

    // Exhaust user-a's bucket (limit = 2)
    expect((await request(app).get('/y').set('x-user', 'user-a')).status).toBe(200)
    expect((await request(app).get('/y').set('x-user', 'user-a')).status).toBe(200)
    const exhausted = await request(app).get('/y').set('x-user', 'user-a')
    expect(exhausted.status).toBe(429)

    // user-b, same IP (loopback, same as user-a since both come from supertest), fresh bucket
    const otherUser = await request(app).get('/y').set('x-user', 'user-b')
    expect(otherUser.status).toBe(200)
  })

  it('falls back to IP keying when there is no authenticated user', async () => {
    const app = appWithSensitiveLimiter()

    expect((await request(app).get('/y')).status).toBe(200)
    expect((await request(app).get('/y')).status).toBe(200)
    const limited = await request(app).get('/y')
    expect(limited.status).toBe(429)
  })
})
