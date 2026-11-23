const endpoint = 'https://api.football-data.org/v4/matches'
const day = 86_400_000

type Match = {
  id?: number
  utcDate?: string
  status?: string
  competition?: { name?: string }
  homeTeam?: { name?: string }
  awayTeam?: { name?: string }
  score?: {
    duration?: string
    fullTime?: Score
    regularTime?: Score
  }
}
type Score = { home?: number | null; away?: number | null }

export function footballFixture(match: Match) {
  const starts = Date.parse(match.utcDate ?? '')
  const { id, status } = match
  const league = match.competition?.name
  const home = match.homeTeam?.name
  const away = match.awayTeam?.name
  if (!Number.isSafeInteger(id) || !Number.isFinite(starts) || !status || !league || !home || !away) return null
  const score = match.score?.duration === 'REGULAR' ? match.score.fullTime : match.score?.regularTime
  const homeGoals = score?.home
  const awayGoals = score?.away
  const result = status === 'FINISHED'
    && typeof homeGoals === 'number' && Number.isSafeInteger(homeGoals) && homeGoals >= 0
    && typeof awayGoals === 'number' && Number.isSafeInteger(awayGoals) && awayGoals >= 0
    ? { winner: homeGoals === awayGoals ? 1 : homeGoals > awayGoals ? 0 : 2, score: `${homeGoals}–${awayGoals}` }
    : null
  return { id: 'football-data:' + id, starts, sport: 'Football' as const, league, home, away, status, result }
}

export async function loadFootballFixtures(token: string, now = Date.now(), fetcher = fetch) {
  const url = new URL(endpoint)
  url.searchParams.set('dateFrom', new Date(now - 2 * day).toISOString().slice(0, 10))
  url.searchParams.set('dateTo', new Date(now + 7 * day).toISOString().slice(0, 10))
  const response = await fetcher(url, {
    headers: { 'X-Auth-Token': token },
    signal: AbortSignal.timeout(6000),
    redirect: 'error',
  })
  if (!response.ok) throw new Error('Football feed unavailable.')
  const payload = await response.json() as { matches?: Match[] }
  if (!Array.isArray(payload?.matches)) throw new Error('Football feed returned an invalid match list.')
  return payload.matches.flatMap(match => {
    const fixture = match && footballFixture(match)
    return fixture ? [fixture] : []
  })
}
