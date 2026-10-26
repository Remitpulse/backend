import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/utils/prisma', () => {
  const prisma = {
    sessionKey: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    wallet: {
      findUnique: vi.fn(),
    },
  };
  return { prisma, default: prisma };
});

vi.mock('../src/api/wallet/invocation-service', () => {
  return {
    InvocationService: {
      prepare: vi.fn(),
      allowedContracts: vi.fn(),
    },
  };
});

vi.mock('../src/interfaces/soroban/mutex', () => {
  return {
    SorobanService: {
      validUntilLedger: vi.fn(),
    },
  };
});

import { prisma } from '../src/utils/prisma';
import { InvocationService } from '../src/api/wallet/invocation-service';
import { SorobanService } from '../src/interfaces/soroban/mutex';
import {
  SessionKeyService,
  serializeSessionKey,
} from '../src/api/session-keys/service';

const NOW = new Date('2025-01-01T00:00:00.000Z');

const baseSessionKey = {
  id: 'sk_1',
  walletId: 'wallet_1',
  publicKey: 'GABC123',
  contractId: 'CABC123',
  token: 'USDC',
  perTxLimit: '100',
  totalLimit: '1000',
  spent: '0',
  expiresAt: new Date('2025-02-01T00:00:00.000Z'),
  revokedAt: null as Date | null,
  createdAt: NOW,
  updatedAt: NOW,
};

describe('serializeSessionKey', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('serializes an active session key', () => {
    const result = serializeSessionKey(baseSessionKey as any);
    expect(result).toEqual({
      id: 'sk_1',
      walletId: 'wallet_1',
      publicKey: 'GABC123',
      contractId: 'CABC123',
      token: 'USDC',
      perTxLimit: '100',
      totalLimit: '1000',
      spent: '0',
      expiresAt: baseSessionKey.expiresAt,
      revokedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      status: 'active',
    });
  });

  it('derives expired status when expiresAt is in the past', () => {
    const expired = {
      ...baseSessionKey,
      expiresAt: new Date('2024-12-01T00:00:00.000Z'),
    };
    const result = serializeSessionKey(expired as any);
    expect(result.status).toBe('expired');
  });

  it('derives revoked status when revokedAt is set', () => {
    const revoked = {
      ...baseSessionKey,
      revokedAt: new Date('2024-12-15T00:00:00.000Z'),
    };
    const result = serializeSessionKey(revoked as any);
    expect(result.status).toBe('revoked');
  });

  it('prefers revoked status over expired', () => {
    const revokedAndExpired = {
      ...baseSessionKey,
      revokedAt: new Date('2024-12-15T00:00:00.000Z'),
      expiresAt: new Date('2024-12-01T00:00:00.000Z'),
    };
    const result = serializeSessionKey(revokedAndExpired as any);
    expect(result.status).toBe('revoked');
  });
});

