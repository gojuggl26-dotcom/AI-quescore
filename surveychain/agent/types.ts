// ─── Core domain types ────────────────────────────────────────────────────────

export type HexString = `0x${string}`;

export type QuestionType =
  | 'single_choice'
  | 'multiple_choice'
  | 'scale'
  | 'text'
  | 'contradiction';

export interface QuestionAnswer {
  questionId: string;
  type: QuestionType;
  /**
   * Selected choice indices (0-based).
   * single_choice / scale: length === 1
   * multiple_choice: length >= 1
   */
  choices?: number[];
  /** Free text response. Present when type === 'text'. */
  text?: string;
  /**
   * Shared key that links exactly two questions into a contradiction pair.
   * Present when type === 'contradiction'.
   */
  contradictionPairId?: string;
  /** Total number of options for this question (required for consistency checks). */
  totalChoices?: number;
}

export interface AnswerData {
  /** bytes32 survey namehash (viem namehash output). */
  ensNode: HexString;
  /** Wallet address of the respondent. */
  respondent: HexString;
  answers: QuestionAnswer[];
  /**
   * Unix epoch milliseconds, parallel array to answers[].
   * timestamps[i] = when answers[i] was submitted by the user.
   * Must be monotonically non-decreasing.
   */
  timestamps: number[];
  /** 0G Storage root hash of the encrypted answer payload uploaded prior to scoring. */
  cid: string;
}

// ─── Scoring types ────────────────────────────────────────────────────────────

export interface ScoreBreakdown {
  /** Speed and naturalness of response timing. Weight: 30 %. */
  timeConsistency: number;
  /** Shannon entropy of selected choice positions. Weight: 30 %. */
  patternConsistency: number;
  /** Fraction of logically consistent contradiction pairs. Weight: 25 %. */
  contradictionConsistency: number;
  /**
   * Semantic quality of free-text answers estimated locally.
   * The TEE's sealed inference is authoritative; this is informational only.
   * Weight: 15 %.
   */
  semanticConsistency: number;
  /**
   * Weighted composite of the four sub-scores (informational).
   * TEE score in SealedInferenceResult is the authoritative value.
   */
  composite: number;
}

// ─── Historical context ───────────────────────────────────────────────────────

/**
 * Cross-survey behavioural baseline derived from the respondent's past
 * patterns stored in 0G Storage.  Sent to the TEE alongside current features
 * so the model can calibrate against the respondent's historical profile.
 */
export interface HistoricalContext {
  /** Number of previously scored surveys for this respondent. */
  patternCount: number;
  /** Mean final TEE score across all previous surveys. */
  avgFinalScore: number;
  /** Mean response time across all previous surveys (ms). */
  avgTimeMs: number;
  /** Mean normalised choice entropy across all previous surveys. */
  avgChoiceEntropy: number;
  /** Mean contradiction consistency across all previous surveys. */
  avgContradictionConsistency: number;
  /** Unix timestamp of the most recent stored pattern. */
  latestStoredAt: number;
}

// ─── Inference types ──────────────────────────────────────────────────────────

/**
 * Behavioral feature vector extracted locally and sent (encrypted) to the
 * 0G Compute TEE. Raw answer content is never included.
 */
export interface InferenceFeatures {
  /** Milliseconds between consecutive answer submissions. */
  timeDeltas: number[];
  /** Arithmetic mean of timeDeltas. */
  avgTimeMs: number;
  /** Coefficient of variation of timeDeltas (stdDev / mean). */
  cvTime: number;
  /** Normalized Shannon entropy of selected choice indices in [0, 1]. */
  choiceEntropy: number;
  /** Fraction of contradiction question pairs answered consistently in [0, 1]. */
  contradictionConsistency: number;
  /** Number of contradiction question pairs evaluated. */
  contradictionPairCount: number;
  /** Character count per free-text answer. */
  textLengths: number[];
  /** Unique-character-to-total-character ratio per free-text answer. */
  textCharDiversity: number[];
  questionCount: number;
  choiceQuestionCount: number;
  textQuestionCount: number;
  /**
   * Historical profile loaded from 0G Storage.
   * Absent when the respondent has no prior survey history.
   */
  historicalContext?: HistoricalContext;
}

export interface SealedInferenceResult {
  /** Final quality score 0–100, integer, computed inside TEE. Authoritative. */
  score: number;
  /** 65-byte ECDSA signature produced by the TEE's signing key (ZG_ATTESTATION_SIGNER). */
  attestation: HexString;
  /** Hash of the model weights used (model integrity guarantee). */
  modelHash: string;
  /** Public key of the TEE compute node. */
  nodePublicKey: string;
}

// ─── Contract submission types ────────────────────────────────────────────────

/** Parameters for SurveyReward.submitAnswer(). */
export interface SubmitAnswerPayload {
  ensNode: HexString;
  answerCID: string;
  /** uint8: 0–100. */
  qualityScore: number;
  /** 65-byte ECDSA signature for on-chain verification against ZG_ATTESTATION_SIGNER. */
  attestation: HexString;
}

// ─── Memory types ─────────────────────────────────────────────────────────────

/** Persisted to 0G Storage for cross-survey scoring calibration. */
export interface HistoricalPattern {
  ensNode: string;
  respondent: string;
  avgTimeMs: number;
  choiceEntropy: number;
  contradictionConsistency: number;
  finalScore: number;
  storedAt: number;
}

// ─── Agent configuration ──────────────────────────────────────────────────────

export interface AgentConfig {
  /** 0G Storage indexer RPC endpoint. */
  zgStorageUrl: string;
  /** 0G Storage Flow contract address on the target chain. */
  zgFlowAddress: string;
  /** 0G Compute network broker endpoint. */
  zgComputeUrl: string;
  /** EVM-compatible JSON-RPC URL used for transaction signing. */
  evmRpcUrl: string;
  /** Agent wallet private key (pays for 0G Storage / Compute operations). */
  privateKey: HexString;
  /** Primary inference model identifier. */
  modelName: string;
  /** Fallback model used when the primary is unavailable. */
  fallbackModelName: string;
  /**
   * Expected hash of the primary model weights.
   * The TEE includes this in the attestation; we verify client-side
   * before trusting the score.
   */
  modelHash: string;
  /** 0G Compute TEE node's public key for local pre-verification. */
  nodePublicKey: string;
  /**
   * Root hash (CID) of the encrypted pattern index stored in 0G Storage.
   * Undefined on the very first run.  After each execute() call, retrieve
   * the updated value via agent.getIndexCid() and persist it for the next run.
   */
  indexCid?: string;
}

// ─── OpenClaw agent interface ─────────────────────────────────────────────────

/**
 * Minimal OpenClaw-compatible agent interface.
 * Implementing this allows the agent to be registered in the
 * 0G OpenClaw agent framework without further changes.
 */
export interface IOpenClawAgent<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  execute(input: TInput): Promise<TOutput>;
  getCapabilities(): string[];
}

export interface AgentInput {
  answerData: AnswerData;
}

export interface AgentOutput {
  /** Ready to pass directly to SurveyReward.submitAnswer(). */
  payload: SubmitAnswerPayload;
  /** Local score breakdown for logging and UI transparency. */
  breakdown: ScoreBreakdown;
  /** Raw TEE response including attestation and model metadata. */
  inferenceResult: SealedInferenceResult;
  /**
   * Updated index CID after persisting the new historical pattern.
   * Persist this value and pass it as config.indexCid on the next run.
   * Null if the pattern persistence failed (non-fatal; scoring result is still valid).
   */
  updatedIndexCid: string | null;
}
