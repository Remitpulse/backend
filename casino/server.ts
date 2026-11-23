import { refreshSports, sportsbook } from './sports.ts'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createPlayer, db, player, snapshot } from './store.ts'
import { play } from './game.ts'
import { hasPasskey, passkey } from './passkeys.ts'
import { payment, treasuryBalance, walletBalance } from './stellar.ts'

const port = Number(process.env.PORT || '4010')
const host = process.env.CASINO_HOST || '127.0.0.1'

function send(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(payload))
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > 8192) throw new Error('Request exceeds the size limit.')
    chunks.push(chunk)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString())
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request.')
  return value as Record<string, unknown>
}

function adminAllowed(header: string | undefined) {
  const token = process.env.CASINO_ADMIN_TOKEN
  if (!token || !header) return false
  const expected = Buffer.from('Bearer ' + token)
  const provided = Buffer.from(header)
  return expected.length === provided.length && timingSafeEqual(expected, provided)
}

async function report() {
  const database = db()
  const totals = database
    .prepare(
      `
    SELECT CAST(COALESCE(SUM(demo), 0) AS TEXT) AS demo,
           CAST(COALESCE(SUM(testnet), 0) AS TEXT) AS testnet FROM player
  `
    )
    .get()
  const activity = database
    .prepare(
      `
    SELECT kind, COUNT(*) AS count, CAST(SUM(amount) AS TEXT) AS amount
    FROM entry GROUP BY kind ORDER BY kind
  `
    )
    .all()
  const pending = database
    .prepare(
      `
    SELECT hash, amount FROM withdrawal WHERE pending = 1
  `
    )
    .all()
  const pendingDeposits = database
    .prepare(
      `
    SELECT deposit.hash, deposit.amount FROM deposit JOIN signed_deposit USING (hash)
    WHERE deposit.credited = 0 ORDER BY deposit.rowid ASC LIMIT 100
  `
    )
    .all()
  const reserved = pending.reduce((sum, transfer) => sum + BigInt(String(transfer.amount)), 0n)
  const liabilities = BigInt(String(totals?.testnet ?? '0')) + reserved
  let treasury = null
  let treasuryIssue = ''
  try {
    treasury = await treasuryBalance()
  } catch {
    treasuryIssue = 'Horizon balance unavailable.'
  }
  const reconciliation = {
    reserved: reserved.toString(),
    liabilities: liabilities.toString(),
    grossDifference: treasury === null ? null : (BigInt(treasury) - liabilities).toString(),
  }
  return { treasury, treasuryIssue, totals, activity, pending, pendingDeposits, reconciliation }
}

function sessionCookie(response: ServerResponse, token: string) {
  const secure = process.env.CASINO_SECURE_COOKIE === '1' ? '; Secure' : ''
  response.setHeader('Set-Cookie', `rp_casino=${token}; HttpOnly; SameSite=Strict; Path=/api/casino; Max-Age=2592000${secure}`)
}

function issueSession(response: ServerResponse, id: string) {
  const token = randomBytes(32).toString('hex')
  db()
    .prepare('INSERT INTO session VALUES (?, ?, ?)')
    .run(token, id, Date.now() + 2592000_000)
  sessionCookie(response, token)
}

function state(id: string) {
  return { ...snapshot(id), passkey: hasPasskey(id) }
}

const walletCommands = new Set(['deposit-prepare', 'deposit-submit', 'deposit-retry', 'withdraw', 'withdraw-retry'])

createServer(async (request, response) => {
  const url = request.url
  try {
    if (url === '/health' && request.method === 'GET') return send(response, 200, { status: 'ok', network: 'stellar-testnet' })
    if (url === '/admin' && request.method === 'GET') {
      if (!adminAllowed(request.headers.authorization)) return send(response, 401, { error: 'Enter a valid operator token.' })
      return send(response, 200, await report())
    }
    if (url !== '/game' || !['GET', 'POST'].includes(request.method || '')) {
      return send(response, 404, { error: 'Unknown route.' })
    }

    const cookie = request.headers.cookie?.match(/(?:^|;\s*)rp_casino=([a-f0-9]{64})(?:;|$)/)?.[1]
    const session = cookie ? db().prepare('SELECT player FROM session WHERE token = ? AND expiry > ?').get(cookie, Date.now()) : undefined
    let id = typeof session?.player === 'string' && player(session.player) ? session.player : ''
    if (!id) {
      if (request.method === 'POST') return send(response, 409, { error: 'Load the casino session before continuing.' })
      id = randomBytes(32).toString('hex')
      createPlayer(id)
      issueSession(response, id)
    }
    if (request.method === 'GET') {
      refreshSports(id)
      return send(response, 200, { state: state(id) })
    }
    if (!request.headers['content-type']?.startsWith('application/json')) return send(response, 415, { error: 'Use a JSON request.' })
    const input = await body(request)
    if (typeof input.action === 'string' && input.action.startsWith('passkey-')) {
      const { login, ...result } = await passkey(id, input)
      if (login) {
        db()
          .prepare('DELETE FROM session WHERE token = ?')
          .run(cookie || '')
        issueSession(response, login)
      }
      return send(response, 200, { state: state(login || id), ...result })
    }
    if (input.action === 'wallet-balance') {
      return send(response, 200, { state: state(id), ...(await walletBalance(input.wallet)) })
    }
    const result =
      input.action === 'sports-market' || input.action === 'sports-place'
        ? sportsbook(id, input)
        : walletCommands.has(String(input.action))
          ? await payment(id, input)
          : play(id, input)
    return send(response, 200, { state: state(id), ...result })
  } catch (error) {
    const detail = (error as Error).message
    const internal = !(error instanceof Error) || 'code' in error || 'response' in error
    if (internal) console.error('Casino request failed', (error as { code?: string }).code ?? 'upstream error')
    send(response, internal ? 502 : 400, { error: internal ? 'Service unavailable. Check your activity before retrying.' : detail })
  }
}).listen(port, host, () => console.log(`RemitPulse casino backend on http://${host}:${port}`))
