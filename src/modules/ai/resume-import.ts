import { AppError } from '@/common/errors.js';
import { parseJsonOrText } from '@/modules/ai/ai-service.js';

export const IMPORT_MODULE_SLOTS = [
  { moduleType: '基本信息', displayOrder: 1 },
  { moduleType: '专业技能', displayOrder: 2 },
  { moduleType: '教育经历', displayOrder: 3 },
  { moduleType: '工作经历', displayOrder: 4 },
  { moduleType: '项目经历', displayOrder: 5 },
  { moduleType: '研究经历', displayOrder: 6 },
  { moduleType: '荣誉奖项', displayOrder: 7 },
  { moduleType: '作品集', displayOrder: 8 },
  { moduleType: '其他经历', displayOrder: 9 },
  { moduleType: '个人优势', displayOrder: 10 },
  { moduleType: '校园经历', displayOrder: 11 },
] as const;

const ARRAY_MODULE_TYPES = new Set<string>([
  '教育经历',
  '工作经历',
  '项目经历',
  '研究经历',
  '荣誉奖项',
  '作品集',
  '其他经历',
  '校园经历',
]);

const MODULE_ALIASES: Record<string, string> = {
  个人信息: '基本信息',
  教育背景: '教育经历',
  学习经历: '教育经历',
  工作经验: '工作经历',
  实习经历: '工作经历',
  项目经验: '项目经历',
  科研经历: '研究经历',
  课题经历: '研究经历',
  荣誉: '荣誉奖项',
  校园活动: '校园经历',
  在校经历: '校园经历',
  学生会: '校园经历',
  个人总结: '个人优势',
  自我评价: '个人优势',
};

const FIELD_ALIASES: Record<string, string> = {
  姓名: 'name',
  电话: 'phone',
  手机: 'phone',
  邮箱: 'email',
  年龄: 'age',
  性别: 'gender',
  政治面貌: 'politicalOutlook',
  现居: 'currentCity',
  当前城市: 'currentCity',
  所在城市: 'currentCity',
  目标城市: 'targetCity',
  期望城市: 'targetCity',
  求职意向: 'targetPosition',
  目标职位: 'targetPosition',
  期望职位: 'targetPosition',
  期望薪资: 'targetSalary',
  学校: 'school',
  学校名称: 'school',
  专业: 'profession',
  专业名称: 'profession',
  学历: 'degree',
  学位: 'degree',
  公司: 'company',
  公司名称: 'company',
  职位: 'position',
  职位名称: 'position',
  城市: 'city',
  项目名称: 'name',
  奖项: 'name',
  奖项名称: 'name',
  角色: 'role',
  担任角色: 'role',
  职务: 'role',
  开始时间: 'startTime',
  结束时间: 'endTime',
  时间: 'time',
  描述: 'description',
  工作描述: 'description',
  项目描述: 'description',
  技能: 'description',
  总结: 'description',
  个人优势: 'description',
  链接: 'url',
  作品链接: 'url',
};

export function buildResumeImportPrompt(text: string) {
  const moduleTypes = IMPORT_MODULE_SLOTS.map((slot) => slot.moduleType).join('、');
  return `你是简历解析器。只输出 JSON 数组，不要解释，不要使用 Markdown。
每项为 {"moduleType":"模块名","moduleContent":内容}。moduleType 只能是：${moduleTypes}。只输出原文里存在的模块。
基本信息、专业技能、个人优势的 moduleContent 是对象。其余模块的 moduleContent 是数组。
基本信息字段使用 name、phone、email、age、gender、politicalOutlook、currentCity、targetCity、currentStatus、targetPosition、targetSalary。政治面貌写入 politicalOutlook，中共党员写成党员。
专业技能和个人优势使用 description，内容用纯文本。
教育经历项使用 school、profession、degree、startTime、endTime、description。
工作经历项使用 company、position、city、startTime、endTime、description，实习也放在工作经历。
项目经历和校园经历项使用 name、role、startTime、endTime、description。学生会、社团、团委放入校园经历，不要放入其他经历。
研究经历项使用 projectName、role、section、address、startTime、endTime、description。
荣誉奖项项使用 name、time。作品集项使用 name、url、description。
其他经历项使用 name、role、section、address、startTime、endTime、description。
日期使用 YYYY-MM。没有的信息留空字符串，不要编造。

简历原文：
${text}`;
}

