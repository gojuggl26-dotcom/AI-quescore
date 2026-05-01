/**
 * Tests for X402Handler.
 *
 * The ethers Wallet (signer) is passed as a plain mock object.
 * ethers.Signature.from is mocked at the module level so signEip3009 works.
 */

jest.mock('ethers', () => ({
  ethers: {
    Signature: {
      from: jest.fn().mockReturnValue({
        v: 27,
        r: '0x' + 'aa'.repeat(32),
        s: '0x' + 'bb'.repeat(32),
      }),
    },
  },
}));

import { X402Handler, X402Error, X402PaymentRejectedError } from '../agent/x402';
import type { X402Challenge, X402Accept } from '../agent/KeeperTypes';
import type { HexString } from '../agent/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeResponse(status: number, body: unknown): Response {
  return {
    status,
    json: jest.fn().mockResolvedValue(body),
    headers: new Headers(),
  } as unknown as Response;
}

function makeMockSigner(
  address = '0x' + 'ab'.repeat(20),
  signature = '0x' + 'cd'.repeat(65),
) {
  return {
    getAddress: jest.fn().mockResolvedValue(address),
    signTypedData: jest.fn().mockResolvedValue(signature),
  };
}

const VALID_ACCEPT: X402Accept = {
  scheme:             'exact',
  network:            'ethereum-mainnet',
  maxAmountRequired:  '1000000',
  resource:           'https://keeperhub.example.com/mcp',
  description:        'KeeperHub registration fee',
  mimeType:           'application/json',
  payTo:              '0x' + 'cc'.repeat(20),
  maxTimeoutSeconds:  300,
  asset:              ('0x' + 'dd'.repeat(20)) as HexString,
};

const VALID_CHALLENGE: X402Challenge = {
  version: 1,
  accepts: [VALID_ACCEPT],
};

function makeHandler() {
  return new X402Handler(
    makeMockSigner() as unknown as import('ethers').Wallet,
    1,
    ('0x' + 'ee'.repeat(20)) as HexString,
  );
}

// ─── parseChallenge ───────────────────────────────────────────────────────────

describe('X402Handler — parseChallenge', () => {
  it('throws X402Error when response status is not 402', async () => {
    const handler = makeHandler();
    await expect(
      handler.parseChallenge(makeResponse(200, {})),
    ).rejects.toThrow(X402Error);
  });

  it('throws X402Error when body is not valid JSON', async () => {
    const resp = {
      status: 402,
      json: jest.fn().mockRejectedValue(new SyntaxError('bad json')),
    } as unknown as Response;
    const handler = makeHandler();
    await expect(handler.parseChallenge(resp)).rejects.toThrow(X402Error);
  });

  it('throws X402Error when body is not an object', async () => {
    const handler = makeHandler();
    await expect(
      handler.parseChallenge(makeResponse(402, 'just a string')),
    ).rejects.toThrow(X402Error);
  });

  it('throws X402Error when version field is missing', async () => {
    const handler = makeHandler();
    await expect(
      handler.parseChallenge(makeResponse(402, { accepts: [VALID_ACCEPT] })),
    ).rejects.toThrow(X402Error);
  });

  it('throws X402Error when accepts is missing', async () => {
    const handler = makeHandler();
    await expect(
      handler.parseChallenge(makeResponse(402, { version: 1 })),
    ).rejects.toThrow(X402Error);
  });

  it('throws X402Error when accepts is empty', async () => {
    const handler = makeHandler();
    await expect(
      handler.parseChallenge(makeResponse(402, { version: 1, accepts: [] })),
    ).rejects.toThrow(X402Error);
  });

  it('throws X402Error for unknown scheme', async () => {
    const badAccept = { ...VALID_ACCEPT, scheme: 'weird' };
    const handler = makeHandler();
    await expect(
      handler.parseChallenge(makeResponse(402, { version: 1, accepts: [badAccept] })),
    ).rejects.toThrow(X402Error);
  });

  it('throws X402Error when accepts[i] is missing required fields', async () => {
    const incomplete = { scheme: 'exact', network: 'ethereum-mainnet' }; // missing others
    const handler = makeHandler();
    await expect(
      handler.parseChallenge(makeResponse(402, { version: 1, accepts: [incomplete] })),
    ).rejects.toThrow(X402Error);
  });

  it('returns a valid X402Challenge for a well-formed 402 body', async () => {
    const handler = makeHandler();
    const challenge = await handler.parseChallenge(
      makeResponse(402, VALID_CHALLENGE),
    );
    expect(challenge.version).toBe(1);
    expect(challenge.accepts).toHaveLength(1);
    expect(challenge.accepts[0]!.scheme).toBe('exact');
    expect(challenge.accepts[0]!.network).toBe('ethereum-mainnet');
  });

  it('accepts "upto" as a valid scheme', async () => {
    const uptoAccept = { ...VALID_ACCEPT, scheme: 'upto' };
    const handler = makeHandler();
    const challenge = await handler.parseChallenge(
      makeResponse(402, { version: 1, accepts: [uptoAccept] }),
    );
    expect(challenge.accepts[0]!.scheme).toBe('upto');
  });
});

