import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const prismaMock = {
  wallet: {
    findUnique: vi.fn(),
  },
  sessionKey: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  invocation: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
};

vi.mock('../src/lib/prisma', () => ({
  prisma: prismaMock,
}));

const sorobanMock = {
  getAccount: vi.fn(),
  simulateTransaction: vi.fn(),
  submitTransaction: vi.fn(),
  buildInvocationTransaction: vi.fn(),
};

vi.mock('../src/interfaces/soroban', () => ({
  SorobanService: vi.fn().mockImplementation(() => sorobanMock),
}));

const paymasterMock = {
  release: vi.fn(),
  reserve: vi.fn(),
};

vi.mock('../src/interfaces/paymaster', () => ({
  Paymaster: vi.fn().mockImplementation(() => paymasterMock),
}));

const webauthnMock = {
  verifyAssertion: vi.fn(),
};

vi.mock('../src/interfaces/webauthn', () => ({
  WebAuthnService: vi.fn().mockImplementation(() => webauthnMock),
}));

// Import after mocks are registered.
import { InvocationService, toJsonSafe } from '../src/api/wallet/invocation-service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeService() {
  return new InvocationService();
}

const WALLET_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const SESSION_KEY_ID = 'sk_123';
const INVOCATION_ID = 'inv_123';
const SIGNER = 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

function baseWallet(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wallet_1',
    address: WALLET_ADDRESS,
    deployed: true,
    allowedContracts: [CONTRACT_ID],
    ...overrides,
  };
}

