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

test('table and draw games emit valid outcomes and settle only the demo balance', () => {
  createPlayer('table-draw')
  const id = 'table-draw'
  const commands = [
    { game: 'roulette', setting: 'Red' },
    { game: 'keno', setting: [1, 2, 3, 4, 5] },
    { game: 'wheel' },
    { game: 'baccarat', setting: 'Player' },
  ]
  for (const command of commands) {
    const before = player(id)!.demo
    const result = play(id, { action: 'play', amount: '0.1234567', ...command })
    assert.equal(player(id)!.demo, before - 1234567n + BigInt(result.payout!))
    assert.equal(player(id)!.testnet, 0n)
    assert.ok('board' in result)
    if (command.game === 'keno') {
      assert.equal(result.board?.length, 10)
      assert.equal(new Set(result.board).size, 10)
    }
    if (command.game === 'roulette') assert.ok(result.board?.[0] !== undefined && result.board[0] <= 36)
    if (command.game === 'wheel') assert.ok(result.board?.[0] !== undefined && result.board[0] < 12)
    if (command.game === 'baccarat') assert.ok(result.hand?.player && result.hand.banker)
  }
  const balance = player(id)!.demo
  assert.throws(() => play(id, { action: 'play', game: 'keno', amount: '1', setting: [1, 1, 2, 3, 4] }))
  assert.equal(player(id)!.demo, balance)
})

test('Dice commits before play, keeps its seed private and consumes the commitment once', () => {
  createPlayer('committed-dice')
  const commit = play('committed-dice', { action: 'dice-commit' })
  assert.deepEqual(Object.keys(commit), ['commitment'])
  assert.deepEqual(play('committed-dice', { action: 'dice-commit' }), commit)
  const wager = {
    action: 'play', game: 'dice', setting: 50, amount: '1.0000001',
    commitment: commit.commitment, clientSeed: '42'.repeat(32),
  }
  assert.throws(() => play('committed-dice', { ...wager, clientSeed: 'invalid' }))
  const result = play('committed-dice', wager)
  assert.ok('proof' in result && result.proof)
  assert.equal(result.proof.commitment, commit.commitment)
  assert.equal(result.proof.stake, '10000001')
  assert.deepEqual(snapshot('committed-dice').entries[0].proof, result.proof)
  assert.equal(result.proof.payout, result.payout)
  assert.equal(result.proof.roll < 5000, BigInt(result.payout!) > 0n)
  assert.throws(() => play('committed-dice', wager), /Request a Dice commitment/)
})
