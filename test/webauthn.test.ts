import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock @simplewebauthn/server before importing the service
vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}));

// Mock prisma
vi.mock('../src/lib/prisma', () => {
  const mockPrisma = {
    webAuthnCredential: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  };
  return { prisma: mockPrisma, default: mockPrisma };
});

// Mock derToCompactP256
vi.mock('../src/lib/crypto/der', () => ({
  derToCompactP256: vi.fn(),
}));

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { prisma } from '../src/lib/prisma';
import { derToCompactP256 } from '../src/lib/crypto/der';
import { WebAuthnService } from '../src/interfaces/webauthn';

const mockGenerateRegistrationOptions = vi.mocked(generateRegistrationOptions);
const mockVerifyRegistrationResponse = vi.mocked(verifyRegistrationResponse);
const mockGenerateAuthenticationOptions = vi.mocked(generateAuthenticationOptions);
const mockVerifyAuthenticationResponse = vi.mocked(verifyAuthenticationResponse);
const mockPrisma = vi.mocked(prisma, true);
const mockDerToCompactP256 = vi.mocked(derToCompactP256);

const RP_ID = 'example.com';
const RP_NAME = 'Example';
const ORIGIN = 'https://example.com';

const P256_SPKI_HEX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';

function makeService(): WebAuthnService {
  return new WebAuthnService({
    rpId: RP_ID,
    rpName: RP_NAME,
    origin: ORIGIN,
  });
}

