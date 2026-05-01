/**
 * Tests for ComputeClient.
 *
 * ZGComputeNetworkBroker and ethers are mocked.
 * We access the broker's inference mock via (client as any).broker
 * to control per-test responses.
 */

jest.mock('@0glabs/0g-ts-sdk', () => ({
  ZGComputeNetworkBroker: jest.fn().mockImplementation(() => ({
    inference: {
      requestWithAttestation: jest.fn(),
    },
  })),
}));

jest.mock('ethers', () => ({
  JsonRpcProvider: jest.fn().mockReturnValue({}),
  Wallet:          jest.fn().mockReturnValue({}),
}));

import {
  ComputeClient,
  ComputeRequestError,
  AttestationValidationError,
  ModelHashMismatchError,
} from '../agent/inference/compute';
import type { InferenceFeatures } from '../agent/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const EXPECTED_MODEL_HASH    = 'expected-model-hash';
const EXPECTED_NODE_PUBKEY   = 'expected-node-pubkey';
const PRIMARY_MODEL          = 'primary-model';
const FALLBACK_MODEL         = 'fallback-model';

const VALID_ATTESTATION = ('0x' + 'ab'.repeat(65)) as `0x${string}`;

const VALID_FEATURES: InferenceFeatures = {
  timeDeltas:               [3000, 5000],
  avgTimeMs:                4000,
  cvTime:                   0.4,
  choiceEntropy:            0.7,
  contradictionConsistency: 1.0,
  contradictionPairCount:   1,
  textLengths:              [50],
  textCharDiversity:        [0.6],
  questionCount:            3,
  choiceQuestionCount:      2,
  textQuestionCount:        1,
};

const VALID_TEE_RESPONSE = {
  score:          75,
  attestation:    VALID_ATTESTATION,
  modelHash:      EXPECTED_MODEL_HASH,
  nodePublicKey:  EXPECTED_NODE_PUBKEY,
};

function makeClient() {
  return new ComputeClient(
    'https://compute.example.com',
    ('0x' + 'ab'.repeat(32)) as `0x${string}`,
    'https://rpc.example.com',
    PRIMARY_MODEL,
    FALLBACK_MODEL,
    EXPECTED_MODEL_HASH,
    EXPECTED_NODE_PUBKEY,
  );
}

function getBrokerMock(client: ComputeClient) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (client as any).broker.inference.requestWithAttestation as jest.Mock;
}

// ─── Constructor validation ───────────────────────────────────────────────────

describe('ComputeClient — constructor', () => {
  it('constructs with valid arguments', () => {
    expect(() => makeClient()).not.toThrow();
  });

  const cases: Array<[string, Parameters<typeof ComputeClient['prototype']['runQualityScoring']>[0] | string]> = [];

  it.each([
    ['computeUrl',           ['', '0xkey', 'http://rpc', 'pm', 'fm', 'hash', 'pk']],
    ['privateKey',           ['http://c', '',    'http://rpc', 'pm', 'fm', 'hash', 'pk']],
    ['rpcUrl',               ['http://c', '0xkey', '',           'pm', 'fm', 'hash', 'pk']],
    ['primaryModel',         ['http://c', '0xkey', 'http://rpc', '',   'fm', 'hash', 'pk']],
    ['fallbackModel',        ['http://c', '0xkey', 'http://rpc', 'pm', '',   'hash', 'pk']],
    ['expectedModelHash',    ['http://c', '0xkey', 'http://rpc', 'pm', 'fm', '',     'pk']],
    ['expectedNodePublicKey',['http://c', '0xkey', 'http://rpc', 'pm', 'fm', 'hash', ''  ]],
  ] as [string, ConstructorParameters<typeof ComputeClient>][])(
    'throws when %s is empty',
    (_, args) => {
      expect(() => new ComputeClient(...args)).toThrow(
        new RegExp(`${args[0] || args[1] || 'required'}`, 'i'),
      );
    },
  );
});

// ─── Feature validation ───────────────────────────────────────────────────────

