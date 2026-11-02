import type { Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { describe, expect, it, vi } from 'vitest'

import { requireAdmin, requireUser, signUserToken, verifyUserToken } from '../src/api/core/middlewares/authentication'
import { env } from '../src/config/env'
import { ForbiddenError, UnauthorizedError } from '../src/errors'

function fakeReq(headers: Record<string, string> = {}): Request {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  return { header: (name: string) => lower[name.toLowerCase()] } as unknown as Request
}

const res = {} as Response

describe('signUserToken / verifyUserToken', () => {
  it('round-trips the userId and email', () => {
    const token = signUserToken({ userId: 'user-123', email: 'alice@example.com' })
    const claims = verifyUserToken(token)
    expect(claims).toEqual({ userId: 'user-123', email: 'alice@example.com' })
  })

  it('rejects a token signed with a different secret', () => {
    const token = jwt.sign({ email: 'alice@example.com' }, 'a-completely-different-secret-32-chars-long', {
      subject: 'user-123',
      issuer: 'remitpulse',
      audience: 'remitpulse-app',
      algorithm: 'HS256',
    })
    expect(() => verifyUserToken(token)).toThrow(UnauthorizedError)
  })

  it('rejects an expired token', () => {
    const token = jwt.sign({ sub: 'user-123', email: 'alice@example.com', exp: Math.floor(Date.now() / 1000) - 60 }, env.JWT_SECRET, {
      issuer: 'remitpulse',
      audience: 'remitpulse-app',
      algorithm: 'HS256',
    })
    expect(() => verifyUserToken(token)).toThrow(UnauthorizedError)
  })

  it('rejects a token with the wrong issuer', () => {
    const token = jwt.sign({ email: 'alice@example.com' }, env.JWT_SECRET, {
      subject: 'user-123',
      issuer: 'someone-else',
      audience: 'remitpulse-app',
      algorithm: 'HS256',
    })
    expect(() => verifyUserToken(token)).toThrow(UnauthorizedError)
  })

  it('rejects a token with the wrong audience', () => {
    const token = jwt.sign({ email: 'alice@example.com' }, env.JWT_SECRET, {
      subject: 'user-123',
      issuer: 'remitpulse',
      audience: 'someone-elses-app',
      algorithm: 'HS256',
    })
    expect(() => verifyUserToken(token)).toThrow(UnauthorizedError)
  })

  it('rejects a malformed token', () => {
    expect(() => verifyUserToken('not-a-jwt-at-all')).toThrow(UnauthorizedError)
  })
})

describe('requireUser', () => {
  it('sets req.auth and calls next for a valid bearer token', () => {
    const token = signUserToken({ userId: 'user-456', email: 'bob@example.com' })
    const req = fakeReq({ authorization: `Bearer ${token}` })
    const next = vi.fn()

    requireUser(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(req.auth).toEqual({ userId: 'user-456', email: 'bob@example.com' })
  })

  it('throws UnauthorizedError when the header is missing', () => {
    const req = fakeReq()
    expect(() => requireUser(req, res, vi.fn())).toThrow(UnauthorizedError)
  })

  it('throws UnauthorizedError for a non-Bearer scheme', () => {
    const req = fakeReq({ authorization: 'Basic dXNlcjpwYXNz' })
    expect(() => requireUser(req, res, vi.fn())).toThrow(UnauthorizedError)
  })

  it('throws UnauthorizedError for an invalid bearer token', () => {
    const req = fakeReq({ authorization: 'Bearer garbage' })
    expect(() => requireUser(req, res, vi.fn())).toThrow(UnauthorizedError)
  })
})

describe('requireAdmin', () => {
  it('calls next for a valid x-api-key', () => {
    const req = fakeReq({ 'x-api-key': env.ADMIN_API_KEYS[0] })
    const next = vi.fn()

    requireAdmin(req, res, next)

    expect(next).toHaveBeenCalledTimes(1)
  })

  it('throws ForbiddenError when the key is missing', () => {
    const req = fakeReq()
    expect(() => requireAdmin(req, res, vi.fn())).toThrow(ForbiddenError)
  })

  it('throws ForbiddenError for a wrong key', () => {
    const req = fakeReq({ 'x-api-key': 'not-the-right-key' })
    expect(() => requireAdmin(req, res, vi.fn())).toThrow(ForbiddenError)
  })
})
