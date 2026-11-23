import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { createPlayer, db, player, snapshot } from './store.ts'
import { reconcileTestnetTransfer } from './stellar.ts'

process.env.CASINO_DATA_DIR = mkdtempSync(join(tmpdir(), 'casino-transfers-'))

test('operator recovery credits a confirmed deposit once even during concurrent retries', async () => {
  const id = 'operator-recovery'
  const hash = 'a'.repeat(64)
  createPlayer(id)
  db().prepare('INSERT INTO deposit (hash, player, wallet, amount, xdr) VALUES (?, ?, ?, ?, ?)')
    .run(hash, id, 'wallet', '10000001', 'envelope')
  const confirmed = async () => ({ status: 'confirmed', ledger: 42 })
  await assert.rejects(reconcileTestnetTransfer(hash, confirmed), /No signed or reserved transfer/)
  db().prepare('INSERT INTO signed_deposit VALUES (?, ?)').run(hash, 'signed')
  await assert.rejects(reconcileTestnetTransfer(hash, async () => ({ status: 'not-found', ledger: null })),
    /requires a successful Testnet receipt/)
  assert.equal(player(id)?.testnet, 0n)

  await Promise.all([reconcileTestnetTransfer(hash, confirmed), reconcileTestnetTransfer(hash, confirmed)])
  assert.equal(player(id)?.testnet, 10000001n)
  assert.equal(snapshot(id).entries.filter(entry => entry.kind === 'Testnet deposit').length, 1)
})
