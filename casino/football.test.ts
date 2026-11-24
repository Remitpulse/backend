import assert from 'node:assert/strict'
import { test } from 'node:test'
import { currentFootballResults, footballFixture, loadFootballFixtures, loadFootballResults } from './football.ts'

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

test('supplemental result lookup batches only distinct provider IDs', async () => {
  const inputs = ['football-data:123', 'football-data:123', 'fake-1', 'football-data:456']
  const fixtures = await loadFootballResults('fixture-token', inputs, async input => {
    const url = new URL(String(input))
    assert.equal(url.searchParams.get('ids'), '123,456')
    assert.equal(url.searchParams.has('dateFrom'), false)
    return Response.json({ matches: [match] })
  })
  assert.deepEqual(fixtures.map(fixture => fixture.id), ['football-data:123'])
  assert.deepEqual(await loadFootballResults('fixture-token', ['fake-1'], async () => {
    throw new Error('No provider request was expected.')
  }), [])
})


test('drops malformed and ambiguous provider rows while preserving valid fixtures', async () => {
  const fixtures = await loadFootballFixtures('fixture-token', Date.parse(match.utcDate), async () =>
    Response.json({ matches: [
      match,
      { ...match, status: 'TIMED' },
      { ...match, id: 124, homeTeam: { name: { malformed: true } } },
      { ...match, id: 125, homeTeam: { name: '   ' } },
      { ...match, id: -1 },
      { ...match, id: 126, homeTeam: { name: ' Home ' } },
    ] }),
  )
  assert.equal(fixtures.length, 1)
  assert.equal(fixtures[0].id, 'football-data:126')
  assert.equal(fixtures[0].home, 'Home')
})

test('coalesces supplemental checks for the same set of provider matches', async () => {
  let calls = 0
  const fetcher: typeof fetch = async () => {
    calls++
    return Response.json({ matches: [{ ...match, id: 700 }, { ...match, id: 701 }] })
  }
  const events = ['football-data:700', 'football-data:701']
  const [first, second] = await Promise.all([
    currentFootballResults('fixture-token', events, fetcher),
    currentFootballResults('fixture-token', [...events].reverse(), fetcher),
  ])
  assert.deepEqual(first, second)
  assert.equal(first.length, 2)
  assert.equal(calls, 1)
})