function baseSessionKey(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_KEY_ID,
    walletId: 'wallet_1',
    publicKey: 'session-public-key',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

function baseInvocation(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOCATION_ID,
    walletId: 'wallet_1',
    contractId: CONTRACT_ID,
    status: 'PENDING',
    signerType: 'session_key',
    sessionKeyId: SESSION_KEY_ID,
    signer: SIGNER,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// toJsonSafe
// ---------------------------------------------------------------------------

describe('toJsonSafe', () => {
  it('passes through primitives', () => {
    expect(toJsonSafe('hello')).toBe('hello');
    expect(toJsonSafe(42)).toBe(42);
    expect(toJsonSafe(true)).toBe(true);
    expect(toJsonSafe(null)).toBe(null);
  });

  it('converts bigint to string', () => {
    expect(toJsonSafe(123n)).toBe('123');
    expect(toJsonSafe(-5n)).toBe('-5');
  });

  it('converts Date to ISO string', () => {
    const d = new Date('2024-01-02T03:04:05.000Z');
    expect(toJsonSafe(d)).toBe('2024-01-02T03:04:05.000Z');
  });

  it('converts Buffer to base64 string', () => {
    const buf = Buffer.from('abc');
    expect(toJsonSafe(buf)).toBe(buf.toString('base64'));
  });

  it('recursively converts arrays', () => {
    expect(toJsonSafe([1n, 'a', [2n]])).toEqual(['1', 'a', ['2']]);
  });

  it('recursively converts plain objects', () => {
    const input = { a: 1n, b: { c: new Date('2024-01-01T00:00:00.000Z') } };
    expect(toJsonSafe(input)).toEqual({ a: '1', b: { c: '2024-01-01T00:00:00.000Z' } });
  });

  it('handles nested bigint inside arrays of objects', () => {
    const input = [{ amount: 10n }, { amount: 20n }];
    expect(toJsonSafe(input)).toEqual([{ amount: '10' }, { amount: '20' }]);
  });
});

// ---------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------

describe('InvocationService.prepare', () => {
  let service: InvocationService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = makeService();
  });

  it('fails when wallet is not found', async () => {
    prismaMock.wallet.findUnique.mockResolvedValue(null);

    await expect(
      service.prepare({
        walletAddress: WALLET_ADDRESS,
        contractId: CONTRACT_ID,
        method: 'transfer',
        args: [],
        signerType: 'session_key',
        sessionKeyId: SESSION_KEY_ID,
      }),
    ).rejects.toThrow(/wallet/i);
  });

  it('fails when wallet is not deployed', async () => {
    prismaMock.wallet.findUnique.mockResolvedValue(baseWallet({ deployed: false }));

    await expect(
      service.prepare({
        walletAddress: WALLET_ADDRESS,
        contractId: CONTRACT_ID,
        method: 'transfer',
        args: [],
        signerType: 'session_key',
        sessionKeyId: SESSION_KEY_ID,
      }),
    ).rejects.toThrow(/deploy/i);
  });

  it('fails when contract is not in the allowlist', async () => {
    prismaMock.wallet.findUnique.mockResolvedValue(
      baseWallet({ allowedContracts: ['COTHERCONTRACT'] }),
    );

    await expect(
      service.prepare({
        walletAddress: WALLET_ADDRESS,
        contractId: CONTRACT_ID,
        method: 'transfer',
        args: [],
        signerType: 'session_key',
        sessionKeyId: SESSION_KEY_ID,
      }),
    ).rejects.toThrow(/allow|contract/i);
  });

  it('fails when a foreign signer is supplied', async () => {
    prismaMock.wallet.findUnique.mockResolvedValue(baseWallet());
    prismaMock.sessionKey.findUnique.mockResolvedValue(baseSessionKey());

    await expect(
      service.prepare({
        walletAddress: WALLET_ADDRESS,
        contractId: CONTRACT_ID,
        method: 'transfer',
        args: [],
        signerType: 'session_key',
        sessionKeyId: SESSION_KEY_ID,
        signer: 'GFOREIGNSIGNER',
      }),
    ).rejects.toThrow(/signer/i);
  });

  it('fails when the session key is revoked', async () => {
    prismaMock.wallet.findUnique.mockResolvedValue(baseWallet());
    prismaMock.sessionKey.findUnique.mockResolvedValue(
      baseSessionKey({ revokedAt: new Date() }),
    );

    await expect(
      service.prepare({
        walletAddress: WALLET_ADDRESS,
        contractId: CONTRACT_ID,
        method: 'transfer',
        args: [],
        signerType: 'session_key',
        sessionKeyId: SESSION_KEY_ID,
      }),
    ).rejects.toThrow(/revoked|session/i);
  });

  it('fails when the session key is expired', async () => {
    prismaMock.wallet.findUnique.mockResolvedValue(baseWallet());
    prismaMock.sessionKey.findUnique.mockResolvedValue(
      baseSessionKey({ expiresAt: new Date(Date.now() - 60_000) }),
    );

    await expect(
      service.prepare({
        walletAddress: WALLET_ADDRESS,
        contractId: CONTRACT_ID,
        method: 'transfer',
        args: [],
        signerType: 'session_key',
        sessionKeyId: SESSION_KEY_ID,
      }),
    ).rejects.toThrow(/expired|session/i);
  });

  it('fails when the simulation is missing an auth entry', async () => {
    prismaMock.wallet.findUnique.mockResolvedValue(baseWallet());
    prismaMock.sessionKey.findUnique.mockResolvedValue(baseSessionKey());
    sorobanMock.getAccount.mockResolvedValue({ accountId: WALLET_ADDRESS, sequence: '1' });
    sorobanMock.buildInvocationTransaction.mockResolvedValue({ toXDR: () => 'xdr' });
    sorobanMock.simulateTransaction.mockResolvedValue({
      success: true,
      auth: [],
      result: { retval: 'ok' },
    });

    await expect(
      service.prepare({
        walletAddress: WALLET_ADDRESS,
        contractId: CONTRACT_ID,
        method: 'transfer',
        args: [],
        signerType: 'session_key',
        sessionKeyId: SESSION_KEY_ID,
      }),
    ).rejects.toThrow(/auth/i);
  });

  it('requires a signature when signerType is none', async () => {
    prismaMock.wallet.findUnique.mockResolvedValue(baseWallet());
    sorobanMock.getAccount.mockResolvedValue({ accountId: WALLET_ADDRESS, sequence: '1' });
    sorobanMock.buildInvocationTransaction.mockResolvedValue({ toXDR: () => 'xdr' });
    sorobanMock.simulateTransaction.mockResolvedValue({
      success: true,
      auth: [{ credentials: { address: WALLET_ADDRESS } }],
      result: { retval: 'ok' },
    });

    await expect(
      service.prepare({
        walletAddress: WALLET_ADDRESS,
        contractId: CONTRACT_ID,
        method: 'transfer',
        args: [],
        signerType: 'none',
      }),
    ).rejects.toThrow(/signature|signer/i);
  });

  it('succeeds and creates a pending invocation', async () => {
    prismaMock.wallet.findUnique.mockResolvedValue(baseWallet());
    prismaMock.sessionKey.findUnique.mockResolvedValue(baseSessionKey());
    sorobanMock.getAccount.mockResolvedValue({ accountId: WALLET_ADDRESS, sequence: '1' });
    sorobanMock.buildInvocationTransaction.mockResolvedValue({ toXDR: () => 'xdr' });
    sorobanMock.simulateTransaction.mockResolvedValue({
      success: true,
      auth: [{ credentials: { address: WALLET_ADDRESS } }],
      result: { retval: 'ok' },
    });
    prismaMock.invocation.create.mockResolvedValue(baseInvocation());

    const result = await service.prepare({
      walletAddress: WALLET_ADDRESS,
      contractId: CONTRACT_ID,
      method: 'transfer',
      args: [],
      signerType: 'session_key',
      sessionKeyId: SESSION_KEY_ID,
    });

    expect(prismaMock.invocation.create).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
    expect(result.id).toBe(INVOCATION_ID);
  });
});

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------

