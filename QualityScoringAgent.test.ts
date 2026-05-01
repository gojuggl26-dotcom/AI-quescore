/**
 * Tests for QualityScoringAgent.
 *
 * External dependencies (AgentStorage, ComputeClient) are mocked so that
 * all pure scoring logic can be tested without network access.
 */

jest.mock('../agent/memory/storage', () => ({
  AgentStorage: jest.fn().mockImplementation(() => ({
    getIndexCid: jest.fn().mockReturnValue(null),
    loadHistory: jest.fn().mockResolvedValue([]),
    savePattern: jest
      .fn()
      .mockResolvedValue({ patternCid: 'cid-pattern', indexCid: 'cid-index' }),
  })),
}));

jest.mock('../agent/inference/compute', () => ({
  ComputeClient: jest.fn().mockImplementation(() => ({
    runQualityScoring: jest.fn().mockResolvedValue({
      score: 75,
      attestation: ('0x' + 'ab'.repeat(65)) as `0x${string}`,
      modelHash: 'model-hash-abc',
      nodePublicKey: 'node-pub-key',
    }),
  })),
}));

import {
  QualityScoringAgent,
  AgentInputValidationError,
} from '../agent/QualityScoringAgent';
import type {
  AgentConfig,
  AnswerData,
  HistoricalPattern,
  QuestionAnswer,
} from '../agent/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_CONFIG: AgentConfig = {
  zgStorageUrl: 'https://storage.example.com',
  zgFlowAddress: '0x' + 'ab'.repeat(20),
  zgComputeUrl: 'https://compute.example.com',
  evmRpcUrl: 'https://rpc.example.com',
  privateKey: ('0x' + 'cd'.repeat(32)) as `0x${string}`,
  modelName: 'primary-model',
  fallbackModelName: 'fallback-model',
  modelHash: 'model-hash-abc',
  nodePublicKey: 'node-pub-key',
};

const VALID_ANSWER_DATA: AnswerData = {
  ensNode: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
  respondent: ('0x' + 'bb'.repeat(20)) as `0x${string}`,
  answers: [
    { questionId: 'q1', type: 'single_choice', choices: [1] },
    { questionId: 'q2', type: 'scale', choices: [2] },
  ],
  timestamps: [1000, 5000],
  cid: 'QmXYZ123',
};

function makeAgent(overrides: Partial<AgentConfig> = {}): QualityScoringAgent {
  return new QualityScoringAgent({ ...BASE_CONFIG, ...overrides });
}

// ─── Constructor / config validation ─────────────────────────────────────────

describe('QualityScoringAgent — constructor', () => {
  it('constructs with valid config', () => {
    expect(() => makeAgent()).not.toThrow();
  });

  const requiredKeys: Array<keyof AgentConfig> = [
    'zgStorageUrl',
    'zgFlowAddress',
    'zgComputeUrl',
    'evmRpcUrl',
    'privateKey',
    'modelName',
    'fallbackModelName',
    'modelHash',
    'nodePublicKey',
  ];

  it.each(requiredKeys)('throws when config.%s is empty', (key) => {
    expect(() => makeAgent({ [key]: '' } as Partial<AgentConfig>)).toThrow(
      `config.${key} is required`,
    );
  });
});

// ─── getCapabilities ──────────────────────────────────────────────────────────

describe('QualityScoringAgent — getCapabilities', () => {
  const agent = makeAgent();

  it('returns a non-empty string array', () => {
    const caps = agent.getCapabilities();
    expect(Array.isArray(caps)).toBe(true);
    expect(caps.length).toBeGreaterThan(0);
    caps.forEach((c) => expect(typeof c).toBe('string'));
  });

  it('includes required capability identifiers', () => {
    const caps = agent.getCapabilities();
    expect(caps).toContain('0g-compute-sealed-inference');
    expect(caps).toContain('openclaw-compatible');
  });
});

// ─── computeTimeDeltas ────────────────────────────────────────────────────────

