/**
 * Tests for AgentStorage.
 *
 * 0G Storage SDK (Indexer, ZgFile) and ethers are mocked so tests run without
 * network access.  Private encrypt/decrypt methods are tested via round-trip
 * by casting the instance to `any`.
 */

const mockUpload   = jest.fn();
const mockDownload = jest.fn();
const mockFromBuffer = jest.fn();
const mockRootHash   = jest.fn().mockReturnValue('QmRootHashAbc');
const mockMerkleTree = jest.fn().mockResolvedValue({ rootHash: mockRootHash });

jest.mock('@0glabs/0g-ts-sdk', () => ({
  Indexer: jest.fn().mockImplementation(() => ({
    upload:   mockUpload,
    download: mockDownload,
  })),
  ZgFile: {
    fromBuffer: mockFromBuffer,
  },
}));

jest.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: jest.fn().mockReturnValue({}),
    Wallet:          jest.fn().mockReturnValue({}),
  },
}));

import {
  AgentStorage,
  StorageUploadError,
  StorageDownloadError,
  StorageParseError,
  StorageDecryptError,
} from '../agent/memory/storage';
import type { HexString, HistoricalPattern } from '../agent/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const STORAGE_URL  = 'https://storage.example.com';
const FLOW_ADDRESS = '0x' + 'ab'.repeat(20);
const PRIVATE_KEY  = ('0x' + 'cd'.repeat(32)) as HexString;
const RPC_URL      = 'https://rpc.example.com';

const VALID_PATTERN: HistoricalPattern = {
  ensNode:                  '0x' + 'aa'.repeat(32),
  respondent:               '0x' + 'bb'.repeat(20),
  avgTimeMs:                4000,
  choiceEntropy:            0.7,
  contradictionConsistency: 0.9,
  finalScore:               75,
  storedAt:                 Date.now(),
};

function makeStorage(initialIndexCid?: string): AgentStorage {
  return new AgentStorage(STORAGE_URL, FLOW_ADDRESS, PRIVATE_KEY, RPC_URL, initialIndexCid);
}

// ─── Constructor validation ───────────────────────────────────────────────────

describe('AgentStorage — constructor', () => {
  it('constructs without errors', () => {
    expect(() => makeStorage()).not.toThrow();
  });

  it('throws when storageUrl is empty', () => {
    expect(
      () => new AgentStorage('', FLOW_ADDRESS, PRIVATE_KEY, RPC_URL),
    ).toThrow('storageUrl is required');
  });

  it('throws when flowAddress is empty', () => {
    expect(
      () => new AgentStorage(STORAGE_URL, '', PRIVATE_KEY, RPC_URL),
    ).toThrow('flowAddress is required');
  });

  it('throws when privateKey is empty', () => {
    expect(
      () => new AgentStorage(STORAGE_URL, FLOW_ADDRESS, '' as HexString, RPC_URL),
    ).toThrow('privateKey is required');
  });

  it('throws when rpcUrl is empty', () => {
    expect(
      () => new AgentStorage(STORAGE_URL, FLOW_ADDRESS, PRIVATE_KEY, ''),
    ).toThrow('rpcUrl is required');
  });
});

// ─── getIndexCid ──────────────────────────────────────────────────────────────

describe('AgentStorage — getIndexCid', () => {
  it('returns null initially (no initialIndexCid provided)', () => {
    expect(makeStorage().getIndexCid()).toBeNull();
  });

  it('returns the provided initialIndexCid', () => {
    // The constructor sets indexCid and starts loading in background;
    // getIndexCid() returns it synchronously before the load completes.
    // We need to suppress the background load error for this test.
    mockDownload.mockRejectedValue(new Error('not found'));
    const storage = makeStorage('QmInitial');
    expect(storage.getIndexCid()).toBe('QmInitial');
  });
});

// ─── AES-256-GCM encrypt / decrypt round-trip ─────────────────────────────────

