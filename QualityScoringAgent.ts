import type {
  AgentConfig,
  AgentInput,
  AgentOutput,
  AnswerData,
  HistoricalContext,
  HistoricalPattern,
  InferenceFeatures,
  IOpenClawAgent,
  QuestionAnswer,
  ScoreBreakdown,
} from './types';
import { AgentStorage } from './memory/storage';
import { ComputeClient } from './inference/compute';

// ─── Scoring weights (must mirror compute.ts W_* constants) ──────────────────

const W_TIME         = 0.30;
const W_PATTERN      = 0.30;
const W_CONTRADICTION = 0.25;
const W_SEMANTIC     = 0.15;

// ─── Timing thresholds ────────────────────────────────────────────────────────

/** Below this avg response time (ms) the speed sub-score is 0 (too fast). */
const MIN_HUMAN_RESPONSE_MS = 2_000;
/** At or above this avg response time (ms) the speed sub-score is capped at 70. */
const FULL_SPEED_CREDIT_MS  = 8_000;
/**
 * CV (coefficient of variation) threshold for natural human timing variation.
 * CV < MIN_NATURAL_CV suggests robotic uniformity.
 */
const MIN_NATURAL_CV = 0.3;

// ─── Errors ───────────────────────────────────────────────────────────────────

export class AgentInputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentInputValidationError';
  }
}

// ─── QualityScoringAgent ─────────────────────────────────────────────────────

/**
 * Main OpenClaw-compatible agent.
 *
 * Orchestration flow (司令塔 role)
 * ──────────────────────────────
 * 1. Load respondent's past patterns from the 0G Storage memory layer.
 * 2. Extract behavioral features from the current survey answers.
 * 3. Augment features with the historical context derived from step 1.
 * 4. Submit the enriched feature vector to 0G Compute (TEE) for sealed
 *    inference — the TEE's score is the authoritative result.
 * 5. Persist the new pattern back to 0G Storage (non-fatal if it fails).
 * 6. Return the on-chain-ready payload alongside the local breakdown.
 */