describe('QualityScoringAgent — computeTimeDeltas', () => {
  const agent = makeAgent();

  it('returns [] for empty array', () => {
    expect(agent.computeTimeDeltas([])).toEqual([]);
  });

  it('returns [] for single timestamp', () => {
    expect(agent.computeTimeDeltas([5000])).toEqual([]);
  });

  it('returns [] for non-array input', () => {
    expect(agent.computeTimeDeltas(null as unknown as number[])).toEqual([]);
  });

  it('computes consecutive deltas', () => {
    expect(agent.computeTimeDeltas([1000, 3000, 8000])).toEqual([2000, 5000]);
  });

  it('clamps negative delta to 0', () => {
    expect(agent.computeTimeDeltas([5000, 4000])).toEqual([0]);
  });

  it('handles equal timestamps as 0 delta', () => {
    expect(agent.computeTimeDeltas([1000, 1000, 2000])).toEqual([0, 1000]);
  });

  it('produces n-1 deltas for n timestamps', () => {
    const ts = [100, 200, 400, 700, 1100];
    expect(agent.computeTimeDeltas(ts)).toHaveLength(4);
  });
});

// ─── scoreTimeConsistency ─────────────────────────────────────────────────────

describe('QualityScoringAgent — scoreTimeConsistency', () => {
  const agent = makeAgent();

  it('returns 0 for avgTimeMs < 2000 and cvTime = 0', () => {
    expect(agent.scoreTimeConsistency(500, 0)).toBe(0);
  });

  it('returns 30 for avgTimeMs < 2000 and cvTime >= MIN_NATURAL_CV (0.3)', () => {
    // speedScore=0, naturalScore=min(1,0.3/0.3)*30=30
    expect(agent.scoreTimeConsistency(100, 0.3)).toBe(30);
  });

  it('returns 70 for avgTimeMs = 8000 and cvTime = 0', () => {
    expect(agent.scoreTimeConsistency(8000, 0)).toBe(70);
  });

  it('returns 100 for avgTimeMs >= 8000 and cvTime >= 0.3', () => {
    expect(agent.scoreTimeConsistency(10000, 1.0)).toBe(100);
  });

  it('interpolates linearly between 2000ms and 8000ms', () => {
    // t = (5000-2000)/(8000-2000) = 0.5, speedScore = 35, naturalScore = 0
    expect(agent.scoreTimeConsistency(5000, 0)).toBe(35);
  });

  it('never exceeds 100', () => {
    expect(agent.scoreTimeConsistency(999999, 999)).toBeLessThanOrEqual(100);
  });

  it('never goes below 0', () => {
    expect(agent.scoreTimeConsistency(0, 0)).toBeGreaterThanOrEqual(0);
  });
});

// ─── computeChoiceEntropy ─────────────────────────────────────────────────────

describe('QualityScoringAgent — computeChoiceEntropy', () => {
  const agent = makeAgent();

  it('returns 0 for empty answers', () => {
    expect(agent.computeChoiceEntropy([])).toBe(0);
  });

  it('returns 0 when no single_choice or scale answers exist', () => {
    const answers: QuestionAnswer[] = [
      { questionId: 'q1', type: 'text', text: 'hello' },
      { questionId: 'q2', type: 'multiple_choice', choices: [0, 1] },
    ];
    expect(agent.computeChoiceEntropy(answers)).toBe(0);
  });

  it('returns 0 when all answers pick the same choice (zero entropy)', () => {
    const answers: QuestionAnswer[] = [
      { questionId: 'q1', type: 'single_choice', choices: [0] },
      { questionId: 'q2', type: 'single_choice', choices: [0] },
      { questionId: 'q3', type: 'single_choice', choices: [0] },
    ];
    expect(agent.computeChoiceEntropy(answers)).toBe(0);
  });

  it('returns 1 for perfectly uniform distribution (max entropy)', () => {
    // 4 distinct answers → entropy = log2(4) = 2, maxEntropy = log2(4) = 2 → ratio = 1
    const answers: QuestionAnswer[] = [
      { questionId: 'q1', type: 'single_choice', choices: [0] },
      { questionId: 'q2', type: 'single_choice', choices: [1] },
      { questionId: 'q3', type: 'single_choice', choices: [2] },
      { questionId: 'q4', type: 'single_choice', choices: [3] },
    ];
    expect(agent.computeChoiceEntropy(answers)).toBeCloseTo(1, 5);
  });

  it('includes scale answers in entropy computation', () => {
    const answers: QuestionAnswer[] = [
      { questionId: 'q1', type: 'scale', choices: [0] },
      { questionId: 'q2', type: 'scale', choices: [1] },
    ];
    expect(agent.computeChoiceEntropy(answers)).toBeGreaterThan(0);
  });

  it('ignores multiple_choice answers', () => {
    // Only the single_choice matters
    const answers: QuestionAnswer[] = [
      { questionId: 'q1', type: 'single_choice', choices: [0] },
      { questionId: 'q2', type: 'multiple_choice', choices: [0, 2] },
    ];
    // Only 1 single_choice → 1 element → log2(1)=0 as maxEntropy, use max=1
    // entropy = 0, result = 0
    expect(agent.computeChoiceEntropy(answers)).toBe(0);
  });
});

