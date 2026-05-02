import { ethers } from 'ethers';

export function normalizeEnsName(name: string): string {
  return name.trim().toLowerCase();
}

export function ensNode(name: string): string {
  return ethers.namehash(normalizeEnsName(name));
}

export function formatEnsNode(name: string): `0x${string}` {
  return ensNode(name) as `0x${string}`;
}

export function isValidEnsName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n.includes('.') && n.endsWith('.eth') && n.length > 4;
}

const ENS_TEXT_KEYS = {
  deadline:    'survey.deadline',
  title:       'survey.title',
  status:      'survey.status',
  minScore:    'survey.min.score',
  questionCID: 'survey.question.cid',
} as const;

export async function readSurveyTextRecords(
  ensName: string,
  provider: ethers.Provider,
): Promise<{
  deadline: number | null;
  title: string | null;
  status: string | null;
  minScore: number | null;
  questionCID: string | null;
}> {
  const resolver = await provider.getResolver(normalizeEnsName(ensName));
  if (!resolver) return { deadline: null, title: null, status: null, minScore: null, questionCID: null };

  const [deadlineRaw, title, status, minScoreRaw, questionCID] = await Promise.all([
    resolver.getText(ENS_TEXT_KEYS.deadline).catch(() => null),
    resolver.getText(ENS_TEXT_KEYS.title).catch(() => null),
    resolver.getText(ENS_TEXT_KEYS.status).catch(() => null),
    resolver.getText(ENS_TEXT_KEYS.minScore).catch(() => null),
    resolver.getText(ENS_TEXT_KEYS.questionCID).catch(() => null),
  ]);

  return {
    deadline:   deadlineRaw ? parseInt(deadlineRaw, 10) || null : null,
    title,
    status,
    minScore:   minScoreRaw ? parseInt(minScoreRaw, 10) || null : null,
    questionCID,
  };
}

export function deadlineLabel(deadlineTs: number): { text: string; expired: boolean } {
  const now = Math.floor(Date.now() / 1000);
  const diff = deadlineTs - now;
  if (diff <= 0) return { text: 'Expired', expired: true };
  if (diff < 3600) return { text: `${Math.floor(diff / 60)}m left`, expired: false };
  if (diff < 86400) return { text: `${Math.floor(diff / 3600)}h left`, expired: false };
  return { text: `${Math.floor(diff / 86400)}d left`, expired: false };
}