describe('AgentStorage — encrypt/decrypt (private, via any cast)', () => {
  it('round-trips arbitrary binary data', () => {
    const storage = makeStorage() as unknown as Record<string, (buf: Buffer) => Buffer>;
    const plaintext = Buffer.from('{"hello":"world","answer":42}', 'utf8');
    const encrypted = storage['encrypt'](plaintext);
    const decrypted = storage['decrypt'](encrypted);
    expect(decrypted.toString('utf8')).toBe('{"hello":"world","answer":42}');
  });

  it('produces different ciphertext for the same plaintext each time (random IV)', () => {
    const storage = makeStorage() as unknown as Record<string, (buf: Buffer) => Buffer>;
    const plaintext = Buffer.from('same data', 'utf8');
    const enc1 = storage['encrypt'](plaintext);
    const enc2 = storage['encrypt'](plaintext);
    expect(enc1.equals(enc2)).toBe(false);
  });

  it('both encryptions decrypt correctly to the original plaintext', () => {
    const storage = makeStorage() as unknown as Record<string, (buf: Buffer) => Buffer>;
    const plaintext = Buffer.from('consistency check', 'utf8');
    const enc1 = storage['encrypt'](plaintext);
    const enc2 = storage['encrypt'](plaintext);
    expect(storage['decrypt'](enc1).toString('utf8')).toBe('consistency check');
    expect(storage['decrypt'](enc2).toString('utf8')).toBe('consistency check');
  });

  it('throws StorageDecryptError when ciphertext is too short', () => {
    const storage = makeStorage() as unknown as Record<string, (buf: Buffer) => Buffer>;
    const tooShort = Buffer.alloc(10); // < IV(12) + TAG(16) + 1
    expect(() => storage['decrypt'](tooShort)).toThrow(StorageDecryptError);
  });

  it('throws StorageDecryptError when ciphertext is tampered (authentication fails)', () => {
    const storage = makeStorage() as unknown as Record<string, (buf: Buffer) => Buffer>;
    const plaintext = Buffer.from('tamper test', 'utf8');
    const encrypted = storage['encrypt'](plaintext);
    // Flip a byte in the ciphertext area (after IV=12 + TAG=16 = offset 28)
    encrypted[30] ^= 0xff;
    expect(() => storage['decrypt'](encrypted)).toThrow(StorageDecryptError);
  });

  it('two storages with different keys cannot decrypt each other\'s data', () => {
    const s1 = makeStorage() as unknown as Record<string, (buf: Buffer) => Buffer>;
    const s2 = new AgentStorage(STORAGE_URL, FLOW_ADDRESS, ('0x' + 'ff'.repeat(32)) as HexString, RPC_URL) as unknown as Record<string, (buf: Buffer) => Buffer>;
    const plaintext = Buffer.from('cross-key test', 'utf8');
    const encrypted = s1['encrypt'](plaintext);
    expect(() => s2['decrypt'](encrypted)).toThrow(StorageDecryptError);
  });
});

// ─── isValidIndex (private) ───────────────────────────────────────────────────

describe('AgentStorage — isValidIndex (private)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let storage: any;
  beforeEach(() => { storage = makeStorage(); });

  it('returns true for a valid PatternIndex', () => {
    expect(
      storage.isValidIndex({ version: 1, entries: {}, updatedAt: 0 }),
    ).toBe(true);
  });

  it('returns true with populated entries', () => {
    expect(
      storage.isValidIndex({
        version: 1,
        entries: { '0xabc': ['cid1', 'cid2'] },
        updatedAt: 1700000000,
      }),
    ).toBe(true);
  });

  it('returns false for non-object', () => {
    expect(storage.isValidIndex('not an object')).toBe(false);
    expect(storage.isValidIndex(null)).toBe(false);
    expect(storage.isValidIndex(42)).toBe(false);
  });

  it('returns false when version != 1', () => {
    expect(storage.isValidIndex({ version: 2, entries: {}, updatedAt: 0 })).toBe(false);
  });

  it('returns false when entries is missing', () => {
    expect(storage.isValidIndex({ version: 1, updatedAt: 0 })).toBe(false);
  });

  it('returns false when updatedAt is missing', () => {
    expect(storage.isValidIndex({ version: 1, entries: {} })).toBe(false);
  });

  it('returns false when an entry value is not a string array', () => {
    expect(
      storage.isValidIndex({ version: 1, entries: { key: [1, 2] }, updatedAt: 0 }),
    ).toBe(false);
  });
});

// ─── validatePattern (private) ────────────────────────────────────────────────