// ─── scorePatternConsistency ──────────────────────────────────────────────────

describe('QualityScoringAgent — scorePatternConsistency', () => {
  const agent = makeAgent();

  it('returns 0 for entropy 0', () => expect(agent.scorePatternConsistency(0)).toBe(0));
  it('returns 100 for entropy 1', () => expect(agent.scorePatternConsistency(1)).toBe(100));
  it('returns 50 for entropy 0.5', () => expect(agent.scorePatternConsistency(0.5)).toBe(50));
  it('caps at 100 for entropy > 1', () => expect(agent.scorePatternConsistency(2)).toBe(100));
});

// ─── computeContradictionConsistency ─────────────────────────────────────────

describe('QualityScoringAgent — computeContradictionConsistency', () => {
  const agent = makeAgent();

  it('returns consistency=1, pairCount=0 when no contradiction answers', () => {
    const answers: QuestionAnswer[] = [
      { questionId: 'q1', type: 'single_choice', choices: [0] },
    ];
    expect(agent.computeContradictionConsistency(answers)).toEqual({
      consistency: 1,
      pairCount: 0,
    });
  });

  it('returns consistency=1 for a non-polar-opposite pair', () => {
    const answers: QuestionAnswer[] = [
      {
        questionId: 'q1',
        type: 'contradiction',
        choices: [1],
        contradictionPairId: 'pair-A',
        totalChoices: 5,
      },
      {
        questionId: 'q2',
        type: 'contradiction',
        choices: [1],
        contradictionPairId: 'pair-A',
        totalChoices: 5,
      },
    ];
    const { consistency, pairCount } = agent.computeContradictionConsistency(answers);
    expect(pairCount).toBe(1);
    expect(consistency).toBe(1);
  });

  it('returns consistency=0 for polar opposite pair (aIdx=0, bIdx=bTotal-1)', () => {
    const answers: QuestionAnswer[] = [
      {
        questionId: 'q1',
        type: 'contradiction',
        choices: [0],
        contradictionPairId: 'pair-B',
        totalChoices: 4,
      },
      {
        questionId: 'q2',
        type: 'contradiction',
        choices: [3],
        contradictionPairId: 'pair-B',
        totalChoices: 4,
      },
    ];
    const { consistency, pairCount } = agent.computeContradictionConsistency(answers);
    expect(pairCount).toBe(1);
    expect(consistency).toBe(0);
  });

  it('returns consistency=0 for reverse polar opposite (aIdx=aTotal-1, bIdx=0)', () => {
    const answers: QuestionAnswer[] = [
      {
        questionId: 'q1',
        type: 'contradiction',
        choices: [4],
        contradictionPairId: 'pair-C',
        totalChoices: 5,
      },
      {
        questionId: 'q2',
        type: 'contradiction',
        choices: [0],
        contradictionPairId: 'pair-C',
        totalChoices: 5,
      },
    ];
    const { consistency } = agent.computeContradictionConsistency(answers);
    expect(consistency).toBe(0);
  });

  it('skips malformed pairs (singleton — not exactly 2 members)', () => {
    const answers: QuestionAnswer[] = [
      {
        questionId: 'q1',
        type: 'contradiction',
        choices: [0],
        contradictionPairId: 'singleton',
        totalChoices: 4,
      },
    ];
    const { consistency, pairCount } = agent.computeContradictionConsistency(answers);
    expect(pairCount).toBe(0);
    expect(consistency).toBe(1);
  });

  it('computes ratio across multiple pairs', () => {
    // pair-A: consistent, pair-B: polar opposite → consistency = 1/2
    const answers: QuestionAnswer[] = [
      { questionId: 'q1', type: 'contradiction', choices: [1], contradictionPairId: 'A', totalChoices: 4 },
      { questionId: 'q2', type: 'contradiction', choices: [2], contradictionPairId: 'A', totalChoices: 4 },
      { questionId: 'q3', type: 'contradiction', choices: [0], contradictionPairId: 'B', totalChoices: 4 },
      { questionId: 'q4', type: 'contradiction', choices: [3], contradictionPairId: 'B', totalChoices: 4 },
    ];
    const { consistency, pairCount } = agent.computeContradictionConsistency(answers);
    expect(pairCount).toBe(2);
    expect(consistency).toBeCloseTo(0.5, 5);
  });
});

