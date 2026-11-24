import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { copyLedger } from './backup.ts'

test('backs up committed WAL data and restores it without overwriting a destination', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rp-backup-'))
  const source = join(directory, 'source.sqlite')
  const snapshot = join(directory, 'snapshot.sqlite')
  const restored = join(directory, 'restored.sqlite')
  const live = new DatabaseSync(source)
  try {
    live.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE player (testnet INTEGER);
      CREATE TABLE entry (id TEXT);
      CREATE TABLE deposit (hash TEXT);
      CREATE TABLE withdrawal (hash TEXT);
      INSERT INTO player VALUES (10000001);
    `)
    await copyLedger(source, snapshot)
    live.exec('UPDATE player SET testnet = 0')
    await copyLedger(snapshot, restored)
    await assert.rejects(copyLedger(source, restored), { code: 'EEXIST' })
    const recovered = new DatabaseSync(restored, { readOnly: true })
    try {
      assert.equal(recovered.prepare('SELECT testnet FROM player').get()?.testnet, 10000001)
    } finally {
      recovered.close()
    }
  } finally {
    live.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
