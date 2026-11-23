import { randomInt } from 'node:crypto'
import { atomic, db, minesPayout, player, record } from './store.ts'
import { parseXlm, STROOPS } from './money.ts'

export type Command = Record<string, unknown>

function integer(input: unknown, min: number, max: number): number {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < min || input > max) {
    throw new Error('Choose a valid game setting.')
  }
  return input
}

export function play(id: string, input: Command) {
  return atomic(() => {
    const state = player(id)!
    if (input.action === 'pause') {
      db().prepare('UPDATE player SET paused = 1 WHERE id = ?').run(id)
      return { message: 'Demo wagering paused for this session.' }
    }

    if (input.action === 'reveal' || input.action === 'cashout') {
      if (!state.stake || !state.mines || !state.picks) throw new Error('Start a Mines round first.')
      const picks: number[] = JSON.parse(state.picks)
      const mines: number[] = JSON.parse(state.mines)
      const stake = BigInt(state.stake)
      if (input.action === 'reveal') {
        if (state.paused) throw new Error('Demo wagering is paused. You can cash out the open round.')
        const tile = integer(input.tile, 0, 24)
        if (picks.includes(tile)) throw new Error('That tile is already revealed.')
        if (mines.includes(tile)) {
          db().prepare('UPDATE player SET mines = NULL, stake = NULL, picks = NULL WHERE id = ?').run(id)
          record(id, 'Result', 0n, 'Mine hit', 'Mines')
          return { message: 'Mine hit. Round ended.', mines, bust: true }
        }
        picks.push(tile)
        if (picks.length < 22) {
          db().prepare('UPDATE player SET picks = ? WHERE id = ?').run(JSON.stringify(picks), id)
          return { message: 'Gem found.' }
        }
      }
      if (picks.length === 0) throw new Error('Reveal a gem before cashing out.')
      const payout = minesPayout(stake, picks.length)
      db().prepare('UPDATE player SET mines = NULL, stake = NULL, picks = NULL, demo = demo + ? WHERE id = ?').run(payout, id)
      record(id, 'Payout', payout, `${picks.length} gems revealed`, 'Mines')
      return { message: 'Mines paid out.', payout: payout.toString(), mines }
    }

    if (input.action !== 'play') throw new Error('Choose a game action.')
    if (state.paused) throw new Error('Demo wagering is paused for this session.')
    const stake = parseXlm(input.amount)
    if (stake <= 0n || stake > 100n * STROOPS || stake > state.demo) {
      throw new Error('Enter a positive wager up to 100 XLM within your demo balance.')
    }

    let title: string
    let result: string
    let payout = 0n
    let path: number[] | undefined

    switch (input.game) {
      case 'dice': {
        title = 'Dice'
        const target = integer(input.setting, 2, 98)
        const roll = randomInt(10000)
        result = (roll / 100).toFixed(2)
        if (roll < target * 100) payout = (stake * 99n) / BigInt(target)
        break
      }
      case 'limbo': {
        title = 'Limbo'
        const target = integer(input.setting, 110, 10000)
        const generated = Math.max(100, Math.floor(9_900_000 / (randomInt(100000) + 1)))
        result = (generated / 100).toFixed(2) + '×'
        if (generated >= target) payout = (stake * BigInt(target)) / 100n
        break
      }
      case 'coin': {
        title = 'Coin Flip'
        if (input.setting !== 'Heads' && input.setting !== 'Tails') throw new Error('Call heads or tails.')
        result = randomInt(2) ? 'Heads' : 'Tails'
        if (input.setting === result) payout = (stake * 198n) / 100n
        break
      }
      case 'plinko': {
        title = 'Plinko'
        path = Array.from({ length: 8 }, () => randomInt(2))
        const slot = path.reduce((sum, step) => sum + step, 0)
        const multiplier = [600, 220, 120, 85, 55, 85, 120, 220, 600][slot]
        result = (multiplier / 100).toFixed(2) + '×'
        payout = (stake * BigInt(multiplier)) / 100n
        break
      }
      case 'mines': {
        if (state.stake) throw new Error('Finish the open Mines round first.')
        const mines = new Set<number>()
        while (mines.size < 3) mines.add(randomInt(25))
        db()
          .prepare('UPDATE player SET demo = demo - ?, mines = ?, stake = ?, picks = ? WHERE id = ?')
          .run(stake, JSON.stringify([...mines]), stake.toString(), '[]', id)
        record(id, 'Wager', -stake, '3 mines', 'Mines')
        return { message: 'Choose a tile.' }
      }
      default:
        throw new Error('Choose a game.')
    }

    db().prepare('UPDATE player SET demo = demo - ? + ? WHERE id = ?').run(stake, payout, id)
    record(id, 'Wager', -stake, 'Demo wager', title)
    record(id, payout > 0n ? 'Payout' : 'Result', payout, result, title)
    return { message: result, payout: payout.toString(), ...(path && { path }) }
  })
}
