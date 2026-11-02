import type {
  AuthenticationResponseJSON,
  AuthenticatorTransport,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { convertCOSEtoPKCS, isoBase64URL } from '@simplewebauthn/server/helpers'
import type { ChallengePurpose, Passkey } from '@prisma/client'

import { prisma } from '../../config/database'
import { env } from '../../config/env'
import { BadRequestError, UnauthorizedError } from '../../errors'
import { derToCompactP256 } from '../contracts/signatures'

const COSE_ALG_ES256 = -7

export type VerifiedRegistration = {
  credentialId: string
  credentialPublicKey: Uint8Array
  hexPublicKey: string
  counter: number
  transports?: string
  deviceType: string
  backedUp: boolean
}

export type ContractAssertion = {
  authenticatorData: Buffer
  clientDataJson: Buffer
  /** 64-byte compact, low-S normalised secp256r1 signature */
  signature: Buffer
  newCounter: number
}

/**
 * WebAuthn relying party for RemitPulse passkeys.
 *
 * Passkeys are restricted to ES256 (secp256r1) because that is the curve the
 * account contract verifies on-chain via `secp256r1_verify`.
 */
export class WebAuthnService {
  private static instance?: WebAuthnService

  static getInstance(): WebAuthnService {
    WebAuthnService.instance ??= new WebAuthnService()
    return WebAuthnService.instance
  }

  async registrationOptions(email: string, excludeCredentials: Passkey[] = []): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const options = await generateRegistrationOptions({
      rpName: env.WEBAUTHN_RP_NAME,
      rpID: env.WEBAUTHN_RP_ID,
      userName: email,
      userDisplayName: email,
      attestationType: 'none',
      supportedAlgorithmIDs: [COSE_ALG_ES256],
      excludeCredentials: excludeCredentials.map(passkey => ({
        id: passkey.credentialId,
        transports: passkey.transports?.split(',') as AuthenticatorTransport[] | undefined,
      })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      timeout: env.WEBAUTHN_CHALLENGE_TTL_SECONDS * 1000,
    })
    await this.storeChallenge(email, 'registration', options.challenge)
    return options
  }

  async verifyRegistration(email: string, response: RegistrationResponseJSON): Promise<VerifiedRegistration> {
    const challenge = await this.consumeChallenge(email, 'registration')
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: env.WEBAUTHN_ORIGINS,
        expectedRPID: env.WEBAUTHN_RP_ID,
        requireUserVerification: true,
        supportedAlgorithmIDs: [COSE_ALG_ES256],
      })
    } catch (error) {
      throw new BadRequestError('Passkey registration could not be verified', { reason: (error as Error).message }, 'WEBAUTHN_INVALID')
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new BadRequestError('Passkey registration could not be verified', undefined, 'WEBAUTHN_INVALID')
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo
    // Uncompressed 0x04 || X || Y point, the format the account contract stores
    const uncompressed = Buffer.from(convertCOSEtoPKCS(credential.publicKey))
    if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
      throw new BadRequestError('Passkey must use a P-256 (ES256) key', undefined, 'WEBAUTHN_UNSUPPORTED_KEY')
    }

    return {
      credentialId: credential.id,
      credentialPublicKey: credential.publicKey,
      hexPublicKey: uncompressed.toString('hex'),
      counter: credential.counter,
      transports: credential.transports?.join(','),
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
    }
  }

  async authenticationOptions(email: string, passkeys: Passkey[]): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const options = await this.requestOptions(passkeys)
    await this.storeChallenge(email, 'authentication', options.challenge)
    return options
  }

  /** Login assertion: verifies against a stored, single-use challenge. */
  async verifyLogin(email: string, passkey: Passkey, response: AuthenticationResponseJSON): Promise<number> {
    const challenge = await this.consumeChallenge(email, 'authentication')
    return this.verifyAssertion(passkey, response, challenge)
  }

  /**
   * Request options for signing a Soroban auth payload: the challenge *is* the
   * 32-byte authorization payload so the same assertion is valid on-chain.
   */
  async contractSigningOptions(passkeys: Passkey[], authPayload: Buffer): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return this.requestOptions(passkeys, authPayload)
  }

  /**
   * Verifies an assertion over a Soroban auth payload and converts it into the
   * pieces the account contract's `__check_auth` expects.
   */
  async verifyContractAssertion(passkey: Passkey, response: AuthenticationResponseJSON, authPayload: Buffer): Promise<ContractAssertion> {
    const newCounter = await this.verifyAssertion(passkey, response, isoBase64URL.fromBuffer(new Uint8Array(authPayload)))
    return {
      authenticatorData: Buffer.from(isoBase64URL.toBuffer(response.response.authenticatorData)),
      clientDataJson: Buffer.from(isoBase64URL.toBuffer(response.response.clientDataJSON)),
      signature: derToCompactP256(Buffer.from(isoBase64URL.toBuffer(response.response.signature))),
      newCounter,
    }
  }

  private async requestOptions(passkeys: Passkey[], challenge?: Buffer): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return generateAuthenticationOptions({
      rpID: env.WEBAUTHN_RP_ID,
      challenge: challenge ? new Uint8Array(challenge) : undefined,
      userVerification: 'required',
      timeout: env.WEBAUTHN_CHALLENGE_TTL_SECONDS * 1000,
      allowCredentials: passkeys.map(passkey => ({
        id: passkey.credentialId,
        transports: passkey.transports?.split(',') as AuthenticatorTransport[] | undefined,
      })),
    })
  }

  private async verifyAssertion(passkey: Passkey, response: AuthenticationResponseJSON, expectedChallenge: string): Promise<number> {
    if (response.id !== passkey.credentialId) throw new UnauthorizedError('Unknown passkey')
    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: env.WEBAUTHN_ORIGINS,
        expectedRPID: env.WEBAUTHN_RP_ID,
        requireUserVerification: true,
        credential: {
          id: passkey.credentialId,
          publicKey: new Uint8Array(passkey.credentialPublicKey),
          counter: Number(passkey.counter),
          transports: passkey.transports?.split(',') as AuthenticatorTransport[] | undefined,
        },
      })
    } catch (error) {
      throw new UnauthorizedError('Passkey assertion could not be verified', { reason: (error as Error).message })
    }
    if (!verification.verified) throw new UnauthorizedError('Passkey assertion could not be verified')

    await prisma.passkey.update({
      where: { id: passkey.id },
      data: { counter: BigInt(verification.authenticationInfo.newCounter), lastUsedAt: new Date() },
    })
    return verification.authenticationInfo.newCounter
  }

  private async storeChallenge(subject: string, purpose: ChallengePurpose, challenge: string): Promise<void> {
    await prisma.$transaction([
      prisma.webAuthnChallenge.deleteMany({ where: { subject, purpose } }),
      prisma.webAuthnChallenge.create({
        data: {
          subject,
          purpose,
          challenge,
          expiresAt: new Date(Date.now() + env.WEBAUTHN_CHALLENGE_TTL_SECONDS * 1000),
        },
      }),
    ])
  }

  /** Fetches and deletes the challenge so it can only be used once. */
  private async consumeChallenge(subject: string, purpose: ChallengePurpose): Promise<string> {
    const record = await prisma.webAuthnChallenge.findFirst({
      where: { subject, purpose },
      orderBy: { createdAt: 'desc' },
    })
    if (record) await prisma.webAuthnChallenge.deleteMany({ where: { subject, purpose } })
    if (!record || record.expiresAt < new Date()) {
      throw new BadRequestError('WebAuthn challenge missing or expired; request new options', undefined, 'CHALLENGE_EXPIRED')
    }
    return record.challenge
  }
}
