import { describe, expect, it } from 'vitest';
import { AppError } from '@/common/errors.js';
import { MAX_IMPORT_RECORDS, planImport } from '@/modules/xingce/xingce-import.js';

describe('xingce import', () => {
  it('reads a question bank slice and keeps drafts out of the published status', () => {
    const plan = planImport({
      batch: { id: 'zhiding-iq-202607' },
      questions: [
        {
          id: 'demo-1',
          category: '数量关系',
          type: 'single',
          stem: '1+1 等于几？',
          options: { A: '1', B: '2' },
          answer: 'b',
          status: 'published',
        },
      ],
      drafts: [{ id: 'draft-1', stem: '待校对', options: { A: '甲' } }],
    });
    expect(plan.kind).toBe('questions');
    expect(plan.batchId).toBe('zhiding-iq-202607');
    expect(plan.questions[0]?.answer).toBe('B');
    expect(plan.questions[0]?.batchId).toBe('zhiding-iq-202607');
    expect(plan.questions[1]?.status).toBe('draft');
  });

  it('recognizes interview and daily collections', () => {
    expect(
      planImport({
        collection: 'interviews',
        entries: [{ id: 'library-001', title: '美团面经', company: '美团', rounds: [] }],
      }).kind,
    ).toBe('interviews');
    expect(
      planImport({
        collection: 'dailyQuestions',
        entries: [{ id: 'daily-1', question: '怎么排优先级？', topic: '产品', sections: [] }],
      }).daily[0]?.topic,
    ).toBe('产品');
  });

  it('rejects a file larger than the sample limit', () => {
    const questions = Array.from({ length: MAX_IMPORT_RECORDS + 1 }, (_, index) => ({
      id: `q-${index}`,
      stem: '题干',
    }));
    expect(() => planImport({ questions })).toThrow(AppError);
    expect(planImport({ questions }, { maxRecords: questions.length }).questions).toHaveLength(
      questions.length,
    );
  });
});
