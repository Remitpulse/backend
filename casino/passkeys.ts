import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server'
import { atomic, db } from './store.ts'
import type { Command } from './game.ts'

type Credential = { id: string; player: string; key: string; counter: number }
type Challenge = { value: string; expiry: number }

function tables() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS passkey (
      id TEXT PRIMARY KEY, player TEXT NOT NULL UNIQUE, key TEXT NOT NULL, counter INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS challenge (
      player TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
      expiry INTEGER NOT NULL, PRIMARY KEY(player, kind)
    ) STRICT;
  `)
}

export function hasPasskey(id: string): boolean {
  tables()
  return Boolean(db().prepare('SELECT id FROM passkey WHERE player = ?').get(id))
}

function storeChallenge(id: string, kind: string, value: string) {
  db()
    .prepare('INSERT OR REPLACE INTO challenge VALUES (?, ?, ?, ?)')
    .run(id, kind, value, Date.now() + 180_000)
}

function consumeChallenge(id: string, kind: string) {
  const challenge = db().prepare('DELETE FROM challenge WHERE player = ? AND kind = ? RETURNING value, expiry').get(id, kind) as
    Challenge | undefined
  if (!challenge || challenge.expiry < Date.now()) throw new Error('Start a new passkey request.')
  return challenge.value
}

export async function passkey(id: string, input: Command) {
  const origin = new URL(process.env.CASINO_PUBLIC_ORIGIN || 'http://localhost:3000')
  const rpID = origin.hostname
  tables()
  switch (input.action) {
    case 'passkey-register-options': {
      if (hasPasskey(id)) throw new Error('This session already has a passkey.')
      const options = await generateRegistrationOptions({
        rpID,
        rpName: 'RemitPulse',
        userID: Buffer.from(id, 'hex'),
        userName: 'Arcade player ' + id.slice(0, 4),
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      })
      storeChallenge(id, 'register', options.challenge)
      return { options }
    }
    case 'passkey-register-finish': {
      const expectedChallenge = consumeChallenge(id, 'register')
      const result = await verifyRegistrationResponse({
        response: input.credential as RegistrationResponseJSON,
        expectedChallenge,
        expectedOrigin: origin.origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      })
      if (!result.verified || !result.registrationInfo) throw new Error('Passkey verification failed.')
      const credential = result.registrationInfo.credential
      db()
        .prepare('INSERT INTO passkey VALUES (?, ?, ?, ?)')
        .run(credential.id, id, Buffer.from(credential.publicKey).toString('base64'), credential.counter)
      return { message: 'Passkey saved for this account.' }
    }
    case 'passkey-login-options': {
      const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' })
      storeChallenge(id, 'login', options.challenge)
      return { options }
    }
    case 'passkey-login-finish': {
      const expectedChallenge = consumeChallenge(id, 'login')
      const response = input.credential as AuthenticationResponseJSON
      const credential = db()
        .prepare('SELECT * FROM passkey WHERE id = ?')
        .get(response?.id || '') as Credential | undefined
      if (!credential) throw new Error('Passkey was not found.')
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origin.origin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: { id: credential.id, publicKey: Buffer.from(credential.key, 'base64'), counter: credential.counter },
      })
      if (!result.verified) throw new Error('Passkey verification failed.')
      atomic(() => {
        const update = db()
          .prepare('UPDATE passkey SET counter = ? WHERE id = ? AND counter = ?')
          .run(result.authenticationInfo.newCounter, credential.id, credential.counter)
        if (!update.changes) throw new Error('Start a new passkey request.')
      })
      return { login: credential.player, message: 'Signed in with a passkey.' }
    }
    default:
      throw new Error('Choose a passkey action.')
  }
}
