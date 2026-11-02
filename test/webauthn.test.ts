import { randomBytes, randomUUID } from 'node:crypto'

import type { Passkey } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { prisma } from '../src/config/database'
import type { WebAuthnService as WebAuthnServiceType } from '../src/interfaces/webauthn'

const mocks = vi.hoisted(() => ({
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
  convertCOSEtoPKCS: vi.fn(),
}))

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: mocks.generateRegistrationOptions,
  verifyRegistrationResponse: mocks.verifyRegistrationResponse,
  generateAuthenticationOptions: mocks.generateAuthenticationOptions,
  verifyAuthenticationResponse: mocks.verifyAuthenticationResponse,
}))

vi.mock('@simplewebauthn/server/helpers', () => ({
  convertCOSEtoPKCS: mocks.convertCOSEtoPKCS,
  isoBase64URL: {
    fromBuffer: (buf: Uint8Array) => Buffer.from(buf).toString('base64url'),
    toBuffer: (str: string) => new Uint8Array(Buffer.from(str, 'base64url')),
  },
}))

let service: WebAuthnServiceType

const userId = randomUUID()
let passkeyRow: Passkey

function validPkcsPoint(): Buffer {
  return Buffer.concat([Buffer.from([0x04]), randomBytes(64)])
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.convertCOSEtoPKCS.mockReturnValue(validPkcsPoint())
})

beforeAll(async () => {
  const { WebAuthnService } = await import('../src/interfaces/webauthn')
  service = WebAuthnService.getInstance()

  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } })
  passkeyRow = await prisma.passkey.create({
    data: {
      userId,
      credentialId: `cred-${randomUUID()}`,
      credentialPublicKey: Buffer.from(validPkcsPoint()),
      hexPublicKey: validPkcsPoint().toString('hex'),
      counter: 0,
      transports: 'internal',
      deviceType: 'singleDevice',
      backedUp: false,
    },
  })
})

afterAll(async () => {
  await prisma.webAuthnChallenge.deleteMany({ where: { subject: { contains: '@example.com' } } })
  await prisma.passkey.deleteMany({ where: { userId } })
  await prisma.user.delete({ where: { id: userId } })
})

describe('registrationOptions', () => {
  it('stores a single-use challenge and returns the generated options', async () => {
    const email = `reg-${randomUUID()}@example.com`
    mocks.generateRegistrationOptions.mockResolvedValueOnce({ challenge: 'reg-challenge-token' })

    const options = await service.registrationOptions(email)

    expect(options).toEqual({ challenge: 'reg-challenge-token' })
    const stored = await prisma.webAuthnChallenge.findFirst({ where: { subject: email, purpose: 'registration' } })
    expect(stored?.challenge).toBe('reg-challenge-token')
  })
})

describe('verifyRegistration', () => {
  it('consumes the challenge so a second verification without new options fails', async () => {
    const email = `reg-${randomUUID()}@example.com`
    mocks.generateRegistrationOptions.mockResolvedValueOnce({ challenge: 'c1' })
    await service.registrationOptions(email)

    mocks.verifyRegistrationResponse.mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        credential: { id: 'cred-new', publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    })

    const result = await service.verifyRegistration(email, {} as never)
    expect(result.credentialId).toBe('cred-new')

    await expect(service.verifyRegistration(email, {} as never)).rejects.toMatchObject({ code: 'CHALLENGE_EXPIRED' })
  })

  it('rejects a non-P-256 (ES256) public key with WEBAUTHN_UNSUPPORTED_KEY', async () => {
    const email = `reg-${randomUUID()}@example.com`
    mocks.generateRegistrationOptions.mockResolvedValueOnce({ challenge: 'c2' })
    await service.registrationOptions(email)

    mocks.convertCOSEtoPKCS.mockReturnValueOnce(Buffer.alloc(32)) // wrong length, not a 65-byte 0x04 point
    mocks.verifyRegistrationResponse.mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        credential: { id: 'cred-bad-key', publicKey: new Uint8Array([9]), counter: 0 },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    })

    await expect(service.verifyRegistration(email, {} as never)).rejects.toMatchObject({ code: 'WEBAUTHN_UNSUPPORTED_KEY' })
  })

  it('maps an underlying verification failure to WEBAUTHN_INVALID', async () => {
    const email = `reg-${randomUUID()}@example.com`
    mocks.generateRegistrationOptions.mockResolvedValueOnce({ challenge: 'c3' })
    await service.registrationOptions(email)

    mocks.verifyRegistrationResponse.mockRejectedValueOnce(new Error('attestation signature invalid'))

    await expect(service.verifyRegistration(email, {} as never)).rejects.toMatchObject({ code: 'WEBAUTHN_INVALID' })
  })

  it('maps a verified:false result to WEBAUTHN_INVALID', async () => {
    const email = `reg-${randomUUID()}@example.com`
    mocks.generateRegistrationOptions.mockResolvedValueOnce({ challenge: 'c4' })
    await service.registrationOptions(email)

    mocks.verifyRegistrationResponse.mockResolvedValueOnce({ verified: false })

    await expect(service.verifyRegistration(email, {} as never)).rejects.toMatchObject({ code: 'WEBAUTHN_INVALID' })
  })
})

