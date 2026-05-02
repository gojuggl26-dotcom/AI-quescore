import type { AnswerData } from '@agent/types';

export interface UploadAnswerResult {
  cid: string;
}

export async function uploadAnswerData(
  answerData: AnswerData,
  respondent: string,
): Promise<UploadAnswerResult> {
  const res = await fetch('/api/storage/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answerData, respondent }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? 'Upload failed');
  }
  return res.json() as Promise<UploadAnswerResult>;
}

export interface QuestionItem {
  id: string;
  type: 'single_choice' | 'multiple_choice' | 'scale' | 'text' | 'contradiction';
  text: string;
  options?: string[];
  contradictionPairId?: string;
}

export async function fetchQuestions(questionCID: string): Promise<QuestionItem[]> {
  const res = await fetch(`/api/storage/questions?cid=${encodeURIComponent(questionCID)}`);
  if (!res.ok) throw new Error('Failed to load survey questions');
  return res.json() as Promise<QuestionItem[]>;
}

export async function uploadQuestions(
  questions: QuestionItem[],
  creatorAddress: string,
): Promise<string> {
  const res = await fetch('/api/storage/upload-questions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questions, creatorAddress }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? 'Question upload failed');
  }
  const data = await res.json() as { cid: string };
  return data.cid;
}
