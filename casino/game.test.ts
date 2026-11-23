import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { parseXlm, xlm } from './money.ts'
import { createPlayer, player, snapshot } from './store.ts'
import { play } from './game.ts'

process.env.CASINO_DATA_DIR = mkdtempSync(join(tmpdir(), 'casino-ledger-'))

test('native amounts round trip as stroops without loss', () => {
  assert.equal(parseXlm('123456789012.0000007'), 1234567890120000007n)
  assert.equal(xlm(1n), '0.0000001')
  for (const value of [0.1, '-0.1', '0.00000001', '1e2']) assert.throws(() => parseXlm(value))
})

test('server settles all instant games to the exact demo balance', () => {
  createPlayer('instant')
  for (const [game, setting] of [
    ['dice', 50],
    ['limbo', 200],
    ['coin', 'Heads'],
    ['plinko', undefined],
  ]) {
    const previous = player('instant')!.demo
    const result = play('instant', { action: 'play', game, setting, amount: '0.0000109' })
    assert.equal(player('instant')!.demo, previous - 109n + BigInt(result.payout!))
    assert.equal(player('instant')!.testnet, 0n)
  }
  const state = snapshot('instant')
  assert.equal(state.entries.filter(entry => entry.kind === 'Wager').length, 4)
  assert.throws(() => play('instant', { action: 'play', game: 'dice', setting: 100, amount: '1' }))
})

test('Mines keeps the board private, pays once and honors pausing', () => {
  createPlayer('mines')
  play('mines', { action: 'play', game: 'mines', amount: '1' })
  const stored = player('mines')!
  const mines: number[] = JSON.parse(stored.mines!)
  assert.deepEqual(snapshot('mines').round?.picks, [])
  assert.equal(JSON.stringify(snapshot('mines')).includes('"mines":'), false)
  const tile = Array.from({ length: 25 }, (_, i) => i).find(i => !mines.includes(i))!
  play('mines', { action: 'reveal', tile })
  assert.throws(() => play('mines', { action: 'reveal', tile }))
  play('mines', { action: 'pause' })
  const result = play('mines', { action: 'cashout' })
  assert.equal(player('mines')!.demo, 9990000000n + BigInt(result.payout!))
  assert.throws(() => play('mines', { action: 'cashout' }))
  assert.throws(() => play('mines', { action: 'play', game: 'coin', setting: 'Heads', amount: '1' }))
})
