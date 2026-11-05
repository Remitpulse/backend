import type { Server } from 'node:http'

import express from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { requestJson } from '../src/lib/http-client'

let server: Server
let baseUrl: string
let requestCount: number
let failFirstNRequests: number
let respondStatus: number

function startServer(): Promise<void> {
  const app = express()
  app.all('/thing', (_req, res) => {
    requestCount++
    if (requestCount <= failFirstNRequests) {
      res.destroy()
      return
    }
    res.status(respondStatus).json({ ok: respondStatus < 400 })
  })

  return new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
}

function stopServer(): Promise<void> {
  return new Promise(resolve => (server ? server.close(() => resolve()) : resolve()))
}

beforeEach(async () => {
  requestCount = 0
  failFirstNRequests = 0
  respondStatus = 200
  await startServer()
})

afterEach(async () => {
  await stopServer()
})

describe('requestJson retry behaviour', () => {
  it('succeeds on the first attempt without retrying', async () => {
    const result = await requestJson<{ ok: boolean }>('test', `${baseUrl}/thing`)
    expect(result).toEqual({ ok: true })
    expect(requestCount).toBe(1)
  })

  it('retries a transient network-level failure and eventually succeeds', async () => {
    failFirstNRequests = 1
    const result = await requestJson<{ ok: boolean }>('test', `${baseUrl}/thing`)
    expect(result).toEqual({ ok: true })
    expect(requestCount).toBe(2)
  })

  it('gives up after exhausting retries on a persistent network-level failure', async () => {
    failFirstNRequests = 10
    await expect(requestJson('test', `${baseUrl}/thing`)).rejects.toThrow()
    expect(requestCount).toBe(3)
  })

  it('does not repeat a POST when the server processes it but loses the response', async () => {
    failFirstNRequests = 1
    await expect(requestJson('test', `${baseUrl}/thing`, { json: { amount: '10' } })).rejects.toThrow()
    expect(requestCount).toBe(1)
  })

  it('does not retry an HTTP error status (only network-level failures are retried)', async () => {
    respondStatus = 500
    await expect(requestJson('test', `${baseUrl}/thing`)).rejects.toThrow()
    expect(requestCount).toBe(1)
  })

  it('does not retry an HTTP 4xx status', async () => {
    respondStatus = 404
    await expect(requestJson('test', `${baseUrl}/thing`)).rejects.toThrow()
    expect(requestCount).toBe(1)
  })
})