// ─── scoreContradictionConsistency ───────────────────────────────────────────

describe('QualityScoringAgent — scoreContradictionConsistency', () => {
  const agent = makeAgent();

  it('returns 100 when pairCount = 0 (no contradiction questions)', () => {
    expect(agent.scoreContradictionConsistency(0, 0)).toBe(100);
  });

  it('returns 100 for consistency = 1', () => {
    expect(agent.scoreContradictionConsistency(1, 5)).toBe(100);
  });

  it('returns 0 for consistency = 0', () => {
    expect(agent.scoreContradictionConsistency(0, 5)).toBe(0);
  });

  it('returns 50 for consistency = 0.5', () => {
    expect(agent.scoreContradictionConsistency(0.5, 4)).toBe(50);
  });
});

// ─── computeCharDiversity ─────────────────────────────────────────────────────

describe('QualityScoringAgent — computeCharDiversity', () => {
  const agent = makeAgent();

  it('returns 0 for empty string', () => {
    expect(agent.computeCharDiversity('')).toBe(0);
  });

  it('returns 0 for null/undefined', () => {
    expect(agent.computeCharDiversity(null as unknown as string)).toBe(0);
  });

  it('returns 1 for string where all chars are unique', () => {
    expect(agent.computeCharDiversity('abcd')).toBe(1);
  });

  it('returns correct ratio for partially repeated chars', () => {
    // 'aaab' → 2 unique chars / 4 total = 0.5
    expect(agent.computeCharDiversity('aaab')).toBeCloseTo(0.5, 5);
  });

  it('returns 1/n for n identical chars', () => {
    expect(agent.computeCharDiversity('aaaa')).toBeCloseTo(0.25, 5);
  });

  it('counts single char as diversity = 1 (1/1)', () => {
    expect(agent.computeCharDiversity('x')).toBe(1);
  });
});

// ─── scoreSemanticConsistency ─────────────────────────────────────────────────

describe('QualityScoringAgent — scoreSemanticConsistency', () => {
  const agent = makeAgent();

  it('returns 100 when no text questions (empty arrays)', () => {
    expect(agent.scoreSemanticConsistency([], [])).toBe(100);
  });

  it('returns 0 for text shorter than 10 chars with zero diversity', () => {
    // len=5 → lengthScore=0, diversity=0 → diversityScore=0
    expect(agent.scoreSemanticConsistency([5], [0])).toBe(0);
  });

  it('returns 100 for long text with high diversity', () => {
    // len=200 → lengthScore=60, diversity=1.0 → diversityScore=min(40,80)=40 → total=100
    expect(agent.scoreSemanticConsistency([200], [1.0])).toBe(100);
  });

  it('interpolates length score linearly between 10 and 100 chars', () => {
    // len=55: (55-10)/90*60 = 30, diversity=0 → score=30
    expect(agent.scoreSemanticConsistency([55], [0])).toBe(30);
  });

  it('caps diversity sub-score at 40', () => {
    // diversity=1.0 → 1.0*80=80, capped at 40
    const score = agent.scoreSemanticConsistency([10], [1.0]);
    // len=10: lengthScore=0, diversityScore=40 → 40
    expect(score).toBe(40);
  });

  it('averages over multiple text answers', () => {
    // Both at len=100, diversity=0.5: lengthScore=60, diversityScore=min(40,40)=40 → 100 each
    expect(agent.scoreSemanticConsistency([100, 100], [0.5, 0.5])).toBe(100);
  });
});