describe('AgentStorage — validatePattern (private)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let storage: any;
  beforeEach(() => { storage = makeStorage(); });

  it('does not throw for a valid pattern', () => {
    expect(() => storage.validatePattern(VALID_PATTERN)).not.toThrow();
  });

  it('throws when ensNode is missing', () => {
    expect(() =>
      storage.validatePattern({ ...VALID_PATTERN, ensNode: '' }),
    ).toThrow('ensNode');
  });

  it('throws when respondent is missing', () => {
    expect(() =>
      storage.validatePattern({ ...VALID_PATTERN, respondent: '' }),
    ).toThrow('respondent');
  });

  it('throws when avgTimeMs is Infinity', () => {
    expect(() =>
      storage.validatePattern({ ...VALID_PATTERN, avgTimeMs: Infinity }),
    ).toThrow('avgTimeMs');
  });

  it('throws when choiceEntropy < 0', () => {
    expect(() =>
      storage.validatePattern({ ...VALID_PATTERN, choiceEntropy: -0.1 }),
    ).toThrow('choiceEntropy');
  });

  it('throws when choiceEntropy > 1', () => {
    expect(() =>
      storage.validatePattern({ ...VALID_PATTERN, choiceEntropy: 1.5 }),
    ).toThrow('choiceEntropy');
  });

  it('throws when contradictionConsistency < 0', () => {
    expect(() =>
      storage.validatePattern({ ...VALID_PATTERN, contradictionConsistency: -0.1 }),
    ).toThrow('contradictionConsistency');
  });

  it('throws when finalScore > 100', () => {
    expect(() =>
      storage.validatePattern({ ...VALID_PATTERN, finalScore: 101 }),
    ).toThrow('finalScore');
  });

  it('throws when storedAt is 0 (not positive)', () => {
    expect(() =>
      storage.validatePattern({ ...VALID_PATTERN, storedAt: 0 }),
    ).toThrow('storedAt');
  });
});

// ─── validateParsedPattern (private) ─────────────────────────────────────────

describe('AgentStorage — validateParsedPattern (private)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let storage: any;
  beforeEach(() => { storage = makeStorage(); });

  it('does not throw for a valid parsed pattern', () => {
    expect(() => storage.validateParsedPattern(VALID_PATTERN, 'cid-test')).not.toThrow();
  });

  it('throws StorageParseError when parsed is not an object', () => {
    expect(() => storage.validateParsedPattern('string', 'cid')).toThrow(StorageParseError);
    expect(() => storage.validateParsedPattern(null, 'cid')).toThrow(StorageParseError);
  });

  it.each(['ensNode', 'respondent', 'avgTimeMs', 'choiceEntropy',
           'contradictionConsistency', 'finalScore', 'storedAt'])(
    'throws StorageParseError when required field "%s" is missing',
    (field) => {
      const bad = { ...VALID_PATTERN };
      delete (bad as Record<string, unknown>)[field];
      expect(() => storage.validateParsedPattern(bad, 'cid')).toThrow(StorageParseError);
    },
  );

  it('throws StorageParseError when a numeric field is a string', () => {
    const bad = { ...VALID_PATTERN, avgTimeMs: 'not-a-number' };
    expect(() => storage.validateParsedPattern(bad, 'cid')).toThrow(StorageParseError);
  });
});

// ─── savePattern (with mocked 0G) ─────────────────────────────────────────────

describe('AgentStorage — savePattern', () => {
  beforeEach(() => {
    mockFromBuffer.mockResolvedValue({ merkleTree: mockMerkleTree });
    mockUpload.mockResolvedValue(['tx-hash', null]);
  });

  it('returns patternCid and indexCid on success', async () => {
    const storage = makeStorage();
    const result = await storage.savePattern(VALID_PATTERN);
    expect(typeof result.patternCid).toBe('string');
    expect(typeof result.indexCid).toBe('string');
  });

  it('updates getIndexCid() after savePattern', async () => {
    const storage = makeStorage();
    await storage.savePattern(VALID_PATTERN);
    expect(storage.getIndexCid()).not.toBeNull();
  });

  it('throws validation error for invalid pattern (ensNode empty)', async () => {
    const storage = makeStorage();
    await expect(
      storage.savePattern({ ...VALID_PATTERN, ensNode: '' }),
    ).rejects.toThrow('ensNode');
  });

  it('throws StorageUploadError when ZgFile.fromBuffer fails', async () => {
    mockFromBuffer.mockRejectedValueOnce(new Error('file creation failed'));
    const storage = makeStorage();
    await expect(storage.savePattern(VALID_PATTERN)).rejects.toThrow(StorageUploadError);
  });

  it('throws StorageUploadError when indexer.upload returns an error', async () => {
    mockUpload.mockResolvedValueOnce([null, 'upload failed']);
    const storage = makeStorage();
    await expect(storage.savePattern(VALID_PATTERN)).rejects.toThrow(StorageUploadError);
  });
});

