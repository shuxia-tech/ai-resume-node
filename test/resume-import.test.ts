import { describe, expect, it } from 'vitest';
import { AppError } from '@/common/errors.js';
import { IMPORT_MODULE_SLOTS, parseImportedModules } from '@/modules/ai/resume-import.js';

describe('resume import parsing', () => {
  it('accepts a modules wrapper and maps Chinese fields onto editor keys', () => {
    const modules = parseImportedModules(
      JSON.stringify({
        modules: [
          {
            moduleType: '基本信息',
            moduleContent: { 姓名: '张伟', 电话: '13800001111', 政治面貌: '中共党员' },
          },
          {
            moduleType: '教育经历',
            moduleContent: { 教育经历: [{ 学校: '浙江大学', 专业: '计算机' }] },
          },
          { moduleType: '个人总结', moduleContent: { 总结: '五年前端经验' } },
          { moduleType: '实习经历', moduleContent: [{ 公司: '星云科技', 职位: '前端' }] },
        ],
      }),
    );

    expect(JSON.parse(modules.find((item) => item.moduleType === '基本信息')?.moduleContent ?? '')).toMatchObject({
      name: '张伟',
      phone: '13800001111',
      politicalOutlook: '党员',
    });
    expect(JSON.parse(modules.find((item) => item.moduleType === '教育经历')?.moduleContent ?? '')).toEqual([
      { school: '浙江大学', profession: '计算机' },
    ]);
    expect(modules.map((item) => item.moduleType)).toEqual(['基本信息', '教育经历', '个人优势', '工作经历']);
  });

  it('places research, honors, and campus experience on the editor display orders', () => {
    expect(IMPORT_MODULE_SLOTS.find((slot) => slot.moduleType === '研究经历')?.displayOrder).toBe(6);
    expect(IMPORT_MODULE_SLOTS.find((slot) => slot.moduleType === '荣誉奖项')?.displayOrder).toBe(7);
    expect(IMPORT_MODULE_SLOTS.find((slot) => slot.moduleType === '校园经历')?.displayOrder).toBe(11);
    expect(IMPORT_MODULE_SLOTS.find((slot) => slot.moduleType === '个人优势')?.displayOrder).toBe(10);
  });

  it('rejects a reply that does not contain resume modules', () => {
    expect(() => parseImportedModules('这段简历无法识别，请重新上传。')).toThrow(AppError);
  });
});
