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
    /requires a confirmed Testnet receipt/)
  assert.equal(player(id)?.testnet, 0n)

  await Promise.all([reconcileTestnetTransfer(hash, confirmed), reconcileTestnetTransfer(hash, confirmed)])
  assert.equal(player(id)?.testnet, 10000001n)
  assert.equal(snapshot(id).entries.filter(entry => entry.kind === 'Testnet deposit').length, 1)
})

test('confirming a reserved withdrawal clears it without another debit', async () => {
  const id = 'withdrawal-recovery'
  const hash = 'b'.repeat(64)
  createPlayer(id)
  db().prepare('UPDATE player SET testnet = ? WHERE id = ?').run(7000001n, id)
  db().prepare('INSERT INTO withdrawal (hash, player, amount, xdr) VALUES (?, ?, ?, ?)')
    .run(hash, id, '2000001', 'signed')
  await assert.rejects(reconcileTestnetTransfer(hash, async () => ({ status: 'not-found', ledger: null })),
    /requires a confirmed Testnet receipt/)
  assert.equal(snapshot(id).withdrawal?.hash, hash)
  assert.equal(snapshot(id).transfers[0]?.status, 'pending')

  const confirmed = async () => ({ status: 'confirmed', ledger: 42 })
  await Promise.all([reconcileTestnetTransfer(hash, confirmed), reconcileTestnetTransfer(hash, confirmed)])
  assert.equal(snapshot(id).withdrawal, null)
  assert.equal(player(id)?.testnet, 7000001n)
  assert.equal(snapshot(id).transfers[0]?.status, 'confirmed')
  assert.equal(snapshot(id).entries.filter(entry => entry.kind === 'Testnet withdrawal confirmed').length, 1)
})


test('releases a definitively failed withdrawal reserve exactly once', async () => {
  const id = 'failed-withdrawal'
  const hash = 'c'.repeat(64)
  createPlayer(id)
  db().prepare('INSERT INTO withdrawal (hash, player, amount, xdr) VALUES (?, ?, ?, ?)')
    .run(hash, id, '2000001', 'signed')
  const failed = async () => ({ status: 'failed', ledger: 42 })
  await Promise.all([reconcileTestnetTransfer(hash, failed), reconcileTestnetTransfer(hash, failed)])
  assert.equal(snapshot(id).withdrawal, null)
  assert.equal(player(id)?.testnet, 2000001n)
  assert.equal(snapshot(id).transfers[0]?.status, 'failed')
  assert.equal(snapshot(id).entries.filter(entry => entry.kind === 'Failed Testnet withdrawal released').length, 1)
})
