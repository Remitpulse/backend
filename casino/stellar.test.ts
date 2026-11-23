import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { Account, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk'

import { createPlayer, db, player, snapshot } from './store.ts'
import { payment, reconcileTestnetTransfer, transferExpiry } from './stellar.ts'

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

test('operator closes a definitively failed deposit without crediting the ledger', async () => {
  const id = 'failed-deposit'
  const hash = 'd'.repeat(64)
  createPlayer(id)
  db().prepare('INSERT INTO deposit (hash, player, wallet, amount, xdr) VALUES (?, ?, ?, ?, ?)')
    .run(hash, id, 'wallet', '10000001', 'envelope')
  db().prepare('INSERT INTO signed_deposit VALUES (?, ?)').run(hash, 'signed')
  const failed = async () => ({ status: 'failed', ledger: 42 })
  await Promise.all([reconcileTestnetTransfer(hash, failed), reconcileTestnetTransfer(hash, failed)])
  const state = snapshot(id)
  assert.equal(state.testnet, '0')
  assert.equal(state.deposit, null)
  assert.equal(state.transfers[0]?.status, 'failed')
})


test('a stale withdrawal or foreign signed deposit cannot be retried', async () => {
  const previousSecret = process.env.CASINO_TESTNET_TREASURY_SECRET
  process.env.CASINO_TESTNET_TREASURY_SECRET = Keypair.random().secret()
  try {
    const id = 'retry-player'
    const other = 'retry-other-player'
    createPlayer(id)
    createPlayer(other)
    const current = 'e'.repeat(64)
    const foreign = 'f'.repeat(64)
    db().prepare('INSERT INTO withdrawal (hash, player, amount, xdr) VALUES (?, ?, ?, ?)')
      .run(current, id, '10000001', 'signed')
    db().prepare('INSERT INTO deposit (hash, player, wallet, amount, xdr) VALUES (?, ?, ?, ?, ?)')
      .run(foreign, other, 'wallet', '10000001', 'envelope')
    db().prepare('INSERT INTO signed_deposit VALUES (?, ?)').run(foreign, 'signed')

    await assert.rejects(payment(id, { action: 'withdraw-retry', hash: foreign }), /no longer pending/)
    await assert.rejects(payment(id, { action: 'deposit-retry', hash: foreign }), /Signed deposit was not found/)
    assert.equal(snapshot(id).withdrawal?.hash, current)
    assert.equal(snapshot(other).deposit?.hash, foreign)
    assert.equal(snapshot(id).testnet, '0')
  } finally {
    if (previousSecret === undefined) delete process.env.CASINO_TESTNET_TREASURY_SECRET
    else process.env.CASINO_TESTNET_TREASURY_SECRET = previousSecret
  }
})


test('reads a signed Testnet envelope deadline as milliseconds', () => {
  const key = Keypair.random()
  const tx = new TransactionBuilder(new Account(key.publicKey(), '0'), {
    fee: '100', networkPassphrase: Networks.TESTNET,
  })
    .setTimebounds(0, 1_800_000_000)
    .addOperation(Operation.bumpSequence({ bumpTo: '5' }))
    .build()
  tx.sign(key)
  assert.equal(transferExpiry(tx.toXdr()), 1_800_000_000_000)
  assert.equal(transferExpiry('not an envelope'), null)
})
