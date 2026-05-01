import { ZGComputeNetworkBroker } from '@0glabs/0g-ts-sdk';
import { JsonRpcProvider, Wallet } from 'ethers';
import type { HexString, InferenceFeatures, SealedInferenceResult } from '../types';

// ─── Scoring weight constants (must mirror QualityScoringAgent) ──────────────

const W_TIME = 0.30;
const W_PATTERN = 0.30;
const W_CONTRADICTION = 0.25;
const W_SEMANTIC = 0.15;

// ─── Attestation format ───────────────────────────────────────────────────────

/** Expected byte length of the raw ECDSA attestation (r + s + v). */
const ATTESTATION_BYTE_LENGTH = 65;
/** Hex string length including "0x" prefix: 2 + 65*2. */
const ATTESTATION_HEX_LENGTH = 2 + ATTESTATION_BYTE_LENGTH * 2;

// ─── Errors ───────────────────────────────────────────────────────────────────

export class ComputeRequestError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'ComputeRequestError';
  }
}

export class AttestationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttestationValidationError';
  }
}

export class ModelHashMismatchError extends Error {
  constructor(expected: string, received: string) {
    super(`Model hash mismatch — expected=${expected} received=${received}`);
    this.name = 'ModelHashMismatchError';
  }
}

// ─── ComputeClient ────────────────────────────────────────────────────────────

export class ComputeClient {
  private readonly broker: ZGComputeNetworkBroker;
  private readonly primaryModel: string;
  private readonly fallbackModel: string;
  private readonly expectedModelHash: string;
  private readonly expectedNodePublicKey: string;

  constructor(
    computeUrl: string,
    privateKey: HexString,
    rpcUrl: string,
    primaryModel: string,
    fallbackModel: string,
    expectedModelHash: string,
    expectedNodePublicKey: string,
  ) {
    if (!computeUrl) throw new Error('ComputeClient: computeUrl is required');
    if (!privateKey) throw new Error('ComputeClient: privateKey is required');
    if (!rpcUrl) throw new Error('ComputeClient: rpcUrl is required');
    if (!primaryModel) throw new Error('ComputeClient: primaryModel is required');
    if (!fallbackModel) throw new Error('ComputeClient: fallbackModel is required');
    if (!expectedModelHash) throw new Error('ComputeClient: expectedModelHash is required');
    if (!expectedNodePublicKey) throw new Error('ComputeClient: expectedNodePublicKey is required');

    const provider = new JsonRpcProvider(rpcUrl);
    const signer = new Wallet(privateKey, provider);
    this.broker = new ZGComputeNetworkBroker(computeUrl, signer);
    this.primaryModel = primaryModel;
    this.fallbackModel = fallbackModel;
    this.expectedModelHash = expectedModelHash;
    this.expectedNodePublicKey = expectedNodePublicKey;
  }

