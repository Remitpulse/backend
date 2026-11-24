const dayMs = 86_400_000
const dateKey = (time: number) => new Date(time).toISOString().slice(0, 10)
const badgeHosts = new Set(['r2.thesportsdb.com', 'www.thesportsdb.com'])

function badge(value: unknown) {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && badgeHosts.has(url.host) &&
        !url.username && !url.password && url.pathname.startsWith('/images/media/team/badge/')) {
      return url.href
    }
  } catch {
    // A fixture can still be displayed without its badge.
  }
}

const scheduledStatus = /^(?:|NS|TBD|Not Started|Scheduled)$/i
const finalStatus = /^(?:FT|AET|PEN|Final|Finished|Match Finished|After Extra Time|After Penalties)$/i
const voidStatus = /^(?:CANC|ABD|AWD|WO|Cancelled|Canceled|Abandoned|Awarded|Walkover)$/i
const drawable = new Set(['Football', 'Ice Hockey', 'American Football', 'Rugby', 'Rugby League', 'Rugby Union', 'Handball'])
const supported = new Set([...drawable, 'Basketball', 'Baseball', 'Tennis', 'Volleyball', 'Cricket', 'Badminton', 'Table Tennis', 'Netball', 'Water Polo', 'Field Hockey'])

function fixture(row: Record<string, unknown>) {
  const { idEvent, strTimestamp, strSport, strLeague, strHomeTeam, strAwayTeam, strStatus } = row
  if (typeof idEvent !== 'string' || !/^\d+$/.test(idEvent) ||
      typeof strTimestamp !== 'string' ||
      typeof strSport !== 'string' || !strSport.trim() ||
      typeof strLeague !== 'string' || !strLeague.trim() ||
      typeof strHomeTeam !== 'string' || !strHomeTeam.trim() ||
      typeof strAwayTeam !== 'string' || !strAwayTeam.trim() ||
      strHomeTeam === strAwayTeam) return null
  const starts = Date.parse(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(strTimestamp)
    ? strTimestamp + 'Z' : strTimestamp)
  if (!Number.isFinite(starts)) return null
  return {
    status: typeof strStatus === 'string' ? strStatus.trim() : '',
    id: 'sportsdb:' + idEvent,
    starts,
    sport: strSport === 'Soccer' ? 'Football' : strSport,
    league: strLeague,
    home: strHomeTeam,
    away: strAwayTeam,
    homeBadge: badge(row.strHomeTeamBadge),
    awayBadge: badge(row.strAwayTeamBadge),
  }
}

const dailyFilters = [
  {},
  { s: 'Soccer' },
  { l: '4480' }, // UEFA Champions League
  { s: 'Basketball' },
  { s: 'Tennis' },
]

async function loadDay(date: string, key: string, filters: Record<string, string | undefined>) {
  const url = new URL('https://www.thesportsdb.com/api/v1/json/' + encodeURIComponent(key) + '/eventsday.php')
  url.searchParams.set('d', date)
  for (const [name, value] of Object.entries(filters)) {
    if (value) url.searchParams.set(name, value)
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(6000), redirect: 'error' })
  if (!response.ok) throw new Error('Schedule request failed.')
  const { events } = await response.json() as { events?: unknown }
  if (events === null) return []
  if (!Array.isArray(events)) throw new Error('Invalid schedule response.')
  return events.flatMap(row => row && typeof row === 'object' ? fixture(row) ?? [] : [])
}

type ScheduleFixture = NonNullable<ReturnType<typeof fixture>>
const cache = new Map<string, { expires: number; response: Promise<ScheduleFixture[] | null> }>()