describe('verifyLogin / verifyAssertion', () => {
  it('throws UnauthorizedError when the response id does not match the passkey credentialId', async () => {
    const email = `login-${randomUUID()}@example.com`
    mocks.generateAuthenticationOptions.mockResolvedValueOnce({ challenge: 'auth-c1', allowCredentials: [] })
    await service.authenticationOptions(email, [passkeyRow])

    const response = { id: 'some-other-credential-id', response: {} } as never
    await expect(service.verifyLogin(email, passkeyRow, response)).rejects.toMatchObject({ message: 'Unknown passkey' })
    expect(mocks.verifyAuthenticationResponse).not.toHaveBeenCalled()
  })

  it('updates the passkey counter and lastUsedAt on a successful verification', async () => {
    const email = `login-${randomUUID()}@example.com`
    mocks.generateAuthenticationOptions.mockResolvedValueOnce({ challenge: 'auth-c2', allowCredentials: [] })
    await service.authenticationOptions(email, [passkeyRow])

    mocks.verifyAuthenticationResponse.mockResolvedValueOnce({ verified: true, authenticationInfo: { newCounter: 7 } })
    const response = {
      id: passkeyRow.credentialId,
      response: { authenticatorData: 'AA', clientDataJSON: 'AA', signature: 'AA' },
    } as never

    const newCounter = await service.verifyLogin(email, passkeyRow, response)
    expect(newCounter).toBe(7)

    const updated = await prisma.passkey.findUniqueOrThrow({ where: { id: passkeyRow.id } })
    expect(Number(updated.counter)).toBe(7)
    expect(updated.lastUsedAt).not.toBeNull()
  })

  it('maps a verified:false result to UnauthorizedError', async () => {
    const email = `login-${randomUUID()}@example.com`
    mocks.generateAuthenticationOptions.mockResolvedValueOnce({ challenge: 'auth-c3', allowCredentials: [] })
    await service.authenticationOptions(email, [passkeyRow])

    mocks.verifyAuthenticationResponse.mockResolvedValueOnce({ verified: false })
    const response = {
      id: passkeyRow.credentialId,
      response: { authenticatorData: 'AA', clientDataJSON: 'AA', signature: 'AA' },
    } as never

    await expect(service.verifyLogin(email, passkeyRow, response)).rejects.toMatchObject({
      message: 'Passkey assertion could not be verified',
    })
  })
})

describe('challenge expiry', () => {
  it('rejects consuming a challenge whose expiresAt is already in the past', async () => {
    const email = `expired-${randomUUID()}@example.com`
    await prisma.webAuthnChallenge.create({
      data: { subject: email, purpose: 'authentication', challenge: 'stale-challenge', expiresAt: new Date(Date.now() - 60_000) },
    })

    const response = { id: passkeyRow.credentialId, response: {} } as never
    await expect(service.verifyLogin(email, passkeyRow, response)).rejects.toMatchObject({ code: 'CHALLENGE_EXPIRED' })
  })
})

describe('contractSigningOptions', () => {
  it('passes the raw Soroban auth payload through as the WebAuthn challenge', async () => {
    const authPayload = randomBytes(32)
    mocks.generateAuthenticationOptions.mockResolvedValueOnce({ challenge: 'ignored', allowCredentials: [] })

    await service.contractSigningOptions([passkeyRow], authPayload)

    const callArgs = mocks.generateAuthenticationOptions.mock.calls.at(-1)?.[0]
    expect(Buffer.from(callArgs.challenge as Uint8Array)).toEqual(authPayload)
  })
})

describe('verifyContractAssertion', () => {
  it('converts a verified assertion into the account contract auth pieces', async () => {
    const authPayload = randomBytes(32)
    const authenticatorData = randomBytes(37)
    const clientDataJson = Buffer.from(JSON.stringify({ type: 'webauthn.get' }))
    const signature64 = randomBytes(64)

    mocks.verifyAuthenticationResponse.mockResolvedValueOnce({ verified: true, authenticationInfo: { newCounter: 3 } })
    const response = {
      id: passkeyRow.credentialId,
      response: {
        authenticatorData: authenticatorData.toString('base64url'),
        clientDataJSON: clientDataJson.toString('base64url'),
        signature: signature64.toString('base64url'),
      },
    } as never

    const result = await service.verifyContractAssertion(passkeyRow, response, authPayload)

    expect(result.newCounter).toBe(3)
    expect(result.authenticatorData.equals(authenticatorData)).toBe(true)
    expect(result.clientDataJson.equals(clientDataJson)).toBe(true)
    expect(result.signature).toHaveLength(64)

    // The challenge verifyAuthenticationResponse was called with must be the auth payload itself,
    // base64url-encoded (not a DB-stored challenge) — this flow never touches webAuthnChallenge.
    const callArgs = mocks.verifyAuthenticationResponse.mock.calls.at(-1)?.[0]
    expect(callArgs.expectedChallenge).toBe(authPayload.toString('base64url'))
  })
})