describe('WebAuthnService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('registrationOptions', () => {
    it('generates options and stores the challenge', async () => {
      const options = {
        challenge: 'reg-challenge-123',
        rp: { id: RP_ID, name: RP_NAME },
        user: { id: 'user-1', name: 'alice', displayName: 'Alice' },
        pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
      };
      mockGenerateRegistrationOptions.mockResolvedValue(options as any);

      const service = makeService();
      const result = await service.registrationOptions({
        userId: 'user-1',
        userName: 'alice',
        displayName: 'Alice',
      });

      expect(mockGenerateRegistrationOptions).toHaveBeenCalledTimes(1);
      expect(result).toEqual(options);

      // Challenge should be retrievable for later verification
      const stored = service.getStoredChallenge('user-1');
      expect(stored).toBe('reg-challenge-123');
    });

    it('passes existing credentials as excludeCredentials', async () => {
      mockPrisma.webAuthnCredential.findMany.mockResolvedValue([
        { credentialId: 'cred-1', transports: ['usb'] },
        { credentialId: 'cred-2', transports: null },
      ] as any);
      mockGenerateRegistrationOptions.mockResolvedValue({
        challenge: 'c',
      } as any);

      const service = makeService();
      await service.registrationOptions({
        userId: 'user-1',
        userName: 'alice',
        displayName: 'Alice',
      });

      const call = mockGenerateRegistrationOptions.mock.calls[0][0] as any;
      expect(call.excludeCredentials).toEqual([
        { id: 'cred-1', transports: ['usb'] },
        { id: 'cred-2', transports: undefined },
      ]);
    });
  });

  describe('authenticationOptions', () => {
    it('generates options and stores the challenge', async () => {
      mockPrisma.webAuthnCredential.findMany.mockResolvedValue([
        { credentialId: 'cred-1', transports: ['usb'] },
      ] as any);
      const options = {
        challenge: 'auth-challenge-456',
        allowCredentials: [{ id: 'cred-1', transports: ['usb'] }],
      };
      mockGenerateAuthenticationOptions.mockResolvedValue(options as any);

      const service = makeService();
      const result = await service.authenticationOptions({ userId: 'user-1' });

      expect(mockGenerateAuthenticationOptions).toHaveBeenCalledTimes(1);
      expect(result).toEqual(options);
      expect(service.getStoredChallenge('user-1')).toBe('auth-challenge-456');
    });
  });

  describe('verifyRegistration', () => {
    const baseResponse = {
      id: 'cred-1',
      rawId: 'cred-1',
      response: {
        clientDataJSON: 'client-data',
        attestationObject: 'attestation',
        transports: ['usb'],
      },
      type: 'public-key',
    } as any;

    it('verifies successfully and persists the credential', async () => {
      const service = makeService();
      // Seed a challenge
      mockGenerateRegistrationOptions.mockResolvedValue({ challenge: 'reg-challenge' } as any);
      await service.registrationOptions({
        userId: 'user-1',
        userName: 'alice',
        displayName: 'Alice',
      });

      mockVerifyRegistrationResponse.mockResolvedValue({
        verified: true,
        registrationInfo: {
          credential: {
            id: 'cred-1',
            publicKey: new Uint8Array([1, 2, 3]),
            counter: 0,
            transports: ['usb'],
          },
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
        },
      } as any);
      mockDerToCompactP256.mockReturnValue('compact-p256-hex');
      mockPrisma.webAuthnCredential.create.mockResolvedValue({} as any);

      const result = await service.verifyRegistration({
        userId: 'user-1',
        response: baseResponse,
      });

      expect(result.verified).toBe(true);
      expect(mockVerifyRegistrationResponse).toHaveBeenCalledTimes(1);
      expect(mockPrisma.webAuthnCredential.create).toHaveBeenCalledTimes(1);
      const createArg = mockPrisma.webAuthnCredential.create.mock.calls[0][0] as any;
      expect(createArg.data.userId).toBe('user-1');
      expect(createArg.data.credentialId).toBe('cred-1');
      expect(createArg.data.publicKey).toBe('compact-p256-hex');
      expect(createArg.data.counter).toBe(0);
    });

    it('returns verified:false when verification throws', async () => {
      const service = makeService();
      mockGenerateRegistrationOptions.mockResolvedValue({ challenge: 'reg-challenge' } as any);
      await service.registrationOptions({
        userId: 'user-1',
        userName: 'alice',
        displayName: 'Alice',
      });

      mockVerifyRegistrationResponse.mockRejectedValue(new Error('bad attestation'));

      const result = await service.verifyRegistration({
        userId: 'user-1',
        response: baseResponse,
      });

      expect(result.verified).toBe(false);
      expect(mockPrisma.webAuthnCredential.create).not.toHaveBeenCalled();
    });

    it('returns verified:false when response is not verified', async () => {
      const service = makeService();
      mockGenerateRegistrationOptions.mockResolvedValue({ challenge: 'reg-challenge' } as any);
      await service.registrationOptions({
        userId: 'user-1',
        userName: 'alice',
        displayName: 'Alice',
      });

      mockVerifyRegistrationResponse.mockResolvedValue({
        verified: false,
      } as any);

      const result = await service.verifyRegistration({
        userId: 'user-1',
        response: baseResponse,
      });

      expect(result.verified).toBe(false);
      expect(mockPrisma.webAuthnCredential.create).not.toHaveBeenCalled();
    });

    it('rejects non-P-256 keys', async () => {
      const service = makeService();
      mockGenerateRegistrationOptions.mockResolvedValue({ challenge: 'reg-challenge' } as any);
      await service.registrationOptions({
        userId: 'user-1',
        userName: 'alice',
        displayName: 'Alice',
      });

      mockVerifyRegistrationResponse.mockResolvedValue({
        verified: true,
        registrationInfo: {
          credential: {
            id: 'cred-1',
            // Not a P-256 SPKI prefix
            publicKey: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
            counter: 0,
            transports: [],
          },
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
        },
      } as any);

      const result = await service.verifyRegistration({
        userId: 'user-1',
        response: baseResponse,
      });

      expect(result.verified).toBe(false);
      expect(mockPrisma.webAuthnCredential.create).not.toHaveBeenCalled();
    });
  });

  describe('verifyLogin', () => {
    const loginResponse = {
      id: 'cred-1',
      rawId: 'cred-1',
      response: {
        clientDataJSON: 'client-data',
        authenticatorData: 'auth-data',
        signature: 'sig',
      },
      type: 'public-key',
    } as any;

    it('verifies successfully and updates the counter', async () => {
      const service = makeService();
      mockPrisma.webAuthnCredential.findMany.mockResolvedValue([
        { credentialId: 'cred-1', transports: ['usb'] },
      ] as any);
      mockGenerateAuthenticationOptions.mockResolvedValue({ challenge: 'auth-challenge' } as any);
      await service.authenticationOptions({ userId: 'user-1' });

      mockPrisma.webAuthnCredential.findUnique.mockResolvedValue({
        credentialId: 'cred-1',
        userId: 'user-1',
        publicKey: 'compact-p256-hex',
        counter: 5,
        transports: ['usb'],
      } as any);
      mockVerifyAuthenticationResponse.mockResolvedValue({
        verified: true,
        authenticationInfo: { newCounter: 6 },
      } as any);
      mockPrisma.webAuthnCredential.update.mockResolvedValue({} as any);

      const result = await service.verifyLogin({
        userId: 'user-1',
        response: loginResponse,
      });

      expect(result.verified).toBe(true);
      expect(mockPrisma.webAuthnCredential.update).toHaveBeenCalledTimes(1);
      const updateArg = mockPrisma.webAuthnCredential.update.mock.calls[0][0] as any;
      expect(updateArg.where).toEqual({ credentialId: 'cred-1' });
      expect(updateArg.data.counter).toBe(6);
    });

    it('fails for unknown credential', async () => {
      const service = makeService();
      mockPrisma.webAuthnCredential.findMany.mockResolvedValue([] as any);
      mockGenerateAuthenticationOptions.mockResolvedValue({ challenge: 'auth-challenge' } as any);
      await service.authenticationOptions({ userId: 'user-1' });

      mockPrisma.webAuthnCredential.findUnique.mockResolvedValue(null);

      const result = await service.verifyLogin({
        userId: 'user-1',
        response: loginResponse,
      });

      expect(result.verified).toBe(false);
      expect(mockVerifyAuthenticationResponse).not.toHaveBeenCalled();
      expect(mockPrisma.webAuthnCredential.update).not.toHaveBeenCalled();
    });

    it('fails when verification throws', async () => {
      const service = makeService();
      mockPrisma.webAuthnCredential.findMany.mockResolvedValue([
        { credentialId: 'cred-1', transports: ['usb'] },
      ] as any);
      mockGenerateAuthenticationOptions.mockResolvedValue({ challenge: 'auth-challenge' } as any);
      await service.authenticationOptions({ userId: 'user-1' });

      mockPrisma.webAuthnCredential.findUnique.mockResolvedValue({
        credentialId: 'cred-1',
        userId: 'user-1',
        publicKey: 'compact-p256-hex',
        counter: 5,
        transports: ['usb'],
      } as any);
      mockVerifyAuthenticationResponse.mockRejectedValue(new Error('bad signature'));

      const result = await service.verifyLogin({
        userId: 'user-1',
        response: loginResponse,
      });

      expect(result.verified).toBe(false);
      expect(mockPrisma.webAuthnCredential.update).not.toHaveBeenCalled();
    });

    it('fails when response is not verified', async () => {
      const service = makeService();
      mockPrisma.webAuthnCredential.findMany.mockResolvedValue([
        { credentialId: 'cred-1', transports: ['usb'] },
      ] as any);
      mockGenerateAuthenticationOptions.mockResolvedValue({ challenge: 'auth-challenge' } as any);
      await service.authenticationOptions({ userId: 'user-1' });

      mockPrisma.webAuthnCredential.findUnique.mockResolvedValue({
        credentialId: 'cred-1',
        userId: 'user-1',
        publicKey: 'compact-p256-hex',
        counter: 5,
        transports: ['usb'],
      } as any);
      mockVerifyAuthenticationResponse.mockResolvedValue({
        verified: false,
      } as any);

      const result = await service.verifyLogin({
        userId: 'user-1',
        response: loginResponse,
      });

      expect(result.verified).toBe(false);
      expect(mockPrisma.webAuthnCredential.update).not.toHaveBeenCalled();
    });
  });

  describe('contractSigningOptions', () => {
    it('generates authentication options for contract signing', async () => {
      mockPrisma.webAuthnCredential.findMany.mockResolvedValue([
        { credentialId: 'cred-1', transports: ['usb'] },
      ] as any);
      mockGenerateAuthenticationOptions.mockResolvedValue({
        challenge: 'contract-challenge',
      } as any);

      const service = makeService();
      const result = await service.contractSigningOptions({
        userId: 'user-1',
        contractId: 'CABC',
      });

      expect(mockGenerateAuthenticationOptions).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ challenge: 'contract-challenge' });
      expect(service.getStoredChallenge('user-1')).toBe('contract-challenge');
    });
  });

  describe('verifyContractAssertion', () => {
    it('returns the expected output shape on success', async () => {
      const service = makeService();
      mockPrisma.webAuthnCredential.findMany.mockResolvedValue([
        { credentialId: 'cred-1', transports: ['usb'] },
      ] as any);
      mockGenerateAuthenticationOptions.mockResolvedValue({
        challenge: 'contract-challenge',
      } as any);
      await service.contractSigningOptions({ userId: 'user-1', contractId: 'CABC' });

      mockPrisma.webAuthnCredential.findUnique.mockResolvedValue({
        credentialId: 'cred-1',
        userId: 'user-1',
        publicKey: 'compact-p256-hex',
        counter: 2,
        transports: ['usb'],
      } as any);
      mockVerifyAuthenticationResponse.mockResolvedValue({
        verified: true,
        authenticationInfo: { newCounter: 3 },
      } as any);
      mockPrisma.webAuthnCredential.update.mockResolvedValue({} as any);

      const result = await service.verifyContractAssertion({
        userId: 'user-1',
        contractId: 'CABC',
        response: {
          id: 'cred-1',
          rawId: 'cred-1',
          response: {
            clientDataJSON: 'client-data',
            authenticatorData: 'auth-data',
            signature: 'sig',
          },
          type: 'public-key',
        } as any,
      });

      expect(result).toHaveProperty('verified');
      expect(result).toHaveProperty('credentialId');
      expect(result).toHaveProperty('newCounter');
      expect(result.verified).toBe(true);
      expect(result.credentialId).toBe('cred-1');
      expect(result.newCounter).toBe(3);
    });

    it('returns verified:false on failure', async () => {
      const service = makeService();
      mockPrisma.webAuthnCredential.findMany.mockResolvedValue([] as any);
      mockGenerateAuthenticationOptions.mockResolvedValue({
        challenge: 'contract-challenge',
      } as any);
      await service.contractSigningOptions({ userId: 'user-1', contractId: 'CABC' });

      mockPrisma.webAuthnCredential.findUnique.mockResolvedValue(null);

      const result = await service.verifyContractAssertion({
        userId: 'user-1',
        contractId: 'CABC',
        response: {
          id: 'cred-1',
          rawId: 'cred-1',
          response: {
            clientDataJSON: 'client-data',
            authenticatorData: 'auth-data',
            signature: 'sig',
          },
          type: 'public-key',
        } as any,
      });

      expect(result.verified).toBe(false);
    });
  });
});