// ─── computeLocalBreakdown ────────────────────────────────────────────────────

describe('QualityScoringAgent — computeLocalBreakdown', () => {
  const agent = makeAgent();

  it('returns a valid ScoreBreakdown with all sub-scores and a composite in [0, 100]', () => {
    const features = {
      timeDeltas: [3000],
      avgTimeMs: 3000,
      cvTime: 0.5,
      choiceEntropy: 0.8,
      contradictionConsistency: 1.0,
      contradictionPairCount: 0,
      textLengths: [],
      textCharDiversity: [],
      questionCount: 2,
      choiceQuestionCount: 2,
      textQuestionCount: 0,
    };
    const bd = agent.computeLocalBreakdown(features);
    expect(bd.composite).toBeGreaterThanOrEqual(0);
    expect(bd.composite).toBeLessThanOrEqual(100);
    expect(typeof bd.timeConsistency).toBe('number');
    expect(typeof bd.patternConsistency).toBe('number');
    expect(typeof bd.contradictionConsistency).toBe('number');
    expect(typeof bd.semanticConsistency).toBe('number');
  });

  it('composite equals weighted sum of sub-scores (rounded, capped at 100)', () => {
    const features = {
      timeDeltas: [],
      avgTimeMs: 8000,
      cvTime: 1.0, // speedScore=70, naturalScore=30 → timeConsistency=100
      choiceEntropy: 1.0, // patternConsistency=100
      contradictionConsistency: 1.0,
      contradictionPairCount: 0, // contradictionConsistency=100
      textLengths: [],
      textCharDiversity: [], // semanticConsistency=100
      questionCount: 3,
      choiceQuestionCount: 3,
      textQuestionCount: 0,
    };
    const bd = agent.computeLocalBreakdown(features);
    // composite = round(100*0.30 + 100*0.30 + 100*0.25 + 100*0.15) = round(100) = 100
    expect(bd.composite).toBe(100);
  });
});

// ─── extractFeatures ──────────────────────────────────────────────────────────

describe('QualityScoringAgent — extractFeatures', () => {
  const agent = makeAgent();

  it('correctly counts question types and computes deltas', () => {
    const features = agent.extractFeatures(VALID_ANSWER_DATA, []);
    expect(features.questionCount).toBe(2);
    expect(features.choiceQuestionCount).toBe(2);
    expect(features.textQuestionCount).toBe(0);
    expect(features.timeDeltas).toEqual([4000]);
    expect(features.avgTimeMs).toBe(4000);
  });

  it('does NOT attach historicalContext for empty history', () => {
    const features = agent.extractFeatures(VALID_ANSWER_DATA, []);
    expect(features.historicalContext).toBeUndefined();
  });

  it('attaches historicalContext when history is provided', () => {
    const history: HistoricalPattern[] = [
      {
        ensNode: '0x' + 'aa'.repeat(32),
        respondent: '0x' + 'bb'.repeat(20),
        avgTimeMs: 5000,
        choiceEntropy: 0.7,
        contradictionConsistency: 0.9,
        finalScore: 80,
        storedAt: 1700000000,
      },
    ];
    const features = agent.extractFeatures(VALID_ANSWER_DATA, history);
    expect(features.historicalContext).toBeDefined();
    expect(features.historicalContext!.patternCount).toBe(1);
    expect(features.historicalContext!.avgFinalScore).toBe(80);
    expect(features.historicalContext!.avgTimeMs).toBe(5000);
  });

  it('correctly counts text questions and builds textLengths', () => {
    const data: AnswerData = {
      ...VALID_ANSWER_DATA,
      answers: [
        { questionId: 'q1', type: 'text', text: 'hello world' },
        { questionId: 'q2', type: 'single_choice', choices: [0] },
      ],
      timestamps: [1000, 3000],
    };
    const features = agent.extractFeatures(data, []);
    expect(features.textQuestionCount).toBe(1);
    expect(features.textLengths).toEqual([11]);
  });

  it('counts contradiction question pairs', () => {
    const data: AnswerData = {
      ...VALID_ANSWER_DATA,
      answers: [
        {
          questionId: 'q1',
          type: 'contradiction',
          choices: [0],
          contradictionPairId: 'p1',
          totalChoices: 4,
        },
        {
          questionId: 'q2',
          type: 'contradiction',
          choices: [1],
          contradictionPairId: 'p1',
          totalChoices: 4,
        },
      ],
      timestamps: [1000, 4000],
    };
    const features = agent.extractFeatures(data, []);
    expect(features.contradictionPairCount).toBe(1);
    expect(features.contradictionConsistency).toBe(1); // not polar opposite
  });

  it('averages historical context across multiple patterns', () => {
    const history: HistoricalPattern[] = [
      {
        ensNode: '0x00',
        respondent: '0x00',
        avgTimeMs: 4000,
        choiceEntropy: 0.5,
        contradictionConsistency: 0.8,
        finalScore: 60,
        storedAt: 1000,
      },
      {
        ensNode: '0x00',
        respondent: '0x00',
        avgTimeMs: 6000,
        choiceEntropy: 0.9,
        contradictionConsistency: 1.0,
        finalScore: 80,
        storedAt: 2000,
      },
    ];
    const features = agent.extractFeatures(VALID_ANSWER_DATA, history);
    const hc = features.historicalContext!;
    expect(hc.patternCount).toBe(2);
    expect(hc.avgFinalScore).toBe(70);
    expect(hc.avgTimeMs).toBe(5000);
    expect(hc.latestStoredAt).toBe(2000);
  });
});

