import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CasinoState, Entry } from './catalog.ts'
import { STROOPS } from './money.ts'

let connection: DatabaseSync | undefined

export function db() {
  if (connection) return connection
  const directory = resolve(process.env.CASINO_DATA_DIR || '.casino-data')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(resolve(directory, 'ledger.sqlite'))
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS player (
      id TEXT PRIMARY KEY, demo INTEGER NOT NULL CHECK(demo >= 0),
      testnet INTEGER NOT NULL DEFAULT 0 CHECK(testnet >= 0),
      paused INTEGER NOT NULL DEFAULT 0, wallet TEXT,
      mines TEXT, stake TEXT, picks TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS session (
      token TEXT PRIMARY KEY, player TEXT NOT NULL, expiry INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS entry (
      id TEXT PRIMARY KEY, player TEXT NOT NULL, kind TEXT NOT NULL,
      game TEXT, amount INTEGER NOT NULL, detail TEXT NOT NULL, created TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS entry_player ON entry(player);
    CREATE TABLE IF NOT EXISTS deposit (
      hash TEXT PRIMARY KEY, player TEXT NOT NULL, wallet TEXT NOT NULL,
      amount TEXT NOT NULL, xdr TEXT NOT NULL, credited INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE IF NOT EXISTS dice_commitment (
      player TEXT PRIMARY KEY, commitment TEXT NOT NULL, seed TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS dice_proof (
      entry TEXT PRIMARY KEY, proof TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS signed_deposit (
      hash TEXT PRIMARY KEY, xdr TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS withdrawal (
      hash TEXT PRIMARY KEY, player TEXT NOT NULL, amount TEXT NOT NULL,
      xdr TEXT NOT NULL, pending INTEGER NOT NULL DEFAULT 1
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sports_ticket (
      id TEXT PRIMARY KEY, player TEXT NOT NULL, event TEXT NOT NULL, label TEXT NOT NULL,
      selection INTEGER NOT NULL, selection_label TEXT NOT NULL, price INTEGER NOT NULL, stake INTEGER NOT NULL,
      settles INTEGER NOT NULL, payout INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'Open', score TEXT,
      UNIQUE(player, event)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sports_result (
      event TEXT PRIMARY KEY, winner INTEGER NOT NULL, score TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS treasury_pending ON withdrawal(pending) WHERE pending = 1;
  `)
  connection = database
  return database
}

export function atomic<T>(action: () => T): T {
  const database = db()
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = action()
    database.exec('COMMIT')
    return result
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export function record(player: string, kind: string, amount: bigint, detail: string, game: string | null = null) {
  const entry = randomUUID()
  db()
    .prepare('INSERT INTO entry VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(entry, player, kind, game, amount, detail, new Date().toISOString())
  return entry
}

export function createPlayer(id: string) {
  atomic(() => {
    const bonus = 1000n * STROOPS
    db().prepare('INSERT INTO player (id, demo) VALUES (?, ?)').run(id, bonus)
    record(id, 'Demo grant', bonus, 'Starting demo balance')
  })
}

export type Player = {
  demo: bigint
  testnet: bigint
  paused: bigint
  wallet: string | null
  mines: string | null
  stake: string | null
  picks: string | null
}
export function player(id: string): Player | undefined {
  const statement = db().prepare('SELECT * FROM player WHERE id = ?')
  statement.setReadBigInts(true)
  return statement.get(id) as Player | undefined
}

export function minesPayout(stake: bigint, count: number, mines = 3) {
  let numerator = stake * 99n
  let denominator = 100n
  for (let i = 0; i < count; i++) {
    numerator *= BigInt(25 - i)
    denominator *= BigInt(25 - mines - i)
  }
  return numerator / denominator
}

export function snapshot(id: string): CasinoState {
  const state = player(id)!
  const entries = db()
    .prepare(
      `SELECT entry.id, kind, game, CAST(amount AS TEXT) AS amount, detail, created, dice_proof.proof
       FROM entry LEFT JOIN dice_proof ON dice_proof.entry = entry.id
       WHERE entry.player = ? ORDER BY entry.rowid DESC LIMIT 40`
    )
    .all(id) as (Omit<Entry, 'proof'> & { proof: string | null })[]
  const mineCount = state.mines ? (JSON.parse(state.mines) as number[]).length : 3
  const picks: number[] = state.picks ? JSON.parse(state.picks) : []
  const withdrawal = db().prepare('SELECT hash, amount FROM withdrawal WHERE player = ? AND pending = 1').get(id) as
    CasinoState['withdrawal'] | undefined
  const deposit = db()
    .prepare(
      `
    SELECT hash, amount FROM deposit JOIN signed_deposit USING (hash)
    WHERE player = ? AND credited = 0 ORDER BY deposit.rowid DESC LIMIT 1
  `
    )
    .get(id) as CasinoState['deposit'] | undefined
  return {
    demo: state.demo.toString(),
    testnet: state.testnet.toString(),
    entries: entries.map(({ proof, ...entry }) => proof ? { ...entry, proof: JSON.parse(proof) as Entry['proof'] } : entry),
    paused: state.paused === 1n,
    walletEnabled: Boolean(process.env.CASINO_TESTNET_TREASURY_SECRET),
    round: state.stake
      ? {
          stake: state.stake,
          picks,
          mineCount,
          payout: minesPayout(BigInt(state.stake), picks.length, mineCount).toString(),
          nextPayout: minesPayout(BigInt(state.stake), picks.length + 1, mineCount).toString(),
        }
      : null,
    deposit: deposit || null,
    withdrawal: withdrawal || null,
  }
}
