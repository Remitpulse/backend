import { describe, expect, it } from 'vitest'

import { deriveRelayerLockKey, withRelayerLock } from '../src/interfaces/soroban/mutex'

describe('deriveRelayerLockKey', () => {
  it('is deterministic for the same key and differs for different keys', () => {
    expect(deriveRelayerLockKey('GABC')).toBe(deriveRelayerLockKey('GABC'))
    expect(deriveRelayerLockKey('GABC')).not.toBe(deriveRelayerLockKey('GXYZ'))
  })
})

describe('withRelayerLock (real Postgres advisory lock)', () => {
  it('runs fn and returns its result', async () => {
    const lockKey = `test-lock-${Date.now()}-a`
    const result = await withRelayerLock(lockKey, async () => 'done')
    expect(result).toBe('done')
  })

  it('releases the lock on success, so a second sequential call does not hang', async () => {
    const lockKey = `test-lock-${Date.now()}-b`
    await withRelayerLock(lockKey, async () => 'first')
    const second = await withRelayerLock(lockKey, async () => 'second')
    expect(second).toBe('second')
  })

  it('releases the lock when fn throws, so a subsequent call still acquires it', async () => {
    const lockKey = `test-lock-${Date.now()}-c`

    await expect(
      withRelayerLock(lockKey, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    const after = await withRelayerLock(lockKey, async () => 'recovered')
    expect(after).toBe('recovered')
  })

  it('serialises two concurrent calls on the same key so fn never overlaps', async () => {
    const lockKey = `test-lock-${Date.now()}-d`
    let active = 0
    let maxActive = 0

    const run = () =>
      withRelayerLock(lockKey, async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setTimeout(resolve, 50))
        active--
      })

    await Promise.all([run(), run()])
    expect(maxActive).toBe(1)
  })

  it('does not serialise calls on different keys', async () => {
    const results = await Promise.all([
      withRelayerLock(`test-lock-${Date.now()}-e1`, async () => 'e1'),
      withRelayerLock(`test-lock-${Date.now()}-e2`, async () => 'e2'),
    ])
    expect(results).toEqual(['e1', 'e2'])
  })
})
