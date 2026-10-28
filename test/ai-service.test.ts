import { describe, expect, it } from 'vitest';
import { parseJsonOrText, sanitizeAiHtml } from '@/modules/ai/ai-service.js';

describe('ai service safety helpers', () => {
  it('parses fenced JSON returned by a model', () => {
    expect(parseJsonOrText('```json\n[{"moduleType":"基本信息"}]\n```')).toEqual([
      { moduleType: '基本信息' },
    ]);
  });

  it('extracts a JSON array that follows a prose preface', () => {
    expect(parseJsonOrText('整理如下：\n[{"moduleType":"基本信息"}]\n以上是结果')).toEqual([
      { moduleType: '基本信息' },
    ]);
  });

  it('keeps ordinary text when no JSON payload exists', () => {
    expect(parseJsonOrText('无法识别这份简历')).toBe('无法识别这份简历');
  });

  it('removes executable HTML from optimization output while retaining safe markup', () => {
    expect(
      sanitizeAiHtml('<h3>建议</h3><p onclick="alert(1)">内容</p><script>alert(2)</script>'),
    ).toBe('<h3>建议</h3><p>内容</p>');
  });
});
