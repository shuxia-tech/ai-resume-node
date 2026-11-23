import { describe, expect, it } from 'vitest';
import {
  extendExpiry,
  shouldImportAttempt,
  wrongQuestionIds,
} from '@/modules/xingce/xingce-rules.js';

describe('xingce rules', () => {
  it('extends membership from the later of now and the current expiry', () => {
    const now = new Date('2026-11-23T00:00:00.000Z');
    const future = new Date('2026-11-24T00:00:00.000Z');
    expect(extendExpiry(null, now, 1).toISOString()).toBe('2026-11-24T00:00:00.000Z');
    expect(extendExpiry(future, now, 1).toISOString()).toBe('2026-11-25T00:00:00.000Z');
    expect(extendExpiry(new Date('2026-11-01T00:00:00.000Z'), now, 3).toISOString()).toBe(
      '2026-11-26T00:00:00.000Z',
    );
  });

  it('treats only the latest attempt as the wrong-question source', () => {
    expect(
      wrongQuestionIds([
        { questionId: 'a', correct: false, at: '2026-11-01' },
        { questionId: 'a', correct: true, at: '2026-11-02' },
        { questionId: 'b', correct: true, at: '2026-11-01' },
        { questionId: 'b', correct: false, at: '2026-11-03' },
      ]),
    ).toEqual(['b']);
  });

  it('does not replace a newer server attempt with an older local one', () => {
    expect(shouldImportAttempt('2026-11-02', '2026-11-01')).toBe(false);
    expect(shouldImportAttempt('2026-11-01', '2026-11-02')).toBe(true);
    expect(shouldImportAttempt(undefined, '2026-11-02')).toBe(true);
  });
});
