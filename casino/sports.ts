import { randomInt, randomUUID } from 'node:crypto'
import { atomic, db, player, record } from './store.ts'
import { parseXlm, STROOPS } from './money.ts'
import { currentFootballFixtures, loadFootballResults, type FootballFixture } from './football.ts'
import type { Command } from './game.ts'

const fixtures = [
  { sport: 'Football', league: 'Orion League', home: 'Harbor City', away: 'Northbridge Athletic', weights: [45, 25, 30] },
  { sport: 'Football', league: 'Orion League', home: 'Eastgate United', away: 'Vale Rovers', weights: [33, 28, 39] },
  { sport: 'Basketball', league: 'Lunar Hoops', home: 'Metro Comets', away: 'Bay Meteors', weights: [58, 42] },
  { sport: 'Basketball', league: 'Lunar Hoops', home: 'Summit Five', away: 'Cobalt Flyers', weights: [51, 49] },
  { sport: 'Tennis', league: 'Apex Open', home: 'Maya Voss', away: 'Lina Cross', weights: [62, 38] },
  { sport: 'Tennis', league: 'Apex Open', home: 'Jonah Hale', away: 'Niko Ray', weights: [46, 54] },
] as const
const interval = 180_000
const duration = 45_000
type Fixture = (typeof fixtures)[number]

function market(index: number, window: number) {
  const { weights, ...fixture } = fixtures[index]
  const starts = (window + 1) * interval + index * 12_000
  const labels = weights.length === 3 ? [fixture.home, 'Draw', fixture.away] : [fixture.home, fixture.away]
  return {
    ...fixture,
    id: window + '-' + index,
    starts,
    settles: starts + duration,
    options: labels.map((label, selection) => ({ label, selection, price: Math.floor(9500 / weights[selection]) })),
  }
}

type Ticket = {
  id: string
  event: string
  label: string
  selection: number
  selectionLabel: string
  price: number
  stake: string
  payout: string
  state: 'Open' | 'Won' | 'Lost' | 'Void'
  settles: number
  score: string | null
  revisedScore: string | null
}

function tickets(id: string) {
  return db()
    .prepare(
      `SELECT id, event, label, selection, selection_label AS selectionLabel,
    price, CAST(stake AS TEXT) AS stake, CAST(payout AS TEXT) AS payout,
    state, settles, score,
    (SELECT revision.score FROM sports_result_revision revision WHERE revision.event = sports_ticket.event) AS revisedScore
    FROM sports_ticket WHERE player = ? ORDER BY rowid DESC LIMIT 30`
    )
    .all(id) as Ticket[]
}

function simulate(fixture: Fixture) {
  let draw = randomInt(100)
  const winner = fixture.weights.findIndex(weight => (draw -= weight) < 0)
  const tied = fixture.weights.length === 3 && winner === 1
  const homeWon = winner === 0
  const low = fixture.sport === 'Football' ? randomInt(3) : fixture.sport === 'Tennis' ? randomInt(2) : randomInt(78, 110)
  const high = fixture.sport === 'Football' ? low + randomInt(1, 4) : fixture.sport === 'Tennis' ? 2 : low + randomInt(1, 18)
  return { winner, score: tied ? low + '–' + low : homeWon ? high + '–' + low : low + '–' + high }
}

function settle(id: string, now: number, football: FootballFixture[] = []) {
  const due = db()
    .prepare(
      `SELECT id, event, selection, price, CAST(stake AS TEXT) AS stake FROM sports_ticket
    WHERE player = ? AND state = 'Open' AND settles <= ? ORDER BY rowid`
    )
    .all(id, now) as Pick<Ticket, 'id' | 'event' | 'selection' | 'price' | 'stake'>[]
  for (const ticket of due) {
    let result = db().prepare('SELECT winner, score FROM sports_result WHERE event = ?').get(ticket.event) as
      ReturnType<typeof simulate> | undefined
    if (!result) {
      if (ticket.event.startsWith('football-data:')) {
        const actual = football.find(match => match.id === ticket.event)
        if (!actual) continue
        if (actual.status === 'CANCELLED' || actual.status === 'AWARDED') {
          const stake = BigInt(ticket.stake)
          db().prepare("UPDATE sports_ticket SET state = 'Void', payout = ?, score = ? WHERE id = ?")
            .run(stake, actual.status, ticket.id)
          db().prepare('UPDATE player SET demo = demo + ? WHERE id = ?').run(stake, id)
          record(id, 'Sports refund', stake, actual.status + ' · Ticket ' + ticket.id.slice(0, 8), 'Sportsbook')
          continue
        }
        if (!actual.result) continue
        result = actual.result
      } else {
        result = simulate(fixtures[Number(ticket.event.split('-')[1])])
      }
      db().prepare('INSERT INTO sports_result VALUES (?, ?, ?)').run(ticket.event, result.winner, result.score)
    }
    const won = result.winner === ticket.selection
    const payout = won ? (BigInt(ticket.stake) * BigInt(ticket.price)) / 100n : 0n
    db()
      .prepare('UPDATE sports_ticket SET state = ?, payout = ?, score = ? WHERE id = ?')
      .run(won ? 'Won' : 'Lost', payout, result.score, ticket.id)
    db().prepare('UPDATE player SET demo = demo + ? WHERE id = ?').run(payout, id)
    record(id, won ? 'Sports payout' : 'Sports result', payout, result.score + ' · Ticket ' + ticket.id.slice(0, 8), 'Sportsbook')
  }
}

