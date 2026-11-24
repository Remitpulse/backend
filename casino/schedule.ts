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

function fixture(row: Record<string, unknown>) {
  const { idEvent, strTimestamp, strSport, strLeague, strHomeTeam, strAwayTeam, strStatus } = row
  if (typeof idEvent !== 'string' || !/^\d+$/.test(idEvent) ||
      typeof strTimestamp !== 'string' ||
      typeof strSport !== 'string' || !strSport.trim() ||
      typeof strLeague !== 'string' || !strLeague.trim() ||
      typeof strHomeTeam !== 'string' || !strHomeTeam.trim() ||
      typeof strAwayTeam !== 'string' || !strAwayTeam.trim() ||
      /cancel|postpon|abandon|finish/i.test(String(strStatus))) return null
  const starts = Date.parse(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(strTimestamp)
    ? strTimestamp + 'Z' : strTimestamp)
  if (!Number.isFinite(starts)) return null
  return {
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

async function loadDay(date: string, key: string) {
  const url = new URL('https://www.thesportsdb.com/api/v1/json/' + encodeURIComponent(key) + '/eventsday.php')
  url.searchParams.set('d', date)
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
  const days = await Promise.all(dates.map(date => {
    const cacheKey = today + ':' + date
    const entry = cache.get(cacheKey)
    if (entry && entry.expires > now) return entry.response
    const response = loadDay(date, key).catch(() => {
      if (cache.get(cacheKey)?.response === response) {
        cache.set(cacheKey, { expires: now + 60_000, response: Promise.resolve(null) })
      }
      return null
    })
    cache.set(cacheKey, { expires: now + dayMs, response })
    return response
  }))
  const fixtures = [...new Map(days.flatMap(day => (day ?? []).map(match => [match.id, match] as const))).values()]
    .filter(match => match.starts > now)
    .sort((left, right) => left.starts - right.starts)
  return {
    status: days.every(day => day === null) ? 'unavailable' as const :
      days.some(day => day === null) ? 'partial' as const : 'current' as const,
    fixtures,
  }
}
