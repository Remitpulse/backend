import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/utils/prisma', () => {
  const prismaMock = {
    sponsoredTransaction: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      aggregate: vi.fn(),
    },
  };
  return { prisma: prismaMock, default: prismaMock };
});

vi.mock('../src/interfaces/soroban', () => {
  return {
    SorobanService: {
      send: vi.fn(),
    },
  };
});

import { prisma } from '../src/utils/prisma';
import { SorobanService } from '../src/interfaces/soroban';

const PAYMASTER_SECRET =
  'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PAYMASTER_PUBLIC =
  'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const USER_PUBLIC = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const OTHER_CONTRACT_ID =
  'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

type PaymasterModule = typeof import('../src/interfaces/paymaster');

let paymaster: PaymasterModule;

async function loadPaymaster(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  process.env.PAYMASTER_SECRET = PAYMASTER_SECRET;
  process.env.PAYMASTER_PUBLIC = PAYMASTER_PUBLIC;
  process.env.PAYMASTER_NETWORK = 'testnet';
  process.env.PAYMASTER_MAX_FEE = '1000000';
  process.env.PAYMASTER_ALLOWED_CONTRACTS = CONTRACT_ID;
  process.env.PAYMASTER_DAILY_BUDGET = '10000000';
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  paymaster = await import('../src/interfaces/paymaster');
}

function makeInnerOp(overrides: Record<string, any> = {}) {
  return {
    source: USER_PUBLIC,
    operation: {
      type: 'invokeHostFunction',
      func: {
        invokeContract: {
          contractAddress: CONTRACT_ID,
          functionName: 'transfer',
          args: [],
        },
      },
    },
    ...overrides,
  };
}

function makeFeeBump(overrides: Record<string, any> = {}) {
  return {
    type: 'feeBump',
    networkPassphrase: 'Test SDF Network ; September 2015',
    fee: '100',
    innerTransaction: makeInnerOp(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.sponsoredTransaction.create as any).mockResolvedValue({ id: 'sp-1' });
  (prisma.sponsoredTransaction.update as any).mockResolvedValue({ id: 'sp-1' });
  (prisma.sponsoredTransaction.findMany as any).mockResolvedValue([]);
  (prisma.sponsoredTransaction.aggregate as any).mockResolvedValue({
    _sum: { fee: 0 },
  });
  (SorobanService.send as any).mockResolvedValue({
    hash: 'deadbeef',
    status: 'SUCCESS',
  });
});

afterEach(() => {
  delete process.env.PAYMASTER_SECRET;
  delete process.env.PAYMASTER_PUBLIC;
  delete process.env.PAYMASTER_NETWORK;
  delete process.env.PAYMASTER_MAX_FEE;
  delete process.env.PAYMASTER_ALLOWED_CONTRACTS;
  delete process.env.PAYMASTER_DAILY_BUDGET;
});

describe('paymaster.assertSponsorable', () => {
  beforeEach(async () => {
    await loadPaymaster();
  });

  it('accepts a valid inner operation', () => {
    expect(() => paymaster.assertSponsorable(makeInnerOp())).not.toThrow();
  });

  it('rejects a fee-bump input', () => {
    expect(() => paymaster.assertSponsorable(makeFeeBump())).toThrow();
  });

  it('rejects an operation on the wrong network', () => {
    const op = makeInnerOp({
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
    });
    expect(() => paymaster.assertSponsorable(op)).toThrow();
  });

  it('rejects when the paymaster is the source', () => {
    const op = makeInnerOp({ source: PAYMASTER_PUBLIC });
    expect(() => paymaster.assertSponsorable(op)).toThrow();
  });

  it('rejects non-single-operation transactions', () => {
    const op = makeInnerOp({
      operations: [makeInnerOp().operation, makeInnerOp().operation],
    });
    expect(() => paymaster.assertSponsorable(op)).toThrow();
  });

  it('rejects non-invoke operations', () => {
    const op = makeInnerOp({
      operation: { type: 'payment', destination: USER_PUBLIC, amount: '1' },
    });
    expect(() => paymaster.assertSponsorable(op)).toThrow();
  });

  it('rejects contracts that are not allow-listed', () => {
    const op = makeInnerOp({
      operation: {
        type: 'invokeHostFunction',
        func: {
          invokeContract: {
            contractAddress: OTHER_CONTRACT_ID,
            functionName: 'transfer',
            args: [],
          },
        },
      },
    });
    expect(() => paymaster.assertSponsorable(op)).toThrow();
  });

  it('rejects fees over the cap', () => {
    const op = makeInnerOp({ fee: '999999999' });
    expect(() => paymaster.assertSponsorable(op)).toThrow();
  });

  it('rejects unsigned inners', () => {
    const op = makeInnerOp({ signatures: [] });
    expect(() => paymaster.assertSponsorable(op)).toThrow();
  });
});

describe('paymaster.wrap', () => {
  beforeEach(async () => {
    await loadPaymaster();
  });

  it('builds and signs a fee-bump transaction', async () => {
    const result = await paymaster.wrap(makeInnerOp());
    expect(result).toBeDefined();
    expect(result.type).toBe('feeBump');
    expect(result.feeSource).toBe(PAYMASTER_PUBLIC);
    expect(Array.isArray(result.signatures)).toBe(true);
    expect(result.signatures.length).toBeGreaterThan(0);
  });

  it('enforces the fee cap', async () => {
    await expect(
      paymaster.wrap(makeInnerOp({ fee: '999999999' })),
    ).rejects.toThrow();
  });
});

describe('paymaster.sponsor', () => {
  beforeEach(async () => {
    await loadPaymaster();
  });

  it('records and updates the sponsored transaction on success', async () => {
    const result = await paymaster.sponsor(makeInnerOp());

    expect(prisma.sponsoredTransaction.create).toHaveBeenCalledTimes(1);
    expect(prisma.sponsoredTransaction.update).toHaveBeenCalledTimes(1);
    expect(SorobanService.send).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
    expect(result.hash).toBe('deadbeef');
    expect(result.status).toBe('SUCCESS');
  });

  it('marks the transaction failed and rethrows on send failure', async () => {
    (SorobanService.send as any).mockRejectedValueOnce(new Error('boom'));

    await expect(paymaster.sponsor(makeInnerOp())).rejects.toThrow('boom');

    expect(prisma.sponsoredTransaction.create).toHaveBeenCalledTimes(1);
    expect(prisma.sponsoredTransaction.update).toHaveBeenCalledTimes(1);
    const updateArg = (prisma.sponsoredTransaction.update as any).mock
      .calls[0][0];
    expect(updateArg.data.status).toBe('FAILED');
  });
});

describe('paymaster.spentLast24h / budget enforcement', () => {
  beforeEach(async () => {
    await loadPaymaster({ PAYMASTER_DAILY_BUDGET: '1000' });
  });

  it('sums sponsored fees in the last 24h', async () => {
    (prisma.sponsoredTransaction.aggregate as any).mockResolvedValueOnce({
      _sum: { fee: 250 },
    });
    const spent = await paymaster.spentLast24h();
    expect(spent).toBe(250);
    expect(prisma.sponsoredTransaction.aggregate).toHaveBeenCalledTimes(1);
  });

  it('enforces the daily budget', async () => {
    (prisma.sponsoredTransaction.aggregate as any).mockResolvedValueOnce({
      _sum: { fee: 1000 },
    });
    await expect(paymaster.sponsor(makeInnerOp())).rejects.toThrow();
    expect(SorobanService.send).not.toHaveBeenCalled();
  });
});