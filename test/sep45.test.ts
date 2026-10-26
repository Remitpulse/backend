import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/http', () => ({
  requestJson: vi.fn(),
}));

vi.mock('../src/interfaces/anchors/toml', () => ({
  getAnchorToml: vi.fn(),
}));

vi.mock('../src/interfaces/soroban/service', () => ({
  SorobanService: vi.fn().mockImplementation(() => ({
    validUntilLedger: vi.fn(),
    authPayload: vi.fn(),
    attachSignature: vi.fn(),
  })),
}));

import { requestJson } from '../src/utils/http';
import { getAnchorToml } from '../src/interfaces/anchors/toml';
import { SorobanService } from '../src/interfaces/soroban/service';
import {
  getSep45ContractId,
  supportsSep45,
  getTokenExpiry,
  extractAuthorizationEntry,
  authenticateWithAnchorSep45,
} from '../src/interfaces/anchors/sep45';

const mockedRequestJson = vi.mocked(requestJson);
const mockedGetAnchorToml = vi.mocked(getAnchorToml);
const MockedSorobanService = vi.mocked(SorobanService);

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
    'base64url',
  );
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

describe('SEP-45', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSep45ContractId', () => {
    it('returns the webAuthContractId when present', () => {
      const toml = { WEB_AUTH_CONTRACT_ID: 'CABC123' } as any;
      expect(getSep45ContractId(toml)).toBe('CABC123');
    });

    it('returns undefined when webAuthContractId is absent', () => {
      const toml = {} as any;
      expect(getSep45ContractId(toml)).toBeUndefined();
    });
  });

  describe('supportsSep45', () => {
    it('returns true when webAuthContractId is present', () => {
      const toml = { WEB_AUTH_CONTRACT_ID: 'CABC123' } as any;
      expect(supportsSep45(toml)).toBe(true);
    });

    it('returns false when webAuthContractId is absent', () => {
      const toml = {} as any;
      expect(supportsSep45(toml)).toBe(false);
    });
  });

  describe('getTokenExpiry', () => {
    it('returns the exp claim for a valid JWT', () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const token = makeJwt({ exp });
      expect(getTokenExpiry(token)).toBe(exp);
    });

    it('returns null for a malformed JWT', () => {
      expect(getTokenExpiry('not-a-jwt')).toBeNull();
    });

    it('returns null when the payload is not valid JSON', () => {
      const token = 'aGVhZGVy.bm90LWpzb24.sig';
      expect(getTokenExpiry(token)).toBeNull();
    });

    it('returns null when exp claim is missing', () => {
      const token = makeJwt({ sub: 'abc' });
      expect(getTokenExpiry(token)).toBeNull();
    });
  });

  describe('extractAuthorizationEntry', () => {
    it('extracts the authorization entry from a successful response', () => {
      const entry = { credentials: 'xdr', signature: 'sig' };
      const response = { authorization_entry: entry } as any;
      expect(extractAuthorizationEntry(response)).toEqual(entry);
    });

    it('throws when the authorization entry is missing', () => {
      const response = {} as any;
      expect(() => extractAuthorizationEntry(response)).toThrow();
    });
  });

  describe('authenticateWithAnchorSep45', () => {
    const anchorUrl = 'https://anchor.example.com';
    const account = 'GACCOUNT';
    const signer = vi.fn();

    it('authenticates successfully when the anchor advertises SEP-45', async () => {
      mockedGetAnchorToml.mockResolvedValue({
        WEB_AUTH_CONTRACT_ID: 'CABC123',
      } as any);

      const validUntilLedger = vi.fn().mockResolvedValue(12345);
      const authPayload = vi.fn().mockResolvedValue({ payload: 'xdr' });
      const attachSignature = vi.fn().mockResolvedValue({ signed: 'xdr' });

      MockedSorobanService.mockImplementation(() => ({
        validUntilLedger,
        authPayload,
        attachSignature,
      }) as any);

      mockedRequestJson
        .mockResolvedValueOnce({ challenge: 'challenge-xdr' } as any)
        .mockResolvedValueOnce({ token: 'jwt-token' } as any);

      const result = await authenticateWithAnchorSep45({
        anchorUrl,
        account,
        signer,
      } as any);

      expect(result).toBe('jwt-token');
      expect(mockedRequestJson).toHaveBeenCalledTimes(2);
    });

    it('throws when the anchor does not advertise SEP-45', async () => {
      mockedGetAnchorToml.mockResolvedValue({} as any);

      await expect(
        authenticateWithAnchorSep45({
          anchorUrl,
          account,
          signer,
        } as any),
      ).rejects.toThrow();
    });

    it('throws when the response is missing a token', async () => {
      mockedGetAnchorToml.mockResolvedValue({
        WEB_AUTH_CONTRACT_ID: 'CABC123',
      } as any);

      const validUntilLedger = vi.fn().mockResolvedValue(12345);
      const authPayload = vi.fn().mockResolvedValue({ payload: 'xdr' });
      const attachSignature = vi.fn().mockResolvedValue({ signed: 'xdr' });

      MockedSorobanService.mockImplementation(() => ({
        validUntilLedger,
        authPayload,
        attachSignature,
      }) as any);

      mockedRequestJson
        .mockResolvedValueOnce({ challenge: 'challenge-xdr' } as any)
        .mockResolvedValueOnce({} as any);

      await expect(
        authenticateWithAnchorSep45({
          anchorUrl,
          account,
          signer,
        } as any),
      ).rejects.toThrow();
    });
  });
});