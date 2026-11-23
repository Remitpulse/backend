import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createPlayer, player, snapshot } from './store.ts'
import { sportsbook } from './sports.ts'
import { play } from './game.ts'

process.env.CASINO_DATA_DIR = mkdtempSync(join(tmpdir(), 'casino-sports-'))

test('sports preserves one result per fixture, exact stroops and the Testnet balance', () => {
  const now = 18_000_000
  const home = 'sports-home'
  const away = 'sports-away'
  createPlayer(home)
  createPlayer(away)
  const market = sportsbook(home, { action: 'sports-market' }, now).sports.events
  const match = market.find(event => event.sport === 'Basketball')!
  const stake = 1_234_567n
  const bet = (selection: number) => ({
    action: 'sports-place',
    event: match.id,
    selection,
    price: match.options[selection].price,
    amount: '0.1234567',
  })
  assert.throws(() => sportsbook(home, { ...bet(0), price: 9000 }, now), /expired/)
  const booked = sportsbook(home, bet(0), now).sports.tickets[0]
  assert.equal(booked.state, 'Open')
  assert.equal(booked.stake, stake.toString())
  assert.throws(() => sportsbook(home, bet(0), now), /already/)
  sportsbook(away, bet(1), now)
  assert.equal(sportsbook(home, {}, match.settles - 1).sports.tickets[0].state, 'Open')
  const first = sportsbook(home, {}, match.settles).sports.tickets[0]
  const second = sportsbook(away, {}, match.settles).sports.tickets[0]
  assert.equal(first.score, second.score)
  assert.deepEqual([first.state, second.state].sort(), ['Lost', 'Won'])
  for (const [id, ticket] of [
    [home, first],
    [away, second],
  ] as const) {
    const expected = ticket.state === 'Won' ? (stake * BigInt(ticket.price)) / 100n : 0n
    assert.equal(BigInt(ticket.payout), expected)
    const after = 10_000_000_000n - stake + expected
    assert.equal(player(id)?.demo, after)
    sportsbook(id, {}, match.settles + 5000)
    assert.equal(player(id)?.demo, after)
    assert.equal(player(id)?.testnet, 0n)
  }
})

test('sports respects market cutoff and account pause', () => {
  createPlayer('sports-paused')
  const now = 18_000_000
  const match = sportsbook('sports-paused', {}, now).sports.events[0]
  const bet = { action: 'sports-place', event: match.id, selection: 0, price: match.options[0].price, amount: '1' }
  assert.throws(() => sportsbook('sports-paused', bet, match.starts), /expired/)
  play('sports-paused', { action: 'pause' })
  assert.throws(() => sportsbook('sports-paused', bet, now), /paused/)
  assert.equal(player('sports-paused')?.demo, 10_000_000_000n)
})

test('Mines locks the chosen mine count into the round', () => {
  createPlayer('mines-risk')
  assert.throws(() => play('mines-risk', { action: 'play', game: 'mines', amount: '1', setting: 25 }))
  play('mines-risk', { action: 'play', game: 'mines', amount: '1', setting: 24 })
  assert.equal(snapshot('mines-risk').round?.mineCount, 24)
  assert.equal(snapshot('mines-risk').round?.nextPayout, '247500000')
  const hidden = JSON.parse(player('mines-risk')!.mines!) as number[]
  const safe = Array.from({ length: 25 }, (_, i) => i).find(i => !hidden.includes(i))!
  const settled = play('mines-risk', { action: 'reveal', tile: safe, setting: 1 })
  assert.equal(settled.payout, '247500000')
})

test('provider tickets await regulation results and are settled or refunded only once', () => {
  const now = 18_000_000
  const id = 'provider-ticket'
  createPlayer(id)
  const timed = {
    id: 'football-data:123', starts: now + 60_000, sport: 'Football' as const,
    league: 'Example League', home: 'Home', away: 'Away', status: 'TIMED', result: null,
  }
  const second = { ...timed, id: 'football-data:456' }
  for (const event of [timed, second]) {
    sportsbook(id, {
      action: 'sports-place', event: event.id, starts: event.starts, selection: 0, price: 235, amount: '1.0000001',
    }, now, [event])
  }
  const refresh = (matches: Parameters<typeof sportsbook>[3]) =>
    sportsbook(id, { action: 'sports-market' }, now + 80_000, matches).sports.tickets
  assert.ok(refresh(null).every(ticket => ticket.state === 'Open'))
  assert.ok(refresh([{ ...timed, status: 'POSTPONED' }]).every(ticket => ticket.state === 'Open'))
  const outcomes = [
    { ...timed, status: 'FINISHED', result: { winner: 0, score: '2–1' } },
    { ...second, status: 'CANCELLED' },
  ]
  const settled = refresh(outcomes)
  assert.equal(settled.find(ticket => ticket.event === timed.id)?.payout, '23500002')
  assert.equal(settled.find(ticket => ticket.event === second.id)?.state, 'Void')
  assert.equal(settled.find(ticket => ticket.event === second.id)?.payout, '10000001')
  const balance = player(id)!.demo
  refresh(outcomes)
  assert.equal(player(id)!.demo, balance)
  assert.equal(player(id)!.testnet, 0n)
})


test('provider kickoff changes invalidate the selected quote before reserving a stake', () => {
  const id = 'rescheduled-quote'
  const now = 18_000_000
  createPlayer(id)
  const match = {
    id: 'football-data:987', starts: now + 60_000, sport: 'Football' as const,
    league: 'Example League', home: 'Home', away: 'Away', status: 'TIMED', result: null,
  }
  const bet = { action: 'sports-place', event: match.id, starts: match.starts, selection: 0, price: 235, amount: '1' }
  assert.throws(() => sportsbook(id, bet, now, [{ ...match, starts: match.starts + 60_000 }]), /expired/)
  assert.equal(player(id)?.demo, 10_000_000_000n)
  assert.equal(sportsbook(id, bet, now, [match]).sports.tickets.length, 1)
})