export function refreshSports(id: string, now = Date.now()) {
  atomic(() => settle(id, now))
}

export async function sportsbookFootball(id: string) {
  const fixtures = await currentFootballFixtures()
  const token = process.env.CASINO_FOOTBALL_DATA_TOKEN
  if (!fixtures || !token) return fixtures
  const listed = new Set(fixtures.map(fixture => fixture.id))
  const overdue = db().prepare(
    `SELECT event FROM sports_ticket WHERE player = ? AND state = 'Open'
     AND event LIKE 'football-data:%' AND settles <= ? ORDER BY settles`,
  ).all(id, Date.now()).flatMap(({ event }) =>
    typeof event === 'string' && !listed.has(event) ? [event] : [],
  )
  try {
    const older = await loadFootballResults(token, overdue)
    // Supplemental responses can settle existing tickets but never open markets.
    return [...fixtures, ...older.filter(fixture => overdue.includes(fixture.id) && fixture.status !== 'TIMED')]
  } catch {
    return fixtures
  }
}

function recordFootballRevisions(football: FootballFixture[], now: number) {
  const settled = db().prepare('SELECT score FROM sports_result WHERE event = ?')
  const save = db().prepare(
    `INSERT INTO sports_result_revision VALUES (?, ?, ?)
     ON CONFLICT(event) DO UPDATE SET score = excluded.score, observed = excluded.observed
     WHERE score <> excluded.score`,
  )
  const clear = db().prepare('DELETE FROM sports_result_revision WHERE event = ?')
  for (const match of football) {
    if (!match.result) continue
    const original = settled.get(match.id)
    if (!original) continue
    if (original.score === match.result.score) clear.run(match.id)
    else save.run(match.id, match.result.score, now)
  }
}

export function sportsbook(id: string, input: Command, now = Date.now(), football: FootballFixture[] | null = null) {
  return atomic(() => {
    settle(id, now, football ?? [])
    if (football?.length) recordFootballRevisions(football, now)
    const window = Math.floor(now / interval)
    const simulated = fixtures.map((_, index) => {
      const previous = market(index, window - 1)
      return previous.starts > now ? previous : market(index, window)
    })
    const real = (football ?? []).filter(match => match.status === 'TIMED' && match.starts > now)
      .map(({ id, starts, sport, league, home, away }) => ({
        id, starts, settles: starts, sport, league, home, away,
        options: [home, 'Draw', away].map((label, selection) => ({ label, selection, price: [235, 320, 310][selection] })),
      }))
    const footballStatus = !process.env.CASINO_FOOTBALL_DATA_TOKEN && football === null
      ? 'simulated'
      : football === null ? 'unavailable' : 'current'
    const events = [...real, ...simulated.filter(event => footballStatus === 'simulated' || event.sport !== 'Football')]
    let message: string | undefined
    if (input.action === 'sports-place') {
      const state = player(id)!
      if (state.paused) throw new Error('Demo wagering is paused for this session.')
      const event = events.find(item => item.id === input.event)
      const option = event?.options.find(item => item.selection === input.selection)
      if (!event || !option || now >= event.starts || option.price !== input.price ||
          (event.id.startsWith('football-data:') && event.starts !== input.starts)) {
        throw new Error('This market or price has expired. Refresh the fixtures.')
      }
      if (db().prepare('SELECT id FROM sports_ticket WHERE player = ? AND event = ?').get(id, event.id)) {
        throw new Error('You already have a ticket for this fixture.')
      }
      const stake = parseXlm(input.amount)
      if (stake <= 0n || stake > 100n * STROOPS || stake > state.demo) {
        throw new Error('Enter a positive wager up to 100 XLM within your demo balance.')
      }
      db()
        .prepare(
          `INSERT INTO sports_ticket
        (id, player, event, label, selection, selection_label, price, stake, settles) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          randomUUID(),
          id,
          event.id,
          event.home + ' vs ' + event.away,
          option.selection,
          option.label,
          option.price,
          stake,
          event.settles
        )
      db().prepare('UPDATE player SET demo = demo - ? WHERE id = ?').run(stake, id)
      record(id, 'Sports wager', -stake, event.home + ' vs ' + event.away + ' · ' + option.label, 'Sportsbook')
      message = 'Demo ticket accepted.'
    }
    return { sports: { events, tickets: tickets(id), time: now, footballStatus }, message }
  })
}