// ─── Input validation ─────────────────────────────────────────────────────────

describe('QualityScoringAgent — validateInput (via execute)', () => {
  it('throws AgentInputValidationError for null input', async () => {
    const agent = makeAgent();
    await expect(
      agent.execute(null as unknown as { answerData: AnswerData }),
    ).rejects.toThrow(AgentInputValidationError);
  });

  it('throws for null answerData', async () => {
    const agent = makeAgent();
    await expect(
      agent.execute({ answerData: null as unknown as AnswerData }),
    ).rejects.toThrow(AgentInputValidationError);
  });

  it('throws for invalid ensNode (wrong length)', async () => {
    const agent = makeAgent();
    await expect(
      agent.execute({
        answerData: { ...VALID_ANSWER_DATA, ensNode: '0xinvalid' as `0x${string}` },
      }),
    ).rejects.toThrow(AgentInputValidationError);
  });

  it('throws for ensNode without 0x prefix', async () => {
    const agent = makeAgent();
    await expect(
      agent.execute({
        answerData: { ...VALID_ANSWER_DATA, ensNode: ('aa'.repeat(32)) as `0x${string}` },
      }),
    ).rejects.toThrow(AgentInputValidationError);
  });

  it('throws for invalid respondent address (wrong length)', async () => {
    const agent = makeAgent();
    await expect(
      agent.execute({
        answerData: { ...VALID_ANSWER_DATA, respondent: '0xshort' as `0x${string}` },
      }),
    ).rejects.toThrow(AgentInputValidationError);
  });

  it('throws for empty answers array', async () => {
    const agent = makeAgent();
    await expect(
      agent.execute({ answerData: { ...VALID_ANSWER_DATA, answers: [], timestamps: [] } }),
    ).rejects.toThrow(AgentInputValidationError);
  });

  it('throws when timestamps.length != answers.length', async () => {
    const agent = makeAgent();
    await expect(
      agent.execute({ answerData: { ...VALID_ANSWER_DATA, timestamps: [1000] } }),
    ).rejects.toThrow(AgentInputValidationError);
  });

  it('throws for non-monotonic timestamps', async () => {
    const agent = makeAgent();
    await expect(
      agent.execute({
        answerData: { ...VALID_ANSWER_DATA, timestamps: [5000, 1000] },
      }),
    ).rejects.toThrow(AgentInputValidationError);
  });

  it('throws for non-positive timestamp', async () => {
    const agent = makeAgent();
    await expect(
      agent.execute({ answerData: { ...VALID_ANSWER_DATA, timestamps: [0, 1000] } }),
    ).rejects.toThrow(AgentInputValidationError);
  });

  it('throws for empty cid', async () => {
    const agent = makeAgent();
    await expect(
      agent.execute({ answerData: { ...VALID_ANSWER_DATA, cid: '' } }),
    ).rejects.toThrow(AgentInputValidationError);
  });

  it('throws for invalid answer type', async () => {
    const agent = makeAgent();
    await expect(
      agent.execute({
        answerData: {
          ...VALID_ANSWER_DATA,
          answers: [{ questionId: 'q1', type: 'unknown_type' as 'text', text: 'x' }],
          timestamps: [1000],
        },
      }),
    ).rejects.toThrow(AgentInputValidationError);
  });

  it('throws for single_choice with > 1 choices', async () => {
    const agent = makeAgent();
    await expect(
      agent.execute({
        answerData: {
          ...VALID_ANSWER_DATA,
          answers: [{ questionId: 'q1', type: 'single_choice', choices: [0, 1] }],
          timestamps: [1000],
        },
      }),
    ).rejects.toThrow(AgentInputValidationError);
  });

  it('throws for text answer missing .text string', async () => {
    const agent = makeAgent();
    await expect(
      agent.execute({
        answerData: {
          ...VALID_ANSWER_DATA,
          answers: [{ questionId: 'q1', type: 'text' } as QuestionAnswer],
          timestamps: [1000],
        },
      }),
    ).rejects.toThrow(AgentInputValidationError);
  });

  it('throws for contradiction missing contradictionPairId', async () => {
    const agent = makeAgent();
    await expect(
      agent.execute({
        answerData: {
          ...VALID_ANSWER_DATA,
          answers: [
            { questionId: 'q1', type: 'contradiction', choices: [0], totalChoices: 4 },
          ] as QuestionAnswer[],
          timestamps: [1000],
        },
      }),
    ).rejects.toThrow(AgentInputValidationError);
  });

  it('throws for contradiction with totalChoices < 2', async () => {
    const agent = makeAgent();
    await expect(
      agent.execute({
        answerData: {
          ...VALID_ANSWER_DATA,
          answers: [
            {
              questionId: 'q1',
              type: 'contradiction',
              choices: [0],
              contradictionPairId: 'p1',
              totalChoices: 1,
            },
          ],
          timestamps: [1000],
        },
      }),
    ).rejects.toThrow(AgentInputValidationError);
  });
});