// ─── buildPaymentHeader ───────────────────────────────────────────────────────

describe('X402Handler — buildPaymentHeader', () => {
  it('returns a non-empty base64 string', async () => {
    const handler = makeHandler();
    const header = await handler.buildPaymentHeader(VALID_CHALLENGE);
    expect(typeof header).toBe('string');
    expect(header.length).toBeGreaterThan(0);
  });

  it('produces a base64-encoded JSON with scheme and network', async () => {
    const handler = makeHandler();
    const header = await handler.buildPaymentHeader(VALID_CHALLENGE);
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    expect(decoded.scheme).toBe('exact');
    expect(decoded.network).toBe('ethereum-mainnet');
    expect(decoded.payload).toBeDefined();
  });

  it('prefers "exact" scheme over "upto" when both are present', async () => {
    const challenge: X402Challenge = {
      version: 1,
      accepts: [
        { ...VALID_ACCEPT, scheme: 'upto' },
        { ...VALID_ACCEPT, scheme: 'exact' },
      ],
    };
    const handler = makeHandler();
    const header = await handler.buildPaymentHeader(challenge);
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    expect(decoded.scheme).toBe('exact');
  });

  it('falls back to first accept when no "exact" scheme exists', async () => {
    const challenge: X402Challenge = {
      version: 1,
      accepts: [{ ...VALID_ACCEPT, scheme: 'upto' }],
    };
    const handler = makeHandler();
    const header = await handler.buildPaymentHeader(challenge);
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    expect(decoded.scheme).toBe('upto');
  });

  it('throws X402Error when accepts array is empty', async () => {
    const handler = makeHandler();
    await expect(
      handler.buildPaymentHeader({ version: 1, accepts: [] }),
    ).rejects.toThrow(X402Error);
  });

  it('includes v, r, s in the payload', async () => {
    const handler = makeHandler();
    const header = await handler.buildPaymentHeader(VALID_CHALLENGE);
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    const { payload } = decoded;
    expect(typeof payload.v).toBe('number');
    expect(typeof payload.r).toBe('string');
    expect(typeof payload.s).toBe('string');
    expect(payload.nonce).toMatch(/^0x[0-9a-f]{64}$/i);
  });
});

// ─── fetchWithPayment ─────────────────────────────────────────────────────────

describe('X402Handler — fetchWithPayment', () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockFetch = jest.fn();
    (global as unknown as Record<string, unknown>).fetch = mockFetch;
  });

  it('returns response directly when first request succeeds (non-402)', async () => {
    const okResponse = makeResponse(200, { data: 'ok' });
    mockFetch.mockResolvedValueOnce(okResponse);
    const handler = makeHandler();
    const result = await handler.fetchWithPayment('https://example.com');
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries with X-PAYMENT header on 402 and returns the second response', async () => {
    const challenge402 = makeResponse(402, VALID_CHALLENGE);
    const successResponse = makeResponse(200, { done: true });
    mockFetch
      .mockResolvedValueOnce(challenge402)
      .mockResolvedValueOnce(successResponse);

    const handler = makeHandler();
    const result = await handler.fetchWithPayment('https://example.com');
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const secondCall = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(secondCall[1]?.headers).toHaveProperty('X-PAYMENT');
  });

  it('throws X402PaymentRejectedError when second response is also 402', async () => {
    const challenge402 = makeResponse(402, VALID_CHALLENGE);
    const rejected402  = makeResponse(402, VALID_CHALLENGE);
    mockFetch
      .mockResolvedValueOnce(challenge402)
      .mockResolvedValueOnce(rejected402);

    const handler = makeHandler();
    await expect(
      handler.fetchWithPayment('https://example.com'),
    ).rejects.toThrow(X402PaymentRejectedError);
  });

  it('preserves original request headers alongside X-PAYMENT', async () => {
    const challenge402 = makeResponse(402, VALID_CHALLENGE);
    const successResponse = makeResponse(200, {});
    mockFetch
      .mockResolvedValueOnce(challenge402)
      .mockResolvedValueOnce(successResponse);

    const handler = makeHandler();
    await handler.fetchWithPayment('https://example.com', {
      headers: { Authorization: 'Bearer token' },
    });

    const secondCall = mockFetch.mock.calls[1] as [string, RequestInit];
    const headers = secondCall[1]?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer token');
    expect(headers['X-PAYMENT']).toBeDefined();
  });
});

// ─── Error class shapes ───────────────────────────────────────────────────────

describe('X402 error classes', () => {
  it('X402Error has correct name and optional statusCode', () => {
    const e = new X402Error('payment needed', 402);
    expect(e.name).toBe('X402Error');
    expect(e.statusCode).toBe(402);
    expect(e).toBeInstanceOf(Error);
  });

  it('X402Error without statusCode', () => {
    const e = new X402Error('msg');
    expect(e.statusCode).toBeUndefined();
  });

  it('X402PaymentRejectedError has correct name', () => {
    const e = new X402PaymentRejectedError('rejected');
    expect(e.name).toBe('X402PaymentRejectedError');
    expect(e).toBeInstanceOf(Error);
  });
});