export async function dailySchedule(now = Date.now()) {
  const key = process.env.CASINO_SPORTSDB_KEY
  if (!key) return { status: 'disabled' as const, fixtures: [] }
  const today = dateKey(now)
  const dates = [today, dateKey(now + dayMs)]
  for (const date of cache.keys()) {
    if (!date.startsWith(today + ':')) cache.delete(date)
  }
  const queries = dates.flatMap(date => dailyFilters.map((filters, index) => ({ date, filters, index })))
  const days = await Promise.all(queries.map(({ date, filters, index }) => {
    const cacheKey = today + ':' + date + ':' + index
    const entry = cache.get(cacheKey)
    if (entry && entry.expires > now) return entry.response
    const response = loadDay(date, key, filters).catch(() => {
      if (cache.get(cacheKey)?.response === response) {
        cache.set(cacheKey, { expires: now + 60_000, response: Promise.resolve(null) })
      }
      return null
    })
    cache.set(cacheKey, { expires: now + dayMs, response })
    return response
  }))
  const fixtures = [...new Map(days.flatMap(day => (day ?? []).map(match => [match.id, match] as const))).values()]
    .filter(match => match.starts > now && scheduledStatus.test(match.status))
    .sort((left, right) => left.starts - right.starts)
  return {
    status: days.every(day => day === null) ? 'unavailable' as const :
      days.some(day => day === null) ? 'partial' as const : 'current' as const,
    fixtures,
  }
}


export function scheduledMarket(match: ScheduleFixture) {
  if (!supported.has(match.sport)) return []
  const labels = drawable.has(match.sport) ? [match.home, 'Draw', match.away] : [match.home, match.away]
  const prices = labels.length === 3 ? [270, 310, 270] : [190, 190]
  return [{
    ...match,
    settles: match.starts,
    options: labels.map((label, selection) => ({ label, selection, price: prices[selection] })),
  }]
}

export function scheduleResult(row: Record<string, unknown>) {
  const status = typeof row.strStatus === 'string' ? row.strStatus.trim() : ''
  if (voidStatus.test(status)) return { void: true as const, score: status }
  if (!finalStatus.test(status)) return
  const match = fixture(row)
  if (!match || !supported.has(match.sport)) return
  const rawHome = row.intHomeScore
  const rawAway = row.intAwayScore
  if (!/^\d+$/.test(String(rawHome)) || !/^\d+$/.test(String(rawAway))) return
  const home = Number(rawHome)
  const away = Number(rawAway)
  if (!Number.isSafeInteger(home) || !Number.isSafeInteger(away)) return
  const score = home + '–' + away
  const draw = drawable.has(match.sport)
  if (home === away && !draw) return { void: true as const, score }
  return { winner: home === away ? 1 : home > away ? 0 : draw ? 2 : 1, score }
}

type Lookup = { match: ScheduleFixture | null; result: ReturnType<typeof scheduleResult> }
const lookups = new Map<string, { expires: number; response: Promise<Lookup | undefined> }>()
let budgetUntil = 0
let requests = 0

export function scheduleLookup(id: string, now = Date.now()) {
  const key = process.env.CASINO_SPORTSDB_KEY
  const providerId = /^sportsdb:(\d{1,16})$/.exec(id)?.[1]
  if (!key || !providerId) return
  const existing = lookups.get(id)
  if (existing && existing.expires > now) return existing.response
  if (now >= budgetUntil) {
    budgetUntil = now + 60_000
    requests = 0
  }
  if (requests >= 15) return
  requests++
  const url = new URL('https://www.thesportsdb.com/api/v1/json/' + encodeURIComponent(key) + '/lookupevent.php')
  url.searchParams.set('id', providerId)
  const response = fetch(url, { signal: AbortSignal.timeout(6000), redirect: 'error' }).then(async response => {
    if (!response.ok) return
    const { events } = await response.json() as { events?: unknown }
    if (!Array.isArray(events) || events.length !== 1 || events[0]?.idEvent !== providerId) return
    return { match: fixture(events[0]), result: scheduleResult(events[0]) }
  }).catch(() => undefined)
  lookups.delete(id)
  lookups.set(id, { expires: now + 30_000, response })
  if (lookups.size > 256) {
    const oldest = lookups.keys().next().value
    if (oldest) lookups.delete(oldest)
  }
  return response
}

export type Schedule = Awaited<ReturnType<typeof dailySchedule>>
export type ScheduleResults = Map<string, NonNullable<Lookup['result']>>
export function verifiedScheduledMatch(expected: ScheduleFixture, actual?: ScheduleFixture | null) {
  return actual?.id === expected.id && actual.starts === expected.starts &&
    actual.home === expected.home && actual.away === expected.away && actual.sport === expected.sport &&
    scheduledStatus.test(actual.status)
}