describe('InvocationService.submit', () => {
  let service: InvocationService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = makeService();
  });

  it('rejects when the invocation is already submitted', async () => {
    prismaMock.invocation.findUnique.mockResolvedValue(
      baseInvocation({ status: 'SUBMITTED' }),
    );

    await expect(
      service.submit({
        invocationId: INVOCATION_ID,
        signature: 'sig',
      }),
    ).rejects.toThrow(/already|submitted|status/i);
  });

  it('rejects when the invocation has expired', async () => {
    prismaMock.invocation.findUnique.mockResolvedValue(
      baseInvocation({ expiresAt: new Date(Date.now() - 60_000) }),
    );

    await expect(
      service.submit({
        invocationId: INVOCATION_ID,
        signature: 'sig',
      }),
    ).rejects.toThrow(/expired/i);
  });

  it('rejects when the signer does not match', async () => {
    prismaMock.invocation.findUnique.mockResolvedValue(baseInvocation());
    prismaMock.wallet.findUnique.mockResolvedValue(baseWallet());
    prismaMock.sessionKey.findUnique.mockResolvedValue(baseSessionKey());

    await expect(
      service.submit({
        invocationId: INVOCATION_ID,
        signature: 'sig',
        signer: 'GWRONGSIGNER',
      }),
    ).rejects.toThrow(/signer/i);
  });

  it('verifies a session-key signature', async () => {
    prismaMock.invocation.findUnique.mockResolvedValue(baseInvocation());
    prismaMock.wallet.findUnique.mockResolvedValue(baseWallet());
    prismaMock.sessionKey.findUnique.mockResolvedValue(baseSessionKey());
    prismaMock.invocation.updateMany.mockResolvedValue({ count: 1 });
    sorobanMock.submitTransaction.mockResolvedValue({ hash: 'txhash', status: 'SUCCESS' });
    prismaMock.invocation.update.mockResolvedValue(
      baseInvocation({ status: 'SUBMITTED' }),
    );

    const result = await service.submit({
      invocationId: INVOCATION_ID,
      signature: 'sig',
    });

    expect(sorobanMock.submitTransaction).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
  });

  it('verifies a passkey signature via WebAuthnService', async () => {
    prismaMock.invocation.findUnique.mockResolvedValue(
      baseInvocation({ signerType: 'passkey', sessionKeyId: null }),
    );
    prismaMock.wallet.findUnique.mockResolvedValue(baseWallet());
    webauthnMock.verifyAssertion.mockResolvedValue(true);
    prismaMock.invocation.updateMany.mockResolvedValue({ count: 1 });
    sorobanMock.submitTransaction.mockResolvedValue({ hash: 'txhash', status: 'SUCCESS' });
    prismaMock.invocation.update.mockResolvedValue(
      baseInvocation({ status: 'SUBMITTED', signerType: 'passkey' }),
    );

    const result = await service.submit({
      invocationId: INVOCATION_ID,
      signature: 'sig',
    });

    expect(webauthnMock.verifyAssertion).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
  });

  it('rejects when passkey verification fails', async () => {
    prismaMock.invocation.findUnique.mockResolvedValue(
      baseInvocation({ signerType: 'passkey', sessionKeyId: null }),
    );
    prismaMock.wallet.findUnique.mockResolvedValue(baseWallet());
    webauthnMock.verifyAssertion.mockResolvedValue(false);

    await expect(
      service.submit({
        invocationId: INVOCATION_ID,
        signature: 'sig',
      }),
    ).rejects.toThrow(/signature|verif/i);
  });

  it('handles a claim race (updateMany count 0)', async () => {
    prismaMock.invocation.findUnique.mockResolvedValue(baseInvocation());
    prismaMock.wallet.findUnique.mockResolvedValue(baseWallet());
    prismaMock.sessionKey.findUnique.mockResolvedValue(baseSessionKey());
    prismaMock.invocation.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.submit({
        invocationId: INVOCATION_ID,
        signature: 'sig',
      }),
    ).rejects.toThrow(/already|claim|submitted|status/i);

    expect(sorobanMock.submitTransaction).not.toHaveBeenCalled();
  });

  it('records success bookkeeping after submission', async () => {
    prismaMock.invocation.findUnique.mockResolvedValue(baseInvocation());
    prismaMock.wallet.findUnique.mockResolvedValue(baseWallet());
    prismaMock.sessionKey.findUnique.mockResolvedValue(baseSessionKey());
    prismaMock.invocation.updateMany.mockResolvedValue({ count: 1 });
    sorobanMock.submitTransaction.mockResolvedValue({ hash: 'txhash', status: 'SUCCESS' });
    prismaMock.invocation.update.mockResolvedValue(
      baseInvocation({ status: 'SUBMITTED' }),
    );

    await service.submit({
      invocationId: INVOCATION_ID,
      signature: 'sig',
    });

    expect(prismaMock.invocation.update).toHaveBeenCalled();
    const updateArg = prismaMock.invocation.update.mock.calls[0][0];
    expect(updateArg.where.id).toBe(INVOCATION_ID);
    expect(updateArg.data.status).toBe('SUBMITTED');
  });

  it('marks failure and releases the paymaster reservation on submit error', async () => {
    prismaMock.invocation.findUnique.mockResolvedValue(baseInvocation());
    prismaMock.wallet.findUnique.mockResolvedValue(baseWallet());
    prismaMock.sessionKey.findUnique.mockResolvedValue(baseSessionKey());
    prismaMock.invocation.updateMany.mockResolvedValue({ count: 1 });
    sorobanMock.submitTransaction.mockRejectedValue(new Error('network down'));
    prismaMock.invocation.update.mockResolvedValue(
      baseInvocation({ status: 'FAILED' }),
    );

    await expect(
      service.submit({
        invocationId: INVOCATION_ID,
        signature: 'sig',
      }),
    ).rejects.toThrow(/network down/);

    expect(prismaMock.invocation.update).toHaveBeenCalled();
    const updateArg = prismaMock.invocation.update.mock.calls[0][0];
    expect(updateArg.data.status).toBe('FAILED');
    expect(paymasterMock.release).toHaveBeenCalled();
  });
});