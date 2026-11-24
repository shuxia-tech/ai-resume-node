import { AppError } from '@/common/errors.js';

export const MAX_IMPORT_RECORDS = 30;

export type ImportOptions = {
  maxRecords?: number;
  validatePublication?: boolean;
};

const idPattern = /^[\w.-]{1,160}$/;

export type QuestionDraft = {
  id: string;
  batchId: string;
  category: string;
  questionType: string;
  stem: string;
  optionsJson: string;
  answer: string;
  analysis: string;
  status: string;
  source: string;
  imageJson: string;
  payloadJson: string;
};

export type InterviewDraft = {
  id: string;
  title: string;
  company: string;
  role: string;
  recruitment: string;
  status: string;
  payloadJson: string;
};

export type DailyDraft = {
  id: string;
  topic: string;
  question: string;
  publishedDate: string;
  payloadJson: string;
};

export type ImportPlan = {
  kind: 'questions' | 'interviews' | 'daily';
  batchId: string;
  questions: QuestionDraft[];
  interviews: InterviewDraft[];
  daily: DailyDraft[];
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(400, '导入文件必须是 JSON 对象');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, max = 20_000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function identifier(value: unknown, label: string) {
  const id = text(value, 160);
  if (!idPattern.test(id)) throw new AppError(400, `${label} 缺少有效 ID`);
  return id;
}

function addImage(images: string[], value: unknown) {
  const image = text(value, 2000);
  if (image) images.push(image);
}

export function imagesOf(raw: Record<string, unknown>) {
  const images: string[] = [];
  addImage(images, raw.stemImage);
  addImage(images, raw.sourceImage);
  if (Array.isArray(raw.sourceImages)) {
    for (const value of raw.sourceImages) addImage(images, value);
  }
  const optionImages = raw.optionImages;
  if (optionImages && typeof optionImages === 'object' && !Array.isArray(optionImages)) {
    for (const value of Object.values(optionImages)) addImage(images, value);
  }
  const vector = raw.vectorAssets;
  if (vector && typeof vector === 'object' && !Array.isArray(vector)) {
    const assets = vector as Record<string, unknown>;
    addImage(images, assets.stem);
    if (assets.options && typeof assets.options === 'object' && !Array.isArray(assets.options)) {
      for (const value of Object.values(assets.options)) addImage(images, value);
    }
  }
  return images;
}

function questionStatus(raw: Record<string, unknown>, fallback: string) {
  const status = text(raw.status, 20);
  if (['published', 'draft', 'withdrawn', 'reference'].includes(status)) return status;
  return fallback;
}

function toQuestion(
  raw: Record<string, unknown>,
  batchId: string,
  fallbackStatus: string,
  batchTitle: string,
  validatePublication: boolean,
): QuestionDraft {
  const stem = text(raw.stem || raw.text || raw.title || raw.prompt || raw.transcript, 200_000);
  const options = raw.options && typeof raw.options === 'object' ? raw.options : {};
  const questionBatch = text(raw.batchId, 80) || batchId;
  const category = text(raw.category, 40);
  const answer = text(raw.answer, 8).toUpperCase();
  let status = questionStatus(raw, fallbackStatus);
  if (validatePublication && status === 'published') {
    const optionImages = raw.optionImages && typeof raw.optionImages === 'object' ? raw.optionImages : {};
    const validKeys = Object.keys({ ...options, ...optionImages }).filter((key) =>
      /^[A-H]$/.test(key) && ((options as Record<string, unknown>)[key] || (optionImages as Record<string, unknown>)[key] || raw.stemImage),
    );
    if (!stem || !category || validKeys.length < 2 || !validKeys.includes(answer) || raw.reviewRequired === true) status = 'draft';
  }
  if (!stem && status !== 'draft') throw new AppError(400, '题目缺少题干');
  const payload = batchTitle && questionBatch === batchId ? { ...raw, batchTitle } : raw;
  return {
    id: identifier(raw.id, '题目'),
    batchId: questionBatch,
    category,
    questionType: text(raw.type, 20) || 'single',
    stem,
    optionsJson: JSON.stringify(options),
    answer,
    analysis: text(raw.analysis, 200_000),
    status,
    source: text(raw.source, 500),
    imageJson: JSON.stringify(imagesOf(raw)),
    payloadJson: JSON.stringify(validatePublication ? { ...payload, status } : payload),
  };
}

function toInterview(raw: Record<string, unknown>): InterviewDraft {
  const title = text(raw.title, 300);
  if (!title) throw new AppError(400, '面经缺少标题');
  return {
    id: identifier(raw.id, '面经'),
    title,
    company: text(raw.company, 120),
    role: text(raw.role, 120),
    recruitment: text(raw.recruitment, 40),
    status: questionStatus(raw, 'published'),
    payloadJson: JSON.stringify(raw),
  };
}

function toDaily(raw: Record<string, unknown>): DailyDraft {
  const question = text(raw.question, 20_000);
  if (!question) throw new AppError(400, '每日一问缺少问题');
  return {
    id: identifier(raw.id, '每日一问'),
    topic: text(raw.topic, 80),
    question,
    publishedDate: text(raw.publishedDate, 20),
    payloadJson: JSON.stringify(raw),
  };
}

function listOf(value: unknown) {
  return Array.isArray(value) ? value : [];
}

export function planImport(payload: unknown, options: ImportOptions = {}): ImportPlan {
  const body = record(payload);
  const batch = record(body.batch ?? {});
  const batchId = text(batch.id || body.batchId, 80) || 'manual';
  const batchTitle = text(batch.title, 300);
  const collection = text(body.collection, 40);
  const entries = listOf(body.entries).map(record);
  const empty = { batchId, questions: [], interviews: [], daily: [] };
  const maxRecords = options.maxRecords ?? MAX_IMPORT_RECORDS;

  if (collection === 'interviews' || (entries[0] && 'rounds' in entries[0])) {
    const interviews = entries.map(toInterview);
    assertCount(interviews.length, maxRecords);
    return { ...empty, kind: 'interviews', interviews };
  }
  if (collection === 'dailyQuestions' || (entries[0] && 'sections' in entries[0])) {
    const daily = entries.map(toDaily);
    assertCount(daily.length, maxRecords);
    return { ...empty, kind: 'daily', daily };
  }

  const questions = [
    ...listOf(body.questions).map((item) => toQuestion(record(item), batchId, 'published', batchTitle, options.validatePublication ?? false)),
    ...listOf(body.drafts).map((item) => toQuestion(record(item), batchId, 'draft', batchTitle, options.validatePublication ?? false)),
    ...listOf(body.references).map((item) => toQuestion(record(item), batchId, 'reference', batchTitle, options.validatePublication ?? false)),
  ];
  assertCount(questions.length, maxRecords);
  return { ...empty, kind: 'questions', questions };
}

function assertCount(count: number, maxRecords: number) {
  if (count < 1) throw new AppError(400, '文件里没有可导入的记录');
  if (count > maxRecords) {
    throw new AppError(400, `单次最多导入 ${maxRecords} 条`);
  }
}
