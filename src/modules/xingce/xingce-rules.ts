import { createHash } from 'node:crypto';

export const DAY_MS = 24 * 60 * 60 * 1000;

export function extendExpiry(current: Date | null, now: Date, days: number) {
  const base = current && current.getTime() > now.getTime() ? current.getTime() : now.getTime();
  return new Date(base + days * DAY_MS);
}

export function questionVersion(row: {
  stem: string;
  optionsJson: string | null;
  answer: string;
  analysis: string | null;
  category: string;
  status: string;
}) {
  return createHash('sha256')
    .update(
      JSON.stringify([row.stem, row.optionsJson, row.answer, row.analysis, row.category, row.status]),
    )
    .digest('hex');
}

export function latestResults(
  attempts: { questionId: string; correct: boolean; at: string }[],
) {
  const ordered = [...attempts].sort((a, b) => a.at.localeCompare(b.at));
  const latest = new Map<string, boolean>();
  for (const attempt of ordered) latest.set(attempt.questionId, attempt.correct);
  return latest;
}

export function wrongQuestionIds(
  attempts: { questionId: string; correct: boolean; at: string }[],
) {
  return [...latestResults(attempts)].filter(([, correct]) => !correct).map(([id]) => id);
}

export function shouldImportAttempt(
  serverAt: string | undefined,
  importedAt: string,
) {
  if (!serverAt) return true;
  return importedAt > serverAt;
}