// ─── loadPattern (with mocked 0G) ─────────────────────────────────────────────

describe('AgentStorage — loadPattern', () => {
  it('throws StorageDownloadError when cid is empty', async () => {
    const storage = makeStorage();
    await expect(storage.loadPattern('')).rejects.toThrow(StorageDownloadError);
  });

  it('throws StorageDownloadError when indexer.download fails', async () => {
    mockDownload.mockRejectedValueOnce(new Error('network error'));
    const storage = makeStorage();
    await expect(storage.loadPattern('QmSomeCid')).rejects.toThrow(StorageDownloadError);
  });

  it('throws StorageDecryptError when downloaded bytes are too short', async () => {
    mockDownload.mockResolvedValueOnce(new Uint8Array(5)); // too short
    const storage = makeStorage();
    await expect(storage.loadPattern('QmSomeCid')).rejects.toThrow(StorageDecryptError);
  });

  it('throws StorageParseError when decrypted bytes are not valid JSON', async () => {
    // Encrypt something that is not JSON
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const storage = makeStorage() as any;
    const encrypted = storage.encrypt(Buffer.from('not json!!!', 'utf8'));
    mockDownload.mockResolvedValueOnce(new Uint8Array(encrypted));
    await expect(storage.loadPattern('QmSomeCid')).rejects.toThrow(StorageParseError);
  });

  it('round-trips a valid pattern through save → load', async () => {
    // We do this by encrypting the pattern manually and returning it from download
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const storage = makeStorage() as any;
    const plaintext = Buffer.from(JSON.stringify(VALID_PATTERN), 'utf8');
    const encrypted = storage.encrypt(plaintext);
    mockDownload.mockResolvedValueOnce(new Uint8Array(encrypted));

    const loaded = await (storage as AgentStorage).loadPattern('QmRoundTrip');
    expect(loaded.ensNode).toBe(VALID_PATTERN.ensNode);
    expect(loaded.respondent).toBe(VALID_PATTERN.respondent);
    expect(loaded.finalScore).toBe(VALID_PATTERN.finalScore);
  });
});

// ─── uploadRaw ────────────────────────────────────────────────────────────────

describe('AgentStorage — uploadRaw', () => {
  beforeEach(() => {
    mockFromBuffer.mockResolvedValue({ merkleTree: mockMerkleTree });
    mockUpload.mockResolvedValue(['tx-hash', null]);
  });

  it('throws StorageUploadError for empty buffer', async () => {
    const storage = makeStorage();
    await expect(
      storage.uploadRaw(Buffer.alloc(0), 'empty.dat'),
    ).rejects.toThrow(StorageUploadError);
  });

  it('throws StorageUploadError for empty filename', async () => {
    const storage = makeStorage();
    await expect(
      storage.uploadRaw(Buffer.from('data'), ''),
    ).rejects.toThrow(StorageUploadError);
  });

  it('returns a CID string on success', async () => {
    const storage = makeStorage();
    const cid = await storage.uploadRaw(Buffer.from('test data'), 'test.dat');
    expect(typeof cid).toBe('string');
    expect(cid.length).toBeGreaterThan(0);
  });
});

// ─── Error class shapes ───────────────────────────────────────────────────────

describe('AgentStorage error classes', () => {
  it('StorageUploadError has correct name and cause', () => {
    const cause = new Error('root');
    const e = new StorageUploadError('upload failed', cause);
    expect(e.name).toBe('StorageUploadError');
    expect(e.cause).toBe(cause);
    expect(e).toBeInstanceOf(Error);
  });

  it('StorageDownloadError has correct name', () => {
    const e = new StorageDownloadError('download failed');
    expect(e.name).toBe('StorageDownloadError');
  });

  it('StorageParseError has correct name', () => {
    const e = new StorageParseError('parse failed');
    expect(e.name).toBe('StorageParseError');
  });

  it('StorageDecryptError has correct name', () => {
    const e = new StorageDecryptError('decrypt failed');
    expect(e.name).toBe('StorageDecryptError');
  });
});