export class QualityScoringAgent
  implements IOpenClawAgent<AgentInput, AgentOutput>
{
  readonly name        = 'QualityScoringAgent';
  readonly description =
    'Computes a human-likeness quality score for SurveyChain answers via ' +
    '0G Compute Sealed Inference (TEE) and returns the attested result ' +
    'ready for on-chain submission to SurveyReward.submitAnswer().';
  readonly version = '1.0.0';

  private readonly storage: AgentStorage;
  private readonly compute: ComputeClient;

  constructor(config: AgentConfig) {
    this.validateConfig(config);
    this.storage = new AgentStorage(
      config.zgStorageUrl,
      config.zgFlowAddress,
      config.privateKey,
      config.evmRpcUrl,
      config.indexCid,
    );
    this.compute = new ComputeClient(
      config.zgComputeUrl,
      config.privateKey,
      config.evmRpcUrl,
      config.modelName,
      config.fallbackModelName,
      config.modelHash,
      config.nodePublicKey,
    );
  }

  // ─── IOpenClawAgent ──────────────────────────────────────────────────────────

  /**
   * Executes the full scoring pipeline.
   *
   * Throws only on unrecoverable errors (input validation, TEE failure).
   * Memory layer failures (storage load/save) are non-fatal: the pipeline
   * proceeds without historical context and `updatedIndexCid` is null.
   */
  async execute(input: AgentInput): Promise<AgentOutput> {
    this.validateInput(input);
    const { answerData } = input;

    // ── Step 1: Load past patterns from 0G Storage memory layer ──────────────
    let history: HistoricalPattern[] = [];
    try {
      history = await this.storage.loadHistory(answerData.respondent);
    } catch (err) {
      // Non-fatal: continue without historical context.
      console.warn(
        `[QualityScoringAgent] History load failed for ` +
          `respondent=${answerData.respondent} — proceeding without historical ` +
          `context. Cause: ${String(err)}`,
      );
    }

    // ── Step 2: Extract features + inject historical context ──────────────────
    const features = this.extractFeatures(answerData, history);

    // ── Step 3: Sealed inference via 0G Compute TEE (authoritative score) ─────
    const inferenceResult = await this.compute.runQualityScoring(features);

    // ── Step 4: Compute local breakdown (informational, not authoritative) ─────
    const breakdown = this.computeLocalBreakdown(features);

    // ── Step 5: Persist new pattern to 0G Storage (non-fatal) ─────────────────
    let updatedIndexCid: string | null = null;
    try {
      const saved = await this.storage.savePattern({
        ensNode:                  answerData.ensNode,
        respondent:               answerData.respondent,
        avgTimeMs:                features.avgTimeMs,
        choiceEntropy:            features.choiceEntropy,
        contradictionConsistency: features.contradictionConsistency,
        finalScore:               inferenceResult.score,
        storedAt:                 Date.now(),
      });
      updatedIndexCid = saved.indexCid;
    } catch (err) {
      console.warn(
        `[QualityScoringAgent] Pattern persistence failed for ` +
          `respondent=${answerData.respondent} — scoring result is still valid. ` +
          `Cause: ${String(err)}`,
      );
    }

    return {
      payload: {
        ensNode:      answerData.ensNode,
        answerCID:    answerData.cid,
        qualityScore: inferenceResult.score,
        attestation:  inferenceResult.attestation,
      },
      breakdown,
      inferenceResult,
      updatedIndexCid,
    };
  }

  getCapabilities(): string[] {
    return [
      'time-consistency-scoring',
      'choice-pattern-entropy',
      'contradiction-pair-detection',
      'semantic-text-analysis-via-tee',
      '0g-compute-sealed-inference',
      '0g-storage-encrypted-memory',
      'cross-survey-historical-calibration',
      'openclaw-compatible',
    ];
  }

  /**
   * Returns the current CID of the encrypted pattern index in 0G Storage.
   * Persist this value and pass it as AgentConfig.indexCid on the next run
   * so historical data survives agent restarts.
   */
  getIndexCid(): string | null {
    return this.storage.getIndexCid();
  }

  // ─── Feature extraction ───────────────────────────────────────────────────────

  /**
   * Assembles the full InferenceFeatures vector from raw AnswerData.
   * When `history` is non-empty, a HistoricalContext is computed and attached.
   */
  extractFeatures(
    data: AnswerData,
    history: HistoricalPattern[],
  ): InferenceFeatures {
    const timeDeltas = this.computeTimeDeltas(data.timestamps);
    const avgTimeMs =
      timeDeltas.length > 0
        ? timeDeltas.reduce((s, v) => s + v, 0) / timeDeltas.length
        : 0;
    const cvTime = this.computeCV(timeDeltas, avgTimeMs);
    const choiceEntropy = this.computeChoiceEntropy(data.answers);
    const { consistency: contradictionConsistency, pairCount: contradictionPairCount } =
      this.computeContradictionConsistency(data.answers);

    const textAnswers = data.answers.filter(
      (a) => a.type === 'text' && typeof a.text === 'string',
    );
    const textLengths      = textAnswers.map((a) => (a.text ?? '').length);
    const textCharDiversity = textAnswers.map((a) =>
      this.computeCharDiversity(a.text ?? ''),
    );

    const choiceQuestionCount = data.answers.filter(
      (a) =>
        a.type === 'single_choice' ||
        a.type === 'multiple_choice' ||
        a.type === 'scale',
    ).length;

    const historicalContext = this.buildHistoricalContext(history);

    const features: InferenceFeatures = {
      timeDeltas,
      avgTimeMs,
      cvTime,
      choiceEntropy,
      contradictionConsistency,
      contradictionPairCount,
      textLengths,
      textCharDiversity,
      questionCount:       data.answers.length,
      choiceQuestionCount,
      textQuestionCount:   textAnswers.length,
    };

    // Attach historical context only when available (exactOptionalPropertyTypes
    // requires us not to set the field at all when the value is undefined).
    if (historicalContext !== undefined) {
      features.historicalContext = historicalContext;
    }

    return features;
  }

  // ─── Historical context ───────────────────────────────────────────────────────

  /**
   * Computes cross-survey behavioural averages from the respondent's stored
   * patterns.  Returns undefined when the list is empty (first-time respondent).
   */
  private buildHistoricalContext(
    history: HistoricalPattern[],
  ): HistoricalContext | undefined {
    if (history.length === 0) return undefined;

    const n = history.length;
    const sum = (fn: (p: HistoricalPattern) => number): number =>
      history.reduce((s, p) => s + fn(p), 0);

    return {
      patternCount:                n,
      avgFinalScore:               sum((p) => p.finalScore) / n,
      avgTimeMs:                   sum((p) => p.avgTimeMs) / n,
      avgChoiceEntropy:            sum((p) => p.choiceEntropy) / n,
      avgContradictionConsistency: sum((p) => p.contradictionConsistency) / n,
      latestStoredAt:              Math.max(...history.map((p) => p.storedAt)),
    };
  }

  // ─── Local score breakdown ────────────────────────────────────────────────────

  /**
   * Computes the four sub-scores and a weighted composite.
   * All values are informational — the TEE score in SealedInferenceResult is
   * the authoritative figure used for on-chain submission.
   */
  computeLocalBreakdown(features: InferenceFeatures): ScoreBreakdown {
    const timeConsistency = this.scoreTimeConsistency(
      features.avgTimeMs,
      features.cvTime,
    );
    const patternConsistency = this.scorePatternConsistency(features.choiceEntropy);
    const contradictionConsistency = this.scoreContradictionConsistency(
      features.contradictionConsistency,
      features.contradictionPairCount,
    );
    const semanticConsistency = this.scoreSemanticConsistency(
      features.textLengths,
      features.textCharDiversity,
    );
    const composite = Math.min(
      100,
      Math.round(
        timeConsistency        * W_TIME         +
        patternConsistency     * W_PATTERN      +
        contradictionConsistency * W_CONTRADICTION +
        semanticConsistency    * W_SEMANTIC,
      ),
    );

    return {
      timeConsistency,
      patternConsistency,
      contradictionConsistency,
      semanticConsistency,
      composite,
    };
  }

  // ─── Timing ───────────────────────────────────────────────────────────────────

  /**
   * Delta array between consecutive answer submissions.
   * Negative deltas (timestamp regression) are clamped to 0 rather than
   * thrown, since the input is validated to be monotonically non-decreasing
   * and regressions cannot occur in valid data.
   */
  computeTimeDeltas(timestamps: number[]): number[] {
    if (!Array.isArray(timestamps) || timestamps.length < 2) return [];
    const deltas: number[] = [];
    for (let i = 1; i < timestamps.length; i++) {
      deltas.push(Math.max(0, timestamps[i]! - timestamps[i - 1]!));
    }
    return deltas;
  }

  /**
   * Piecewise-linear speed + naturalness score (0–100):
   *
   *   avgTimeMs < MIN_HUMAN_RESPONSE_MS          → speedScore = 0
   *   MIN_HUMAN_RESPONSE_MS ≤ avg < FULL_SPEED   → speedScore = linear 0–70
   *   avg ≥ FULL_SPEED_CREDIT_MS                 → speedScore = 70
   *
   *   naturalScore = min(1, cvTime / MIN_NATURAL_CV) * 30
   */
  scoreTimeConsistency(avgTimeMs: number, cvTime: number): number {
    let speedScore: number;
    if (avgTimeMs < MIN_HUMAN_RESPONSE_MS) {
      speedScore = 0;
    } else if (avgTimeMs >= FULL_SPEED_CREDIT_MS) {
      speedScore = 70;
    } else {
      const t =
        (avgTimeMs - MIN_HUMAN_RESPONSE_MS) /
        (FULL_SPEED_CREDIT_MS - MIN_HUMAN_RESPONSE_MS);
      speedScore = t * 70;
    }
    const naturalScore = Math.min(1, cvTime / MIN_NATURAL_CV) * 30;
    return Math.min(100, Math.round(speedScore + naturalScore));
  }

  // ─── Choice entropy ───────────────────────────────────────────────────────────

  /**
   * Normalised Shannon entropy ∈ [0, 1] of selected choice indices across all
   * single_choice and scale answers.
   *
   * Entropy is normalised by log₂(n) where n = number of choice answers, so
   * the result is scale-invariant with respect to question count.
   *
   * Returns 0 when there are no applicable answers.
   */
  computeChoiceEntropy(answers: QuestionAnswer[]): number {
    const choiceAnswers = answers.filter(
      (a) =>
        (a.type === 'single_choice' || a.type === 'scale') &&
        Array.isArray(a.choices) &&
        a.choices.length === 1,
    );
    if (choiceAnswers.length === 0) return 0;

    const freq = new Map<number, number>();
    for (const a of choiceAnswers) {
      const idx = a.choices![0]!;
      freq.set(idx, (freq.get(idx) ?? 0) + 1);
    }

    const n = choiceAnswers.length;
    let entropy = 0;
    for (const count of freq.values()) {
      const p = count / n;
      if (p > 0) entropy -= p * Math.log2(p);
    }

    // log₂(n) is the upper bound of entropy for n equiprobable outcomes.
    const maxEntropy = n > 1 ? Math.log2(n) : 1;
    return Math.min(1, entropy / maxEntropy);
  }

  scorePatternConsistency(choiceEntropy: number): number {
    return Math.min(100, Math.round(choiceEntropy * 100));
  }

  // ─── Contradiction consistency ────────────────────────────────────────────────

  /**
   * Groups answers by contradictionPairId.  A pair is inconsistent when both
   * answers land on polar-opposite ends of their respective choice scales
   * simultaneously: one at index 0 and the other at the last index.
   *
   * Returns consistency ∈ [0, 1] and the number of valid pairs evaluated.
   * Malformed pairs (not exactly 2 members) are skipped with benefit of the
   * doubt (they do not count against the score).
   */
  computeContradictionConsistency(answers: QuestionAnswer[]): {
    consistency: number;
    pairCount: number;
  } {
    const contradictionAnswers = answers.filter(
      (a) =>
        a.type === 'contradiction' &&
        typeof a.contradictionPairId === 'string' &&
        Array.isArray(a.choices) &&
        a.choices.length === 1 &&
        typeof a.totalChoices === 'number' &&
        a.totalChoices > 1,
    );

    if (contradictionAnswers.length === 0) return { consistency: 1, pairCount: 0 };

    const groups = new Map<string, QuestionAnswer[]>();
    for (const a of contradictionAnswers) {
      const pid = a.contradictionPairId!;
      const bucket = groups.get(pid) ?? [];
      bucket.push(a);
      groups.set(pid, bucket);
    }

    let consistentPairs = 0;
    let evaluatedPairs  = 0;

    for (const pair of groups.values()) {
      if (pair.length !== 2) continue; // malformed — skip

      evaluatedPairs++;
      const [a, b] = pair as [QuestionAnswer, QuestionAnswer];
      const aIdx   = a.choices![0]!;
      const bIdx   = b.choices![0]!;
      const aTotal = a.totalChoices!;
      const bTotal = b.totalChoices!;

      const isPolarOpposite =
        (aIdx === 0 && bIdx === bTotal - 1) ||
        (aIdx === aTotal - 1 && bIdx === 0);

      if (!isPolarOpposite) consistentPairs++;
    }

    if (evaluatedPairs === 0) return { consistency: 1, pairCount: 0 };
    return {
      consistency: consistentPairs / evaluatedPairs,
      pairCount:   evaluatedPairs,
    };
  }

  scoreContradictionConsistency(consistency: number, pairCount: number): number {
    if (pairCount === 0) return 100; // no contradiction questions → full credit
    return Math.min(100, Math.round(consistency * 100));
  }

  // ─── Text / semantic ──────────────────────────────────────────────────────────

  /** Ratio of unique characters to total characters.  Returns 0 for empty strings. */
  computeCharDiversity(text: string): number {
    if (!text || text.length === 0) return 0;
    return new Set(text).size / text.length;
  }

  /**
   * Informational semantic score from text length and character diversity.
   * The TEE's sealed inference is authoritative; this is for UI transparency.
   *
   * Length sub-score  : < 10 chars → 0; 10–100 chars → linear 0–60; ≥ 100 → 60
   * Diversity sub-score: diversity × 80, capped at 40
   */
  scoreSemanticConsistency(
    textLengths: number[],
    textCharDiversity: number[],
  ): number {
    if (textLengths.length === 0) return 100; // no text questions → full credit

    const lengthScores = textLengths.map((len) => {
      if (len < 10) return 0;
      if (len >= 100) return 60;
      return ((len - 10) / 90) * 60;
    });
    const diversityScores = textCharDiversity.map((d) => Math.min(40, d * 80));

    const n = textLengths.length;
    const avgLen = lengthScores.reduce((s, v) => s + v, 0) / n;
    const avgDiv = diversityScores.reduce((s, v) => s + v, 0) / n;
    return Math.min(100, Math.round(avgLen + avgDiv));
  }

  // ─── Coefficient of variation ─────────────────────────────────────────────────

  private computeCV(values: number[], mean: number): number {
    if (values.length === 0 || mean === 0) return 0;
    const variance =
      values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance) / mean;
  }

  // ─── Validation ───────────────────────────────────────────────────────────────

  private validateConfig(config: AgentConfig): void {
    const required: Array<keyof AgentConfig> = [
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
    for (const key of required) {
      if (!config[key]) {
        throw new Error(`QualityScoringAgent: config.${key} is required`);
      }
    }
  }

  private validateInput(input: AgentInput): void {
    if (!input) throw new AgentInputValidationError('input is null or undefined');

    const { answerData } = input;
    if (!answerData)
      throw new AgentInputValidationError('input.answerData is null or undefined');

    if (
      typeof answerData.ensNode !== 'string' ||
      !answerData.ensNode.startsWith('0x') ||
      answerData.ensNode.length !== 66
    ) {
      throw new AgentInputValidationError(
        `answerData.ensNode must be a bytes32 hex string (0x + 64 hex chars), ` +
          `got: ${answerData.ensNode}`,
      );
    }

    if (
      typeof answerData.respondent !== 'string' ||
      !answerData.respondent.startsWith('0x') ||
      answerData.respondent.length !== 42
    ) {
      throw new AgentInputValidationError(
        `answerData.respondent must be a 20-byte address (0x + 40 hex chars), ` +
          `got: ${answerData.respondent}`,
      );
    }

    if (!Array.isArray(answerData.answers) || answerData.answers.length === 0) {
      throw new AgentInputValidationError(
        'answerData.answers must be a non-empty array',
      );
    }

    if (!Array.isArray(answerData.timestamps)) {
      throw new AgentInputValidationError('answerData.timestamps must be an array');
    }

    if (answerData.timestamps.length !== answerData.answers.length) {
      throw new AgentInputValidationError(
        `answerData.timestamps.length (${answerData.timestamps.length}) must ` +
          `equal answerData.answers.length (${answerData.answers.length})`,
      );
    }

    for (let i = 0; i < answerData.timestamps.length; i++) {
      const ts = answerData.timestamps[i]!;
      if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) {
        throw new AgentInputValidationError(
          `answerData.timestamps[${i}] must be a positive finite number, got: ${ts}`,
        );
      }
      if (i > 0 && ts < answerData.timestamps[i - 1]!) {
        throw new AgentInputValidationError(
          `answerData.timestamps must be monotonically non-decreasing: ` +
            `timestamps[${i - 1}]=${answerData.timestamps[i - 1]!} > ` +
            `timestamps[${i}]=${ts}`,
        );
      }
    }

    if (typeof answerData.cid !== 'string' || answerData.cid.trim() === '') {
      throw new AgentInputValidationError('answerData.cid must be a non-empty string');
    }

    for (let i = 0; i < answerData.answers.length; i++) {
      this.validateAnswer(answerData.answers[i]!, i);
    }
  }

  private validateAnswer(answer: QuestionAnswer, idx: number): void {
    const p = `answerData.answers[${idx}]`;
    if (!answer || typeof answer !== 'object') {
      throw new AgentInputValidationError(`${p} must be an object`);
    }
    if (typeof answer.questionId !== 'string' || answer.questionId.trim() === '') {
      throw new AgentInputValidationError(
        `${p}.questionId must be a non-empty string`,
      );
    }

    const validTypes = [
      'single_choice',
      'multiple_choice',
      'scale',
      'text',
      'contradiction',
    ] as const;
    if (!(validTypes as readonly string[]).includes(answer.type)) {
      throw new AgentInputValidationError(
        `${p}.type must be one of ${validTypes.join(', ')}, got: ${answer.type}`,
      );
    }

    if (answer.type === 'text') {
      if (typeof answer.text !== 'string') {
        throw new AgentInputValidationError(
          `${p}.text must be a string when type === 'text'`,
        );
      }
    } else {
      if (!Array.isArray(answer.choices) || answer.choices.length === 0) {
        throw new AgentInputValidationError(
          `${p}.choices must be a non-empty array for type=${answer.type}`,
        );
      }
      for (let j = 0; j < answer.choices.length; j++) {
        const ch = answer.choices[j]!;
        if (!Number.isInteger(ch) || ch < 0) {
          throw new AgentInputValidationError(
            `${p}.choices[${j}] must be a non-negative integer, got: ${ch}`,
          );
        }
      }
      if (answer.type === 'single_choice' || answer.type === 'scale') {
        if (answer.choices.length !== 1) {
          throw new AgentInputValidationError(
            `${p}.choices must have exactly 1 element for type=${answer.type}, ` +
              `got: ${answer.choices.length}`,
          );
        }
      }
    }

    if (answer.type === 'contradiction') {
      if (
        typeof answer.contradictionPairId !== 'string' ||
        answer.contradictionPairId.trim() === ''
      ) {
        throw new AgentInputValidationError(
          `${p}.contradictionPairId must be a non-empty string when ` +
            `type === 'contradiction'`,
        );
      }
      if (
        typeof answer.totalChoices !== 'number' ||
        !Number.isInteger(answer.totalChoices) ||
        answer.totalChoices < 2
      ) {
        throw new AgentInputValidationError(
          `${p}.totalChoices must be an integer >= 2 when type === 'contradiction'`,
        );
      }
    }
  }
}
