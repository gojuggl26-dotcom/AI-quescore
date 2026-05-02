import type { AnswerData, SubmitAnswerPayload, ScoreBreakdown } from '@agent/types';

export interface ScoreResult {
  payload: SubmitAnswerPayload;
  breakdown: ScoreBreakdown;
  updatedIndexCid: string | null;
}

export async function scoreAnswers(
  answerData: AnswerData,
  respondent: string,
): Promise<ScoreResult> {
  const res = await fetch('/api/score', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answerData, respondent }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? 'Scoring failed');
  }
  return res.json() as Promise<ScoreResult>;
}