describe('ComputeClient — feature validation (via runQualityScoring)', () => {
  it('throws for null features', async () => {
    const client = makeClient();
    await expect(
      client.runQualityScoring(null as unknown as InferenceFeatures),
    ).rejects.toThrow();
  });

  it('throws when timeDeltas is not an array', async () => {
    const client = makeClient();
    await expect(
      client.runQualityScoring({ ...VALID_FEATURES, timeDeltas: null as unknown as number[] }),
    ).rejects.toThrow('timeDeltas must be an array');
  });

  it('throws when avgTimeMs is negative', async () => {
    const client = makeClient();
    await expect(
      client.runQualityScoring({ ...VALID_FEATURES, avgTimeMs: -1 }),
    ).rejects.toThrow('avgTimeMs');
  });

  it('throws when cvTime is negative', async () => {
    const client = makeClient();
    await expect(
      client.runQualityScoring({ ...VALID_FEATURES, cvTime: -0.1 }),
    ).rejects.toThrow('cvTime');
  });

  it('throws when choiceEntropy > 1', async () => {
    const client = makeClient();
    await expect(
      client.runQualityScoring({ ...VALID_FEATURES, choiceEntropy: 1.5 }),
    ).rejects.toThrow('choiceEntropy');
  });

  it('throws when contradictionConsistency < 0', async () => {
    const client = makeClient();
    await expect(
      client.runQualityScoring({ ...VALID_FEATURES, contradictionConsistency: -0.1 }),
    ).rejects.toThrow('contradictionConsistency');
  });

  it('throws when contradictionPairCount is negative', async () => {
    const client = makeClient();
    await expect(
      client.runQualityScoring({ ...VALID_FEATURES, contradictionPairCount: -1 }),
    ).rejects.toThrow('contradictionPairCount');
  });

  it('throws when textLengths and textCharDiversity have different lengths', async () => {
    const client = makeClient();
    await expect(
      client.runQualityScoring({
        ...VALID_FEATURES,
        textLengths:       [10, 20],
        textCharDiversity: [0.5],
      }),
    ).rejects.toThrow('textLengths and textCharDiversity');
  });

  it('throws when questionCount is 0', async () => {
    const client = makeClient();
    await expect(
      client.runQualityScoring({ ...VALID_FEATURES, questionCount: 0 }),
    ).rejects.toThrow('questionCount');
  });

  it('throws when choiceQuestionCount + textQuestionCount > questionCount', async () => {
    const client = makeClient();
    await expect(
      client.runQualityScoring({
        ...VALID_FEATURES,
        questionCount:      2,
        choiceQuestionCount: 2,
        textQuestionCount:  1, // 2+1 > 2
      }),
    ).rejects.toThrow('choiceQuestionCount + textQuestionCount');
  });

  it('throws for invalid historicalContext.patternCount', async () => {
    const client = makeClient();
    await expect(
      client.runQualityScoring({
        ...VALID_FEATURES,
        historicalContext: {
          patternCount:                0, // must be > 0
          avgFinalScore:               70,
          avgTimeMs:                   4000,
          avgChoiceEntropy:            0.7,
          avgContradictionConsistency: 0.9,
          latestStoredAt:              1700000000,
        },
      }),
    ).rejects.toThrow('patternCount');
  });

  it('throws for historicalContext.avgFinalScore > 100', async () => {
    const client = makeClient();
    await expect(
      client.runQualityScoring({
        ...VALID_FEATURES,
        historicalContext: {
          patternCount:                1,
          avgFinalScore:               150, // > 100
          avgTimeMs:                   4000,
          avgChoiceEntropy:            0.7,
          avgContradictionConsistency: 0.9,
          latestStoredAt:              1700000000,
        },
      }),
    ).rejects.toThrow('avgFinalScore');
  });
});

// ─── runQualityScoring — model response parsing ───────────────────────────────