export function parseImportedModules(answer: string) {
  const items = moduleItems(parseJsonOrText(answer));
  const merged = new Map<string, unknown>();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const moduleType = canonicalModuleType(record.moduleType);
    if (!moduleType) continue;
    const content = normalizeModuleContent(moduleType, record.moduleContent ?? record);
    if (!hasContent(content)) continue;
    const current = merged.get(moduleType);
    merged.set(moduleType, current === undefined ? content : mergeContent(moduleType, current, content));
  }
  if (!merged.size) throw new AppError(502, 'AI 未返回有效的简历模块 JSON');
  return [...merged.entries()].map(([moduleType, moduleContent]) => ({
    moduleType,
    moduleContent: JSON.stringify(moduleContent),
  }));
}

function moduleItems(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.modules)) return record.modules;
  if (Array.isArray(record.data)) return record.data;
  if (typeof record.moduleType === 'string') return [record];
  return [];
}

function canonicalModuleType(value: unknown) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  const aliased = MODULE_ALIASES[text] ?? text;
  return IMPORT_MODULE_SLOTS.some((slot) => slot.moduleType === aliased) ? aliased : '其他经历';
}

function normalizeModuleContent(moduleType: string, content: unknown) {
  const value = unwrapContent(content);
  const normalized = ARRAY_MODULE_TYPES.has(moduleType)
    ? asArray(value).map(normalizeItem)
    : normalizeItem(asObject(value));
  return stringifyLeaves(normalized);
}

function stringifyLeaves(value: unknown): unknown {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(stringifyLeaves);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, stringifyLeaves(child)]),
    );
  }
  return value;
}

function unwrapContent(content: unknown): unknown {
  if (typeof content !== 'string') return content;
  const parsed = parseJsonOrText(content);
  return typeof parsed === 'string' ? content : parsed;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const nested = Object.values(value as Record<string, unknown>).find(Array.isArray);
    if (Array.isArray(nested)) return nested;
    return [value];
  }
  if (typeof value === 'string' && value.trim()) return [{ description: value.trim() }];
  return [];
}

function asObject(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    const first = value.find((item) => item && typeof item === 'object' && !Array.isArray(item));
    return first && typeof first === 'object' ? (first as Record<string, unknown>) : {};
  }
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string' && value.trim()) return { description: value.trim() };
  return {};
}

function normalizeItem(value: unknown): unknown {
  const renamed = renameKeys(value);
  if (!renamed || typeof renamed !== 'object' || Array.isArray(renamed)) return renamed;
  const record = renamed as Record<string, unknown>;
  if (Array.isArray(record.description)) {
    record.description = record.description.filter((item) => typeof item === 'string').join('\n');
  }
  if (typeof record.politicalOutlook === 'string') {
    record.politicalOutlook = normalizePolitical(record.politicalOutlook);
  }
  return record;
}

function renameKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(renameKeys);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const nextKey = FIELD_ALIASES[key] ?? key;
    const nextValue = renameKeys(child);
    if (!(nextKey in result) || isEmpty(result[nextKey])) result[nextKey] = nextValue;
  }
  return result;
}

function mergeContent(moduleType: string, current: unknown, next: unknown) {
  if (ARRAY_MODULE_TYPES.has(moduleType)) {
    return [...(Array.isArray(current) ? current : []), ...(Array.isArray(next) ? next : [])];
  }
  return {
    ...(current && typeof current === 'object' ? current : {}),
    ...(next && typeof next === 'object' ? next : {}),
  };
}

function hasContent(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some(hasContent);
  if (value && typeof value === 'object') return Object.values(value).some(hasContent);
  return false;
}

function isEmpty(value: unknown) {
  return !hasContent(value);
}

function normalizePolitical(value: string) {
  const text = value.replace(/\s/g, '');
  if (text.includes('预备党员')) return '预备党员';
  if (text.includes('共青团员') || text === '团员') return '共青团员';
  if (/民主党派|民革|民盟|民建|民进|农工党|致公党|九三学社|台盟/.test(text)) return '民主党派';
  if (text.includes('党员') || text.includes('中共')) return '党员';
  if (text.includes('群众')) return '群众';
  return value.trim();
}