describe('SessionKeyService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('issue', () => {
    const validInput = {
      walletId: 'wallet_1',
      publicKey: 'GABC123',
      contractId: 'CABC123',
      token: 'USDC',
      perTxLimit: '100',
      totalLimit: '1000',
      ttlSeconds: 3600,
    };

    beforeEach(() => {
      (prisma.wallet.findUnique as any).mockResolvedValue({
        id: 'wallet_1',
        deployed: true,
      });
      (InvocationService.allowedContracts as any).mockResolvedValue([
        'CABC123',
      ]);
      (InvocationService.prepare as any).mockResolvedValue({
        xdr: 'prepared-xdr',
      });
      (SorobanService.validUntilLedger as any).mockResolvedValue(12345);
      (prisma.sessionKey.findFirst as any).mockResolvedValue(null);
      (prisma.sessionKey.create as any).mockImplementation(
        async ({ data }: any) => ({
          ...baseSessionKey,
          ...data,
        }),
      );
    });

    it('issues a session key successfully', async () => {
      const result = await SessionKeyService.issue(validInput as any);

      expect(prisma.wallet.findUnique).toHaveBeenCalledWith({
        where: { id: 'wallet_1' },
      });
      expect(InvocationService.allowedContracts).toHaveBeenCalledWith(
        'wallet_1',
      );
      expect(InvocationService.prepare).toHaveBeenCalled();
      expect(SorobanService.validUntilLedger).toHaveBeenCalled();
      expect(prisma.sessionKey.create).toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(result.publicKey).toBe('GABC123');
    });

    it('fails when wallet is not deployed', async () => {
      (prisma.wallet.findUnique as any).mockResolvedValue({
        id: 'wallet_1',
        deployed: false,
      });

      await expect(
        SessionKeyService.issue(validInput as any),
      ).rejects.toThrow(/deployed/i);
      expect(prisma.sessionKey.create).not.toHaveBeenCalled();
    });

    it('fails when wallet does not exist', async () => {
      (prisma.wallet.findUnique as any).mockResolvedValue(null);

      await expect(
        SessionKeyService.issue(validInput as any),
      ).rejects.toThrow();
      expect(prisma.sessionKey.create).not.toHaveBeenCalled();
    });

    it('fails when perTxLimit exceeds totalLimit', async () => {
      await expect(
        SessionKeyService.issue({
          ...validInput,
          perTxLimit: '2000',
          totalLimit: '1000',
        } as any),
      ).rejects.toThrow();
      expect(prisma.sessionKey.create).not.toHaveBeenCalled();
    });

    it('fails when perTxLimit is invalid', async () => {
      await expect(
        SessionKeyService.issue({
          ...validInput,
          perTxLimit: 'not-a-number',
        } as any),
      ).rejects.toThrow();
      expect(prisma.sessionKey.create).not.toHaveBeenCalled();
    });

    it('fails when totalLimit is invalid', async () => {
      await expect(
        SessionKeyService.issue({
          ...validInput,
          totalLimit: '-5',
        } as any),
      ).rejects.toThrow();
      expect(prisma.sessionKey.create).not.toHaveBeenCalled();
    });

    it('fails when ttlSeconds exceeds maximum', async () => {
      await expect(
        SessionKeyService.issue({
          ...validInput,
          ttlSeconds: 60 * 60 * 24 * 365 * 10,
        } as any),
      ).rejects.toThrow();
      expect(prisma.sessionKey.create).not.toHaveBeenCalled();
    });

    it('fails when ttlSeconds is not positive', async () => {
      await expect(
        SessionKeyService.issue({
          ...validInput,
          ttlSeconds: 0,
        } as any),
      ).rejects.toThrow();
      expect(prisma.sessionKey.create).not.toHaveBeenCalled();
    });

    it('fails when token is unsupported', async () => {
      await expect(
        SessionKeyService.issue({
          ...validInput,
          token: 'NOT_A_TOKEN',
        } as any),
      ).rejects.toThrow();
      expect(prisma.sessionKey.create).not.toHaveBeenCalled();
    });

    it('fails when contract is not allowed for wallet', async () => {
      (InvocationService.allowedContracts as any).mockResolvedValue([
        'COTHER',
      ]);

      await expect(
        SessionKeyService.issue(validInput as any),
      ).rejects.toThrow();
      expect(prisma.sessionKey.create).not.toHaveBeenCalled();
    });

    it('fails when public key is duplicated', async () => {
      (prisma.sessionKey.findFirst as any).mockResolvedValue({
        ...baseSessionKey,
      });

      await expect(
        SessionKeyService.issue(validInput as any),
      ).rejects.toThrow();
      expect(prisma.sessionKey.create).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('returns serialized session keys for a wallet', async () => {
      (prisma.sessionKey.findMany as any).mockResolvedValue([
        baseSessionKey,
        {
          ...baseSessionKey,
          id: 'sk_2',
          revokedAt: new Date('2024-12-15T00:00:00.000Z'),
        },
      ]);

      const result = await SessionKeyService.list('wallet_1');

      expect(prisma.sessionKey.findMany).toHaveBeenCalledWith({
        where: { walletId: 'wallet_1' },
        orderBy: { createdAt: 'desc' },
      });
      expect(result).toHaveLength(2);
      expect(result[0].status).toBe('active');
      expect(result[1].status).toBe('revoked');
    });

    it('returns empty array when no keys exist', async () => {
      (prisma.sessionKey.findMany as any).mockResolvedValue([]);

      const result = await SessionKeyService.list('wallet_1');
      expect(result).toEqual([]);
    });
  });

  describe('revoke', () => {
    it('revokes an existing session key', async () => {
      (prisma.sessionKey.findFirst as any).mockResolvedValue({
        ...baseSessionKey,
      });
      (prisma.sessionKey.update as any).mockResolvedValue({
        ...baseSessionKey,
        revokedAt: NOW,
      });

      const result = await SessionKeyService.revoke('wallet_1', 'sk_1');

      expect(prisma.sessionKey.findFirst).toHaveBeenCalledWith({
        where: { id: 'sk_1', walletId: 'wallet_1' },
      });
      expect(prisma.sessionKey.update).toHaveBeenCalledWith({
        where: { id: 'sk_1' },
        data: { revokedAt: expect.any(Date) },
      });
      expect(result.status).toBe('revoked');
    });

    it('fails when session key is not found', async () => {
      (prisma.sessionKey.findFirst as any).mockResolvedValue(null);

      await expect(
        SessionKeyService.revoke('wallet_1', 'missing'),
      ).rejects.toThrow();
      expect(prisma.sessionKey.update).not.toHaveBeenCalled();
    });

    it('fails when session key belongs to another wallet', async () => {
      (prisma.sessionKey.findFirst as any).mockResolvedValue(null);

      await expect(
        SessionKeyService.revoke('wallet_2', 'sk_1'),
      ).rejects.toThrow();
      expect(prisma.sessionKey.update).not.toHaveBeenCalled();
    });
  });
});