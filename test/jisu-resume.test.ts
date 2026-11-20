import { describe, expect, it } from 'vitest';
import { normalizeJisuResumeContent } from '@/modules/jisu/jisu-resume-routes.js';

describe('jisu resume', () => {
  it('keeps a workspace json object that contains a resumes array', () => {
    const content = '  {"active":"1","resumes":[]}  ';
    expect(normalizeJisuResumeContent(content)).toBe('{"active":"1","resumes":[]}');
  });

  it('rejects an empty, oversized, or malformed workspace', () => {
    expect(() => normalizeJisuResumeContent('   ')).toThrow('简历内容不能为空');
    expect(() => normalizeJisuResumeContent('{"name":"Ada"}')).toThrow('简历内容格式不正确');
    expect(() => normalizeJisuResumeContent('[]')).toThrow('简历内容格式不正确');
    expect(() => normalizeJisuResumeContent(`{"resumes":${'x'.repeat(2 * 1024 * 1024)}}`)).toThrow(
      '简历内容过大',
    );
  });
});
