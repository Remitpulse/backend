import assert from 'node:assert/strict'
import { test } from 'node:test'
import { footballFixture, loadFootballFixtures } from './football.ts'

const match = {
  id: 123,
  utcDate: '2026-11-23T19:30:00Z',
  status: 'FINISHED',
  competition: { name: 'Cup' },
  homeTeam: { name: 'Home' },
  awayTeam: { name: 'Away' },
}

test('football result follows regulation time when extra time or penalties decide the match', () => {
  for (const duration of ['EXTRA_TIME', 'PENALTY_SHOOTOUT']) {
    const score = { duration, regularTime: { home: 1, away: 1 }, fullTime: { home: 4, away: 3 } }
    assert.deepEqual(footballFixture({ ...match, score })?.result, { winner: 1, score: '1–1' })
    assert.equal(footballFixture({ ...match, score: { ...score, regularTime: undefined } })?.result, null)
  }
})

test('football results require a terminal status and two valid scores', () => {
  const score = { duration: 'REGULAR', fullTime: { home: 0, away: 2 } }
  assert.deepEqual(footballFixture({ ...match, score })?.result, { winner: 2, score: '0–2' })
  assert.equal(footballFixture({ ...match, score, status: 'IN_PLAY' })?.result, null)
  assert.equal(footballFixture({ ...match, score: { ...score, fullTime: { home: null, away: 2 } } })?.result, null)
})

test('football requests use UTC date filters and authenticate only with the provider', async () => {
  const fixtures = await loadFootballFixtures('fixture-token', Date.parse(match.utcDate), async (input, options) => {
    const url = new URL(String(input))
    assert.equal(url.origin, 'https://api.football-data.org')
    assert.equal(url.searchParams.get('dateFrom'), '2026-11-21')
    assert.equal(url.searchParams.get('dateTo'), '2026-11-30')
    assert.equal(new Headers(options?.headers).get('X-Auth-Token'), 'fixture-token')
    assert.equal(options?.redirect, 'error')
    return Response.json({ matches: [match, { id: 124 }, null] })
  })
  assert.deepEqual(fixtures.map(fixture => fixture.id), ['football-data:123'])
})