// ─── execute — happy path ─────────────────────────────────────────────────────

describe('QualityScoringAgent — execute', () => {
  it('returns a complete AgentOutput on success', async () => {
    const agent = makeAgent();
    const output = await agent.execute({ answerData: VALID_ANSWER_DATA });
    expect(output.payload.ensNode).toBe(VALID_ANSWER_DATA.ensNode);
    expect(output.payload.answerCID).toBe(VALID_ANSWER_DATA.cid);
    expect(output.payload.qualityScore).toBe(75);
    expect(output.inferenceResult.score).toBe(75);
    expect(output.updatedIndexCid).toBe('cid-index');
  });

  it('proceeds without historical context when loadHistory rejects', async () => {
    const { AgentStorage } = jest.requireMock('../agent/memory/storage') as {
      AgentStorage: jest.Mock;
    };
    AgentStorage.mockImplementationOnce(() => ({
      getIndexCid: jest.fn().mockReturnValue(null),
      loadHistory: jest.fn().mockRejectedValue(new Error('storage unreachable')),
      savePattern: jest
        .fn()
        .mockResolvedValue({ patternCid: 'cid1', indexCid: 'cid-index' }),
    }));
    const agent = makeAgent();
    const output = await agent.execute({ answerData: VALID_ANSWER_DATA });
    expect(output.payload.qualityScore).toBe(75);
  });

  it('returns updatedIndexCid=null when savePattern rejects (non-fatal)', async () => {
    const { AgentStorage } = jest.requireMock('../agent/memory/storage') as {
      AgentStorage: jest.Mock;
    };
    AgentStorage.mockImplementationOnce(() => ({
      getIndexCid: jest.fn().mockReturnValue(null),
      loadHistory: jest.fn().mockResolvedValue([]),
      savePattern: jest.fn().mockRejectedValue(new Error('upload failed')),
    }));
    const agent = makeAgent();
    const output = await agent.execute({ answerData: VALID_ANSWER_DATA });
    expect(output.updatedIndexCid).toBeNull();
    expect(output.payload.qualityScore).toBe(75); // score is still valid
  });
});
