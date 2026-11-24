import { createHash, createHmac, randomBytes } from 'node:crypto'

const seedPattern = /^[a-f0-9]{64}$/
const range = 0x1_0000_0000
const accepted = range - (range % 10_000)

export function diceCommitment(serverSeed: string) {
  if (!seedPattern.test(serverSeed)) throw new Error('Invalid Dice server seed.')
  return createHash('sha256').update(Buffer.from(serverSeed, 'hex')).digest('hex')
}

export function createDiceCommitment() {
  const serverSeed = randomBytes(32).toString('hex')
  return { serverSeed, commitment: diceCommitment(serverSeed) }
}

export function committedDiceRoll(serverSeed: string, clientSeed: string): number {
  if (!seedPattern.test(serverSeed) || !seedPattern.test(clientSeed)) {
    throw new Error('Dice seeds must be 32 bytes encoded as lowercase hexadecimal.')
  }
  const key = Buffer.from(serverSeed, 'hex')
  for (let counter = 0; ; counter++) {
    const digest = createHmac('sha256', key)
      .update(`remitpulse:dice:v1:${clientSeed}:${counter}`)
      .digest()
    const draw = digest.readUInt32BE(0)
    if (draw < accepted) return draw % 10_000
  }
}


export type DiceProof = {
  version: 1
  commitment: string
  serverSeed: string
  clientSeed: string
  roll: number
  target: number
  stake: string
  payout: string
}