describe('ComputeClient — runQualityScoring model response handling', () => {
  it('returns SealedInferenceResult on success', async () => {
    const client = makeClient();
    getBrokerMock(client).mockResolvedValueOnce(VALID_TEE_RESPONSE);
    const result = await client.runQualityScoring(VALID_FEATURES);
    expect(result.score).toBe(75);
    expect(result.attestation).toBe(VALID_ATTESTATION);
    expect(result.modelHash).toBe(EXPECTED_MODEL_HASH);
    expect(result.nodePublicKey).toBe(EXPECTED_NODE_PUBKEY);
  });

  it('accepts score as a string ("75")', async () => {
    const client = makeClient();
    getBrokerMock(client).mockResolvedValueOnce({
      ...VALID_TEE_RESPONSE,
      score: '75',
    });
    const result = await client.runQualityScoring(VALID_FEATURES);
    expect(result.score).toBe(75);
  });

  it('accepts "quality_score" as an alias for "score"', async () => {
    const client = makeClient();
    getBrokerMock(client).mockResolvedValueOnce({
      quality_score:  80,
      attestation:    VALID_ATTESTATION,
      modelHash:      EXPECTED_MODEL_HASH,
      nodePublicKey:  EXPECTED_NODE_PUBKEY,
    });
    const result = await client.runQualityScoring(VALID_FEATURES);
    expect(result.score).toBe(80);
  });

  it('accepts "model_hash" as an alias for "modelHash"', async () => {
    const client = makeClient();
    getBrokerMock(client).mockResolvedValueOnce({
      score:          70,
      attestation:    VALID_ATTESTATION,
      model_hash:     EXPECTED_MODEL_HASH,
      nodePublicKey:  EXPECTED_NODE_PUBKEY,
    });
    const result = await client.runQualityScoring(VALID_FEATURES);
    expect(result.modelHash).toBe(EXPECTED_MODEL_HASH);
  });

  it('throws ComputeRequestError when score is missing', async () => {
    const client = makeClient();
    getBrokerMock(client).mockResolvedValueOnce({
      attestation:   VALID_ATTESTATION,
      modelHash:     EXPECTED_MODEL_HASH,
      nodePublicKey: EXPECTED_NODE_PUBKEY,
    });
    await expect(client.runQualityScoring(VALID_FEATURES)).rejects.toThrow(
      ComputeRequestError,
    );
  });

  it('throws ComputeRequestError when score is out of range (> 100)', async () => {
    const client = makeClient();
    getBrokerMock(client).mockResolvedValueOnce({
      ...VALID_TEE_RESPONSE,
      score: 150,
    });
    await expect(client.runQualityScoring(VALID_FEATURES)).rejects.toThrow(
      ComputeRequestError,
    );
  });

  it('throws ComputeRequestError when attestation is missing', async () => {
    const client = makeClient();
    getBrokerMock(client).mockResolvedValueOnce({
      score:         75,
      modelHash:     EXPECTED_MODEL_HASH,
      nodePublicKey: EXPECTED_NODE_PUBKEY,
    });
    await expect(client.runQualityScoring(VALID_FEATURES)).rejects.toThrow(
      ComputeRequestError,
    );
  });

  it('throws AttestationValidationError when attestation has wrong length', async () => {
    const client = makeClient();
    getBrokerMock(client).mockResolvedValueOnce({
      ...VALID_TEE_RESPONSE,
      attestation: '0x1234', // too short
    });
    await expect(client.runQualityScoring(VALID_FEATURES)).rejects.toThrow(
      AttestationValidationError,
    );
  });

  it('throws AttestationValidationError when attestation lacks 0x prefix', async () => {
    const client = makeClient();
    getBrokerMock(client).mockResolvedValueOnce({
      ...VALID_TEE_RESPONSE,
      attestation: 'ab'.repeat(65), // no 0x prefix, 130 chars
    });
    await expect(client.runQualityScoring(VALID_FEATURES)).rejects.toThrow(
      AttestationValidationError,
    );
  });

  it('throws ModelHashMismatchError when modelHash does not match expected', async () => {
    const client = makeClient();
    getBrokerMock(client).mockResolvedValueOnce({
      ...VALID_TEE_RESPONSE,
      modelHash: 'wrong-hash',
    });
    await expect(client.runQualityScoring(VALID_FEATURES)).rejects.toThrow(
      ModelHashMismatchError,
    );
  });

  it('throws AttestationValidationError when nodePublicKey does not match', async () => {
    const client = makeClient();
    getBrokerMock(client).mockResolvedValueOnce({
      ...VALID_TEE_RESPONSE,
      nodePublicKey: 'wrong-pubkey',
    });
    await expect(client.runQualityScoring(VALID_FEATURES)).rejects.toThrow(
      AttestationValidationError,
    );
  });

  it('falls back to fallbackModel when primary fails', async () => {
    const client = makeClient();
    const mock = getBrokerMock(client);
    mock
      .mockRejectedValueOnce(new Error('primary down'))
      .mockResolvedValueOnce(VALID_TEE_RESPONSE);
    const result = await client.runQualityScoring(VALID_FEATURES);
    expect(result.score).toBe(75);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('throws ComputeRequestError when both primary and fallback fail', async () => {
    const client = makeClient();
    const mock = getBrokerMock(client);
    mock
      .mockRejectedValueOnce(new Error('primary down'))
      .mockRejectedValueOnce(new Error('fallback down'));
    await expect(client.runQualityScoring(VALID_FEATURES)).rejects.toThrow(
      ComputeRequestError,
    );
  });

  it('throws ComputeRequestError when response is not an object', async () => {
    const client = makeClient();
    getBrokerMock(client).mockResolvedValueOnce('just a string');
    await expect(client.runQualityScoring(VALID_FEATURES)).rejects.toThrow(
      ComputeRequestError,
    );
  });

  it('throws ComputeRequestError when response is null', async () => {
    const client = makeClient();
    getBrokerMock(client).mockResolvedValueOnce(null);
    await expect(client.runQualityScoring(VALID_FEATURES)).rejects.toThrow(
      ComputeRequestError,
    );
  });
});

// ─── Error class shapes ───────────────────────────────────────────────────────

describe('ComputeClient error classes', () => {
  it('ComputeRequestError has correct name and optional cause', () => {
    const cause = new Error('root');
    const e = new ComputeRequestError('compute failed', cause);
    expect(e.name).toBe('ComputeRequestError');
    expect(e.cause).toBe(cause);
  });

  it('AttestationValidationError has correct name', () => {
    const e = new AttestationValidationError('bad attestation');
    expect(e.name).toBe('AttestationValidationError');
    expect(e).toBeInstanceOf(Error);
  });

  it('ModelHashMismatchError message contains expected and received hashes', () => {
    const e = new ModelHashMismatchError('expected-hash', 'received-hash');
    expect(e.name).toBe('ModelHashMismatchError');
    expect(e.message).toContain('expected-hash');
    expect(e.message).toContain('received-hash');
  });
});
