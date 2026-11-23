import { randomInt } from 'node:crypto'
import type { Command } from './game.ts'

const red = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36])
const wheel = [0, 150, 0, 200, 0, 150, 0, 350, 0, 150, 0, 175]
const keno = [0, 0, 150, 650, 2000, 12500]

function baccarat() {
  const shoe = Array.from({ length: 416 }, (_, i) => i % 52)
  const card = () => {
    const index = randomInt(shoe.length)
    const value = shoe[index]
    shoe[index] = shoe[shoe.length - 1]
    shoe.pop()
    return value
  }
  const points = (value: number) => (value % 13 < 9 ? (value % 13) + 1 : 0)
  const total = (hand: number[]) => hand.reduce((sum, value) => sum + points(value), 0) % 10
  const player = [card()]
  const banker = [card()]
  player.push(card())
  banker.push(card())
  const p = total(player)
  const b = total(banker)
  if (p < 8 && b < 8) {
    if (p <= 5) {
      const third = card()
      player.push(third)
      const v = points(third)
      if (
        b <= 2 ||
        (b === 3 && v !== 8) ||
        (b === 4 && v >= 2 && v <= 7) ||
        (b === 5 && v >= 4 && v <= 7) ||
        (b === 6 && (v === 6 || v === 7))
      )
        banker.push(card())
    } else if (b <= 5) banker.push(card())
  }
  const playerTotal = total(player)
  const bankerTotal = total(banker)
  const winner = playerTotal === bankerTotal ? 'Tie' : playerTotal > bankerTotal ? 'Player' : 'Banker'
  return { player, banker, playerTotal, bankerTotal, winner }
}

export function tableGame(input: Command, stake: bigint) {
  switch (input.game) {
    case 'roulette': {
      const bet = input.setting
      if (bet !== 'Red' && bet !== 'Black' && bet !== 'Zero') throw new Error('Choose red, black or zero.')
      const pocket = randomInt(37)
      const color = pocket === 0 ? 'Zero' : red.has(pocket) ? 'Red' : 'Black'
      const payout = bet === color ? stake * (bet === 'Zero' ? 36n : 2n) : 0n
      return { title: 'European Roulette', result: pocket + ' · ' + color, payout, board: [pocket] }
    }
    case 'keno': {
      const picks = input.setting
      if (
        !Array.isArray(picks) ||
        picks.length !== 5 ||
        new Set(picks).size !== 5 ||
        picks.some(pick => !Number.isInteger(pick) || pick < 1 || pick > 40)
      ) {
        throw new Error('Choose five distinct numbers from 1 to 40.')
      }
      const draw = new Set<number>()
      while (draw.size < 10) draw.add(randomInt(1, 41))
      const matches = picks.filter(pick => draw.has(pick)).length
      return { title: 'Keno', result: matches + ' of 5 matched', payout: (stake * BigInt(keno[matches])) / 100n, board: [...draw] }
    }
    case 'wheel': {
      const segment = randomInt(wheel.length)
      const multiplier = wheel[segment]
      return { title: 'Wheel', result: (multiplier / 100).toFixed(2) + '×', payout: (stake * BigInt(multiplier)) / 100n, board: [segment] }
    }
    case 'baccarat': {
      const bet = input.setting
      if (bet !== 'Player' && bet !== 'Banker' && bet !== 'Tie') throw new Error('Choose player, banker or tie.')
      const hand = baccarat()
      const multiplier = hand.winner === bet ? { Player: 200n, Banker: 195n, Tie: 900n }[bet] : hand.winner === 'Tie' ? 100n : 0n
      return { title: 'Baccarat', result: hand.winner === 'Tie' ? 'Tie' : hand.winner + ' wins', payout: (stake * multiplier) / 100n, hand }
    }
    default:
      throw new Error('Choose a game.')
  }
}
