import { linkSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'

export async function copyLedger(source: string, destination: string) {
  const staging = mkdtempSync(join(dirname(destination), '.remitpulse-ledger-'))
  const copy = join(staging, 'ledger.sqlite')
  try {
    const original = new DatabaseSync(source, { readOnly: true })
    try {
      await backup(original, copy)
    } finally {
      original.close()
    }
    const check = new DatabaseSync(copy, { readOnly: true })
    try {
      const integrity = check.prepare('PRAGMA integrity_check').all()
      const tables = check.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name IN ('player', 'entry', 'deposit', 'withdrawal')",
      ).get()
      if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || tables?.count !== 4) {
        throw new Error('The copy failed SQLite integrity or casino ledger schema checks.')
      }
    } finally {
      check.close()
    }
    linkSync(copy, destination)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const [destination, source = resolve(process.env.CASINO_DATA_DIR || '.casino-data', 'ledger.sqlite')] = process.argv.slice(2)
  if (!destination) {
    console.error('Usage: npm run ledger:backup -- <new destination> [source ledger]')
    process.exitCode = 1
  } else {
    // Ledger snapshots contain sensitive account data.
    process.umask(0o077)
    try {
      await copyLedger(source, resolve(destination))
      console.log('Verified ledger copy written.')
    } catch (error) {
      console.error((error as Error).message)
      process.exitCode = 1
    }
  }
}
