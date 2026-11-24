const endpoint = 'https://api.football-data.org/v4/matches'
const day = 86_400_000

type Match = {
  id?: number
  utcDate?: string
  status?: string
  competition?: { name?: string }
  homeTeam?: { name?: string; crest?: string }
  awayTeam?: { name?: string; crest?: string }
  score?: {
    duration?: string
    fullTime?: Score
    regularTime?: Score
  }
}
type Score = { home?: number | null; away?: number | null }

function label(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, 160) : ''
}

export function footballFixture(match: Match) {
  const starts = typeof match.utcDate === 'string' ? Date.parse(match.utcDate) : NaN
  const { id, status } = match
  const league = label(match.competition?.name)
  const home = label(match.homeTeam?.name)
  const away = label(match.awayTeam?.name)
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(starts) ||
      typeof status !== 'string' || !status || !league || !home || !away || home === away) return null
  const score = match.score?.duration === 'REGULAR' ? match.score.fullTime : match.score?.regularTime
  const homeGoals = score?.home
  const awayGoals = score?.away
  const result = status === 'FINISHED'
    && typeof homeGoals === 'number' && Number.isSafeInteger(homeGoals) && homeGoals >= 0
    && typeof awayGoals === 'number' && Number.isSafeInteger(awayGoals) && awayGoals >= 0
    ? { winner: homeGoals === awayGoals ? 1 : homeGoals > awayGoals ? 0 : 2, score: `${homeGoals}–${awayGoals}` }
    : null
  const crest = (value: unknown) => typeof value === 'string' &&
    /^https:\/\/crests\.football-data\.org\/[\w.-]+\.(?:svg|png|webp)$/.test(value) ? value : undefined
  const badges: { homeBadge?: string; awayBadge?: string } = {
    homeBadge: crest(match.homeTeam?.crest), awayBadge: crest(match.awayTeam?.crest),
  }
  return { ...badges, id: 'football-data:' + id, starts, sport: 'Football' as const, league, home, away, status, result }
}

export async function loadFootballFixtures(token: string, now = Date.now(), fetcher = fetch) {
  const url = new URL(endpoint)
  url.searchParams.set('dateFrom', new Date(now - 2 * day).toISOString().slice(0, 10))
  url.searchParams.set('dateTo', new Date(now + 7 * day).toISOString().slice(0, 10))
  return fetchFootballFixtures(url, token, fetcher)
}

export async function loadFootballResults(token: string, events: string[], fetcher = fetch) {
  const ids = events.flatMap(event => {
    const match = /^football-data:([1-9][0-9]{0,14})$/.exec(event)
    return match ? [match[1]] : []
  })
  if (!ids.length) return []
  const url = new URL(endpoint)
  url.searchParams.set('ids', [...new Set(ids)].slice(0, 25).join(','))
  return fetchFootballFixtures(url, token, fetcher)
}

async function fetchFootballFixtures(url: URL, token: string, fetcher: typeof fetch) {
  const response = await fetcher(url, {
    headers: { 'X-Auth-Token': token },
    signal: AbortSignal.timeout(6000),
    redirect: 'error',
  })
  if (!response.ok) throw new Error('Football feed unavailable.')
  const payload = await response.json() as { matches?: Match[] }
  if (!Array.isArray(payload?.matches)) throw new Error('Football feed returned an invalid match list.')
  const fixtures = new Map<string, FootballFixture>()
  const repeated = new Set<string>()
  for (const match of payload.matches) {
    const fixture = match && typeof match === 'object' && footballFixture(match)
    if (!fixture) continue
    if (fixtures.has(fixture.id)) repeated.add(fixture.id)
    else fixtures.set(fixture.id, fixture)
  }
  for (const id of repeated) fixtures.delete(id)
  return [...fixtures.values()]
}

export type FootballFixture = NonNullable<ReturnType<typeof footballFixture>>

const freshness = 60_000
let cached: { fetchedAt: number; fixtures: FootballFixture[] } | undefined
let inFlight: Promise<FootballFixture[] | null> | undefined
let retryAt = 0

const supplemental = new Map<string, { until: number; request: Promise<FootballFixture[]> }>()

export async function currentFootballResults(token: string, events: string[], fetcher = fetch) {
  if (!events.length) return []
  const batch = events.slice(0, 25)
  const key = JSON.stringify([...batch].sort())
  const now = Date.now()
  const existing = supplemental.get(key)
  if (existing && existing.until > now) return existing.request

  const request = loadFootballResults(token, batch, fetcher).catch(() => [])
  supplemental.delete(key)
  supplemental.set(key, { until: now + freshness, request })
  if (supplemental.size > 128) {
    const first = supplemental.keys().next().value
    if (first !== undefined) supplemental.delete(first)
  }
  return request
}

export async function currentFootballFixtures(): Promise<FootballFixture[] | null> {
  const token = process.env.CASINO_FOOTBALL_DATA_TOKEN
  if (!token) return null
  const now = Date.now()
  if (cached && now - cached.fetchedAt < freshness) return cached.fixtures
  if (inFlight) return inFlight
  if (now < retryAt) return null
  inFlight = loadFootballFixtures(token, now)
    .then(fixtures => {
      cached = { fetchedAt: now, fixtures }
      return fixtures
    })
    .catch(() => {
      retryAt = Date.now() + 15_000
      return null
    })
    .finally(() => { inFlight = undefined })
  return inFlight
}