  /**
   * Submits features (including optional historical context) to the TEE via
   * 0G Compute Sealed Inference.  Tries the primary model first and falls back
   * to fallbackModel on any failure.
   * Validates model hash, node public key, and attestation format before returning.
   */
  async runQualityScoring(features: InferenceFeatures): Promise<SealedInferenceResult> {
    this.validateFeatures(features);

    const prompt = this.buildPrompt(features);

    let result: SealedInferenceResult;
    try {
      result = await this.callModel(this.primaryModel, prompt);
    } catch (primaryErr) {
      let fallbackResult: SealedInferenceResult;
      try {
        fallbackResult = await this.callModel(this.fallbackModel, prompt);
      } catch (fallbackErr) {
        throw new ComputeRequestError(
          `Both primary (${this.primaryModel}) and fallback (${this.fallbackModel}) ` +
            `models failed. ` +
            `Primary: ${String(primaryErr)}. Fallback: ${String(fallbackErr)}`,
          { primaryErr, fallbackErr },
        );
      }
      result = fallbackResult;
    }

    this.validateResult(result);
    return result;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async callModel(
    modelName: string,
    prompt: string,
  ): Promise<SealedInferenceResult> {
    let rawResponse: unknown;
    try {
      rawResponse = await this.broker.inference.requestWithAttestation(
        modelName,
        prompt,
      );
    } catch (err) {
      throw new ComputeRequestError(
        `0G Compute inference failed for model=${modelName}: ${String(err)}`,
        err,
      );
    }

    if (!rawResponse || typeof rawResponse !== 'object') {
      throw new ComputeRequestError(
        `Model=${modelName} returned a non-object response: ` +
          JSON.stringify(rawResponse),
      );
    }

    const resp = rawResponse as Record<string, unknown>;

    // Parse score
    const scoreRaw =
      resp['score'] ?? resp['quality_score'] ?? resp['qualityScore'];
    if (scoreRaw === undefined || scoreRaw === null) {
      throw new ComputeRequestError(
        `Model=${modelName} response missing "score". ` +
          `Response: ${JSON.stringify(resp)}`,
      );
    }
    const score =
      typeof scoreRaw === 'string' ? parseInt(scoreRaw, 10) : Number(scoreRaw);
    if (!Number.isInteger(score) || score < 0 || score > 100) {
      throw new ComputeRequestError(
        `Model=${modelName} returned invalid score=${scoreRaw} ` +
          `(must be an integer in [0, 100])`,
      );
    }

    // Parse attestation
    const attestationRaw = resp['attestation'];
    if (typeof attestationRaw !== 'string' || attestationRaw.trim() === '') {
      throw new ComputeRequestError(
        `Model=${modelName} response missing "attestation". ` +
          `Response: ${JSON.stringify(resp)}`,
      );
    }

    // Parse modelHash
    const modelHashRaw = resp['modelHash'] ?? resp['model_hash'];
    if (typeof modelHashRaw !== 'string' || modelHashRaw.trim() === '') {
      throw new ComputeRequestError(
        `Model=${modelName} response missing "modelHash". ` +
          `Response: ${JSON.stringify(resp)}`,
      );
    }

    // Parse nodePublicKey
    const nodePublicKeyRaw =
      resp['nodePublicKey'] ?? resp['node_public_key'];
    if (typeof nodePublicKeyRaw !== 'string' || nodePublicKeyRaw.trim() === '') {
      throw new ComputeRequestError(
        `Model=${modelName} response missing "nodePublicKey". ` +
          `Response: ${JSON.stringify(resp)}`,
      );
    }

    return {
      score,
      attestation: attestationRaw as HexString,
      modelHash: modelHashRaw,
      nodePublicKey: nodePublicKeyRaw,
    };
  }

  private validateResult(result: SealedInferenceResult): void {
    // Model hash integrity
    if (result.modelHash.toLowerCase() !== this.expectedModelHash.toLowerCase()) {
      throw new ModelHashMismatchError(this.expectedModelHash, result.modelHash);
    }

    // Node public key
    if (
      result.nodePublicKey.toLowerCase() !==
      this.expectedNodePublicKey.toLowerCase()
    ) {
      throw new AttestationValidationError(
        `TEE node public key mismatch — ` +
          `expected=${this.expectedNodePublicKey} received=${result.nodePublicKey}`,
      );
    }

    // Attestation format: "0x" + 130 lowercase hex chars (65 bytes)
    const att = result.attestation;
    if (
      typeof att !== 'string' ||
      !att.startsWith('0x') ||
      att.length !== ATTESTATION_HEX_LENGTH ||
      !/^0x[0-9a-fA-F]+$/.test(att)
    ) {
      throw new AttestationValidationError(
        `Attestation has invalid format — ` +
          `expected "0x" + ${ATTESTATION_BYTE_LENGTH * 2} hex chars, ` +
          `got length=${att?.length ?? 'null'}: ${String(att)}`,
      );
    }

    // Score bounds (re-verify after potential model switching)
    if (!Number.isInteger(result.score) || result.score < 0 || result.score > 100) {
      throw new ComputeRequestError(
        `Post-validation score out of range: ${result.score}`,
      );
    }
  }

  /**
   * Builds a behavioural-features-only prompt.
   *
   * Design decisions:
   * - Raw answer text is NEVER included — the TEE receives only derived
   *   numeric features, so no PII is exposed inside the enclave.
   * - Scoring weights are sent explicitly so the model can apply them
   *   consistently regardless of its internal priors.
   * - Historical context, when present, lets the TEE calibrate the score
   *   against the respondent's past behaviour (cross-survey baseline).
   */
  private buildPrompt(features: InferenceFeatures): string {
    return JSON.stringify({
      task: 'survey_quality_scoring',
      scoring_weights: {
        time_consistency: W_TIME,
        pattern_consistency: W_PATTERN,
        contradiction_consistency: W_CONTRADICTION,
        semantic_consistency: W_SEMANTIC,
      },
      instruction:
        'You are a survey quality scoring model running inside a Trusted Execution ' +
        'Environment (TEE). Analyse the respondent\'s behavioural feature vector and, ' +
        'if provided, their historical profile. Compute a quality score 0–100 ' +
        '(integer; higher = more human-like and consistent). Apply the scoring_weights ' +
        'to each dimension. Respond ONLY with a JSON object having these keys: ' +
        '{ "score": <int>, "attestation": <hex>, "modelHash": <string>, "nodePublicKey": <string> }.',
      current_survey: {
        timeDeltas: features.timeDeltas,
        avgTimeMs: features.avgTimeMs,
        cvTime: features.cvTime,
        choiceEntropy: features.choiceEntropy,
        contradictionConsistency: features.contradictionConsistency,
        contradictionPairCount: features.contradictionPairCount,
        textLengths: features.textLengths,
        textCharDiversity: features.textCharDiversity,
        questionCount: features.questionCount,
        choiceQuestionCount: features.choiceQuestionCount,
        textQuestionCount: features.textQuestionCount,
      },
      // null when respondent has no prior history — the TEE must handle both cases
      historical_context: features.historicalContext ?? null,
    });
  }

  private validateFeatures(features: InferenceFeatures): void {
    if (!features) throw new Error('runQualityScoring: features is null or undefined');

    if (!Array.isArray(features.timeDeltas)) {
      throw new Error('runQualityScoring: features.timeDeltas must be an array');
    }
    if (!Number.isFinite(features.avgTimeMs) || features.avgTimeMs < 0) {
      throw new Error(
        'runQualityScoring: features.avgTimeMs must be a non-negative finite number',
      );
    }
    if (!Number.isFinite(features.cvTime) || features.cvTime < 0) {
      throw new Error(
        'runQualityScoring: features.cvTime must be a non-negative finite number',
      );
    }
    if (
      !Number.isFinite(features.choiceEntropy) ||
      features.choiceEntropy < 0 ||
      features.choiceEntropy > 1
    ) {
      throw new Error('runQualityScoring: features.choiceEntropy must be in [0, 1]');
    }
    if (
      !Number.isFinite(features.contradictionConsistency) ||
      features.contradictionConsistency < 0 ||
      features.contradictionConsistency > 1
    ) {
      throw new Error(
        'runQualityScoring: features.contradictionConsistency must be in [0, 1]',
      );
    }
    if (
      !Number.isInteger(features.contradictionPairCount) ||
      features.contradictionPairCount < 0
    ) {
      throw new Error(
        'runQualityScoring: features.contradictionPairCount must be a non-negative integer',
      );
    }
    if (!Array.isArray(features.textLengths)) {
      throw new Error('runQualityScoring: features.textLengths must be an array');
    }
    if (!Array.isArray(features.textCharDiversity)) {
      throw new Error(
        'runQualityScoring: features.textCharDiversity must be an array',
      );
    }
    if (features.textLengths.length !== features.textCharDiversity.length) {
      throw new Error(
        'runQualityScoring: textLengths and textCharDiversity must have the same length',
      );
    }
    if (!Number.isInteger(features.questionCount) || features.questionCount <= 0) {
      throw new Error(
        'runQualityScoring: features.questionCount must be a positive integer',
      );
    }
    if (
      !Number.isInteger(features.choiceQuestionCount) ||
      features.choiceQuestionCount < 0
    ) {
      throw new Error(
        'runQualityScoring: features.choiceQuestionCount must be a non-negative integer',
      );
    }
    if (
      !Number.isInteger(features.textQuestionCount) ||
      features.textQuestionCount < 0
    ) {
      throw new Error(
        'runQualityScoring: features.textQuestionCount must be a non-negative integer',
      );
    }
    if (
      features.choiceQuestionCount + features.textQuestionCount >
      features.questionCount
    ) {
      throw new Error(
        'runQualityScoring: choiceQuestionCount + textQuestionCount cannot exceed questionCount',
      );
    }

    // Validate optional historical context if present
    if (features.historicalContext !== undefined) {
      const hc = features.historicalContext;
      if (!Number.isInteger(hc.patternCount) || hc.patternCount <= 0) {
        throw new Error(
          'runQualityScoring: historicalContext.patternCount must be a positive integer',
        );
      }
      if (
        !Number.isFinite(hc.avgFinalScore) ||
        hc.avgFinalScore < 0 ||
        hc.avgFinalScore > 100
      ) {
        throw new Error(
          'runQualityScoring: historicalContext.avgFinalScore must be in [0, 100]',
        );
      }
      if (!Number.isFinite(hc.avgTimeMs) || hc.avgTimeMs < 0) {
        throw new Error(
          'runQualityScoring: historicalContext.avgTimeMs must be a non-negative number',
        );
      }
      if (
        !Number.isFinite(hc.avgChoiceEntropy) ||
        hc.avgChoiceEntropy < 0 ||
        hc.avgChoiceEntropy > 1
      ) {
        throw new Error(
          'runQualityScoring: historicalContext.avgChoiceEntropy must be in [0, 1]',
        );
      }
      if (
        !Number.isFinite(hc.avgContradictionConsistency) ||
        hc.avgContradictionConsistency < 0 ||
        hc.avgContradictionConsistency > 1
      ) {
        throw new Error(
          'runQualityScoring: historicalContext.avgContradictionConsistency must be in [0, 1]',
        );
      }
    }
  }
}
