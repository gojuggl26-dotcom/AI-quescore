import { Indexer, ZgFile } from '@0glabs/0g-ts-sdk';
import { ethers } from 'ethers';

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'crypto';
import type { HexString, HistoricalPattern } from '../types';

const CIPHER_ALGO = `aes-256-gcm` as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MIN_CIPHER_LEN = IV_BYTES + TAG_BYTES + 1;
const KDF_SALT = Buffer.from(`surveychain-agent-pattern-store-v1`, `utf8`);
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

interface PatternIndex {
    version: 1;
    entries: Record<string, string[]>;
    updatedAt: number;
}

export class StorageUploadError extends Error {
    constructor(message: string, public override readonly cause?: unknown) {
        super(message);
        this.name = `StorageUploadError`;
    }
}

export class StorageDownloadError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'StorageDownloadError';
  }
}

export class StorageParseError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'StorageParseError';
  }
}

export class StorageDecryptError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'StorageDecryptError';
  }
}


export class AgentStorage {
    private readonly indexer: Indexer;
  private readonly flowAddress: string;
  private readonly signer: ethers.Wallet;
  private readonly encKey: Buffer;

  private index: PatternIndex = { version: 1, entries: {}, updatedAt: 0 };
  private indexCid: string | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    storageUrl: string,
    flowAddress: string,
    privateKey: HexString,
    rpcUrl: string,
    initialIndexCID?: string,
  ) {
    if (!storageUrl) throw new Error('AgentStorage: storageUrl is required');
    if (!flowAddress) throw new Error('AgentStorage: flowAddress is required');
    if (!privateKey) throw new Error('AgentStorage: privateKey is required');
    if (!rpcUrl) throw new Error('AgentStorage: rpcUrl is required');

    this.indexer = new Indexer(storageUrl);
    this.flowAddress = flowAddress;
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    this.signer = new ethers.Wallet(privateKey, provider);

    const keyMaterial = privateKey.startsWith('0x')
      ? privateKey.slice(2)
      : privateKey;
    this.encKey = scryptSync(keyMaterial, KDF_SALT, KEY_BYTES, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });

    if (initialIndexCid) {
      this.indexCid = initialIndexCid;
      this.initPromise = this.loadIndex(initialIndexCid);
    }
  }

  getIndexCid(): string | null {
    return this.indexCid;
  }

  async savePattern(
    pattern: HistoricalPattern,
  ): Promise<{ patternCid: string; indexCid: string}> {
    await this.ensureInit();
    this.validatePattern(pattern);

    const respondentKey = pattern.respondent.toLowerCase();
    const plaintext = Buffer.from(JSON.stringify(pattern), 'utf8');
    const filename = `pattern_${respondentKey}_${pattern.storedAt}.json.enc`;
    const patternCid = await this.uploadEncrypted(plaintext, filename);

    if (!this.index.entries[respondentKey]) {
      this.index.entries[respondentKey] = [];
    }
    this.index.entries[respondentKey]!.push(patternCid);
    this.index.updatedAt = Date.now();

    const newIndexCid = await this.flushIndex();
    this.indexCid = newIndexCid;

    return { patternCid, indexCid: newIndexCid };
  }

  async loadHistory(respondent: string): Promise<HistoricalPattern[]> {
    await this.ensureInit();

    const key = respondent.toLowerCase();
    const cids = this.index.entries[key];
    if (!cids || cids.length === 0) return [];

    const results = await Promise.allSettled(cids.map((cid) => this.loadPattern(cid)));

    const patterns: HistoricalPattern[] = [];
    // Use for-of so TypeScript correctly narrows each element from
    // PromiseSettledResult<T> to PromiseFulfilledResult<T> | PromiseRejectedResult.
    for (const [idx, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        patterns.push(result.value);
      } else {
        const cid = cids[idx] ?? '(unknown)';
        console.warn(
          `[AgentStorage] Failed to load pattern cid=${cid} ` +
            `for respondent=${respondent}: ${String(result.reason)}`,
        );
      }
    }

    patterns.sort((a, b) => a.storedAt - b.storedAt);
    return patterns;
  }

  async loadPattern(cid: string): Promise<HistoricalPattern> {
    if (!cid || cid.trim() === '') {
      throw new StorageDownloadError('loadPattern: cid must not be empty');
    }

    const plaintext = await this.downloadDecrypted(cid);

    let raw: string;
    try {
      raw = plaintext.toString('utf8');
    } catch (err) {
      throw new StorageParseError(
        `Failed to decode bytes to UTF-8 for cid=${cid}: ${String(err)}`,
        err,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new StorageParseError(`Invalid JSON for cid=${cid}: ${String(err)}`, err);
    }

    this.validateParsedPattern(parsed, cid);
    return parsed as HistoricalPattern;
  }

  /**
   * Encrypts arbitrary binary data and uploads it to 0G Storage.
   * Returns the Merkle root hash (CID) anchored on-chain.
   */
  async uploadRaw(data: Buffer, filename: string): Promise<string> {
    if (!data || data.length === 0) {
      throw new StorageUploadError(`uploadRaw: buffer is empty (file=${filename})`);
    }
    if (!filename || filename.trim() === '') {
      throw new StorageUploadError('uploadRaw: filename must not be empty');
    }
    return this.uploadEncrypted(data, filename);
  }

  // ─── AES-256-GCM helpers ──────────────────────────────────────────────────────

  private encrypt(plaintext: Buffer): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(CIPHER_ALGO, this.encKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Wire format: IV (12 B) | AUTH_TAG (16 B) | CIPHERTEXT
    return Buffer.concat([iv, tag, ciphertext]);
  }

  private decrypt(data: Buffer): Buffer {
    if (data.length < MIN_CIPHER_LEN) {
      throw new StorageDecryptError(
        `Encrypted payload too short: ${data.length} bytes ` +
          `(minimum ${MIN_CIPHER_LEN})`,
      );
    }
    const iv = data.subarray(0, IV_BYTES);
    const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = data.subarray(IV_BYTES + TAG_BYTES);

    try {
      const decipher = createDecipheriv(CIPHER_ALGO, this.encKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (err) {
      throw new StorageDecryptError(
        `AES-GCM authentication failed — data may be corrupted or the ` +
          `encryption key does not match: ${String(err)}`,
        err,
      );
    }
  }

  // ─── 0G Storage helpers ───────────────────────────────────────────────────────

  private async uploadEncrypted(plaintext: Buffer, filename: string): Promise<string> {
    const cipherBuf = this.encrypt(plaintext);

    let zgFile: ZgFile;
    try {
      zgFile = await ZgFile.fromBuffer(cipherBuf, filename);
    } catch (err) {
      throw new StorageUploadError(
        `Failed to create ZgFile for file=${filename}: ${String(err)}`,
        err,
      );
    }

    let merkleTree: Awaited<ReturnType<ZgFile['merkleTree']>>;
    try {
      merkleTree = await zgFile.merkleTree();
    } catch (err) {
      throw new StorageUploadError(
        `Failed to compute Merkle tree for file=${filename}: ${String(err)}`,
        err,
      );
    }

    if (!merkleTree) {
      throw new StorageUploadError(`Merkle tree is null for file=${filename}`);
    }

    const rootHash = merkleTree.rootHash();
    if (!rootHash || rootHash.trim() === '') {
      throw new StorageUploadError(
        `Merkle tree returned empty rootHash for file=${filename}`,
      );
    }

    try {
      const [tx, uploadErr] = await this.indexer.upload(
        zgFile,
        this.flowAddress,
        this.signer,
      );
      if (uploadErr !== null && uploadErr !== undefined) {
        throw new StorageUploadError(
          `0G Storage upload error for file=${filename}: ${String(uploadErr)}`,
          uploadErr,
        );
      }
      if (!tx) {
        throw new StorageUploadError(
          `0G Storage upload returned no transaction for file=${filename}`,
        );
      }
    } catch (err) {
      if (err instanceof StorageUploadError) throw err;
      throw new StorageUploadError(
        `Unexpected upload error for file=${filename}: ${String(err)}`,
        err,
      );
    }

    return rootHash;
  }

   private async downloadDecrypted(cid: string): Promise<Buffer> {
    let raw: Uint8Array;
    try {
      raw = await this.indexer.download(cid, this.flowAddress);
    } catch (err) {
      throw new StorageDownloadError(
        `Failed to download cid=${cid}: ${String(err)}`,
        err,
      );
    }

    if (!raw || raw.length === 0) {
      throw new StorageDownloadError(
        `Downloaded empty payload for cid=${cid}`,
      );
    }

    return this.decrypt(Buffer.from(raw));
  }

  private async ensureInit(): Promise<void> {
    if (this.initPromise !== null) await this.initPromise;
  }

  private async loadIndex(cid: string): Promise<void> {
    let plaintext: Buffer;
    try {
      plaintext = await this.downloadDecrypted(cid);
    } catch (err) {
      console.warn(
        `[AgentStorage] Cannot load pattern index from cid=${cid} — ` +
          `starting with an empty index. Cause: ${String(err)}`,
      );
      this.index = { version: 1, entries: {}, updatedAt: 0 };
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext.toString('utf8'));
    } catch (err) {
      console.warn(
        `[AgentStorage] Pattern index at cid=${cid} is not valid JSON — ` +
          `starting with an empty index. Cause: ${String(err)}`,
      );
      this.index = { version: 1, entries: {}, updatedAt: 0 };
      return;
    }

    if (!this.isValidIndex(parsed)) {
      console.warn(
        `[AgentStorage] Pattern index at cid=${cid} has an unexpected ` +
          `schema — starting with an empty index.`,
      );
      this.index = { version: 1, entries: {}, updatedAt: 0 };
      return;
    }

    this.index = parsed;
  }

  private async flushIndex(): Promise<string> {
    const plaintext = Buffer.from(JSON.stringify(this.index), 'utf8');
    const filename = `pattern_index_v1_${this.index.updatedAt}.json.enc`;

    try {
      return await this.uploadEncrypted(plaintext, filename);
    } catch (err) {
      throw new StorageUploadError(
        `Failed to upload pattern index (updatedAt=${this.index.updatedAt}): ${String(err)}`,
        err,
      );
    }
  }

  private isValidIndex(val: unknown): val is PatternIndex {
    if (typeof val !== 'object' || val === null) return false;
    const obj = val as Record<string, unknown>;
    if (obj['version'] !== 1) return false;
    if (typeof obj['entries'] !== 'object' || obj['entries'] === null) return false;
    if (typeof obj['updatedAt'] !== 'number') return false;
    const entries = obj['entries'] as Record<string, unknown>;
    for (const [k, v] of Object.entries(entries)) {
      if (typeof k !== 'string') return false;
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return false;
    }
    return true;
  }

  private validatePattern(pattern: HistoricalPattern): void {
    if (!pattern) throw new Error('savePattern: pattern is null');
    if (!pattern.ensNode) throw new Error('savePattern: ensNode is missing');
    if (!pattern.respondent) throw new Error('savePattern: respondent is missing');
    if (typeof pattern.avgTimeMs !== 'number' || !Number.isFinite(pattern.avgTimeMs)) {
      throw new Error('savePattern: avgTimeMs must be a finite number');
    }
    if (
      typeof pattern.choiceEntropy !== 'number' ||
      !Number.isFinite(pattern.choiceEntropy) ||
      pattern.choiceEntropy < 0 ||
      pattern.choiceEntropy > 1
    ) {
      throw new Error('savePattern: choiceEntropy must be in [0, 1]');
    }
    if (
      typeof pattern.contradictionConsistency !== 'number' ||
      !Number.isFinite(pattern.contradictionConsistency) ||
      pattern.contradictionConsistency < 0 ||
      pattern.contradictionConsistency > 1
    ) {
      throw new Error('savePattern: contradictionConsistency must be in [0, 1]');
    }
    if (
      typeof pattern.finalScore !== 'number' ||
      !Number.isFinite(pattern.finalScore) ||
      pattern.finalScore < 0 ||
      pattern.finalScore > 100
    ) {
      throw new Error('savePattern: finalScore must be in [0, 100]');
    }
    if (typeof pattern.storedAt !== 'number' || pattern.storedAt <= 0) {
      throw new Error('savePattern: storedAt must be a positive unix timestamp (ms)');
    }
  }

  private validateParsedPattern(parsed: unknown, cid: string): void {
    if (typeof parsed !== 'object' || parsed === null) {
      throw new StorageParseError(
        `Expected object, got ${typeof parsed} for cid=${cid}`,
      );
    }
    const p = parsed as Record<string, unknown>;
    const required: Array<keyof HistoricalPattern> = [
      'ensNode',
      'respondent',
      'avgTimeMs',
      'choiceEntropy',
      'contradictionConsistency',
      'finalScore',
      'storedAt',
    ];
    for (const key of required) {
      if (!(key in p)) {
        throw new StorageParseError(
          `Pattern missing required field "${key}" for cid=${cid}`,
        );
      }
    }
    const numFields: Array<keyof HistoricalPattern> = [
      'avgTimeMs',
      'choiceEntropy',
      'contradictionConsistency',
      'finalScore',
      'storedAt',
    ];
    for (const key of numFields) {
      if (typeof p[key] !== 'number') {
        throw new StorageParseError(
          `Field "${key}" must be a number for cid=${cid}, got ${typeof p[key]}`,
        );
      }
    }
  }
}