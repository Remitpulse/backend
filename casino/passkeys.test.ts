import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { createPlayer } from './store.ts'
import { hasPasskey, passkey } from './passkeys.ts'

process.env.CASINO_DATA_DIR = mkdtempSync(join(tmpdir(), 'casino-passkey-'))
process.env.CASINO_PUBLIC_ORIGIN = 'http://localhost:3000'

const clientData = (type: string, challenge: string) =>
  Buffer.from(JSON.stringify({ type, challenge, origin: process.env.CASINO_PUBLIC_ORIGIN }))

function authenticatorData(flags: number, counter: number) {
  const metadata = Buffer.alloc(5)
  metadata[0] = flags
  metadata.writeUInt32BE(counter, 1)
  return Buffer.concat([createHash('sha256').update('localhost').digest(), metadata])
}

test('verifies registration and restores the same account from a new session', async () => {
  const registered = randomBytes(32).toString('hex')
  const guest = randomBytes(32).toString('hex')
  createPlayer(registered)
  createPlayer(guest)
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' })
  const coseKey = isoCBOR.encode(
    new Map<number, Parameters<typeof isoCBOR.encode>[0]>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ])
  )
  const rawId = randomBytes(32)
  const id = rawId.toString('base64url')
  const size = Buffer.alloc(2)
  size.writeUInt16BE(rawId.length)
  const authData = Buffer.concat([authenticatorData(0x45, 0), Buffer.alloc(16), size, rawId, coseKey])
  const attestation = Buffer.from(
    isoCBOR.encode(
      new Map<string, Parameters<typeof isoCBOR.encode>[0]>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ])
    )
  )

  const registration = await passkey(registered, { action: 'passkey-register-options' })
  await passkey(registered, {
    action: 'passkey-register-finish',
    credential: {
      id,
      rawId: id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientData('webauthn.create', registration.options!.challenge).toString('base64url'),
        attestationObject: attestation.toString('base64url'),
      },
    },
  })
  assert.equal(hasPasskey(registered), true)
  const authentication = await passkey(guest, { action: 'passkey-login-options' })
  const client = clientData('webauthn.get', authentication.options!.challenge)
  const assertion = authenticatorData(0x05, 1)
  const signature = sign('sha256', Buffer.concat([assertion, createHash('sha256').update(client).digest()]), privateKey)
  const command = {
    action: 'passkey-login-finish',
    credential: {
      id,
      rawId: id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: client.toString('base64url'),
        authenticatorData: assertion.toString('base64url'),
        signature: signature.toString('base64url'),
        userHandle: Buffer.from(registered, 'hex').toString('base64url'),
      },
    },
  }
  assert.equal((await passkey(guest, command)).login, registered)
  await assert.rejects(() => passkey(guest, command), /Start a new passkey request/)
})
