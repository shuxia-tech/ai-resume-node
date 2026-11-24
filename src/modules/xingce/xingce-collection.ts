import { sql, type Kysely } from 'kysely';
import type { Database } from '@/infrastructure/database.js';

export const COLLECTION_PAGE_SIZE = 60;
export const PRACTICE_GROUP_SIZE = 10;
export const KIND_FILTERS = ['全部', '文字题', '数字图形', '图形选项', '资料分析'] as const;

export type CollectionKind = (typeof KIND_FILTERS)[number] | 'all' | string;

export type CollectionQuery = {
  batchId: string;
  kind?: string;
  page?: number;
  offset?: number;
  limit?: number;
  questionId?: string;
  year?: string;
  region?: string;
  paper?: string;
  module?: string;
  book?: string;
};

export type CollectionPaper = { id: string; title: string; year: string; region: string; questions: string[] };

export type CollectionEntry = {
  id: string;
  category: string;
  stem: string;
  typeName: string;
  tag: string;
  thumbnail: string;
  hasOptionImages: boolean;
  sourceBookId: string;
  page: string;
  kind: string;
  transcript: string;
  status: string;
};

function jsonValue(value: string | null) {
  try {
    return JSON.parse(value || 'null');
  } catch {
    return null;
  }
}

function tagsOf(value: unknown) {
  return Array.isArray(value) ? value.map((tag) => String(tag)) : [];
}

export function questionTypeName(input: {
  category: string;
  civilSource: boolean;
  displayKind: string;
  tags: string[];
}) {
  if (input.civilSource && input.tags.includes('图形推理')) return '图形选项';
  if (input.civilSource && input.displayKind === 'material' && input.category !== '资料分析') return '文字题';
  if (input.displayKind === 'material') return '资料分析';
  if (input.displayKind === 'image-options') return '图形选项';
  if (input.displayKind === 'figure') return '数字图形';
  return '文字题';
}

function matchesKind(type: string, kind: string) {
  if (!kind || kind === 'all' || kind === '全部') return true;
  return type === kind;
}

export async function loadCollectionPapers(db: Kysely<Database>) {
  const rows = await sql<{ id: string; title: string; year: string; region: string; payload_json: string }>`
    SELECT id, title, year, region, payload_json FROM t_xingce_paper ORDER BY year DESC, id ASC
  `.execute(db);
  return rows.rows.map((row) => {
    const payload = jsonValue(row.payload_json) as { questions?: unknown } | null;
    return {
      id: row.id,
      title: row.title,
      year: row.year,
      region: row.region,
      questions: Array.isArray(payload?.questions) ? payload.questions.map((id) => String(id)) : [],
    } satisfies CollectionPaper;
  });
}

async function loadBatchRows(db: Kysely<Database>, batchId: string, status: 'published' | 'reference') {
  const rows = await sql<{
    id: string;
    category: string;
    stem: string;
    status: string;
    display_kind: string | null;
    tags_json: string | null;
    stem_image: string | null;
    option_images: string | null;
    civil_source: string | null;
    source_references: string | null;
    source_book_id: string | null;
    ref_kind: string | null;
    transcript: string | null;
    page: string | null;
  }>`
    SELECT
      id, category, stem, status,
      JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.displayKind')) AS display_kind,
      JSON_EXTRACT(payload_json, '$.tags') AS tags_json,
      JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.stemImage')) AS stem_image,
      JSON_EXTRACT(payload_json, '$.optionImages') AS option_images,
      JSON_EXTRACT(payload_json, '$.civilSource') AS civil_source,
      JSON_EXTRACT(payload_json, '$.sourceReferences') AS source_references,
      JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.sourceBookId')) AS source_book_id,
      JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.kind')) AS ref_kind,
      JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.transcript')) AS transcript,
      JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.page')) AS page
    FROM t_xingce_question
    WHERE delete_flag = 'NOT_DELETE' AND batch_id = ${batchId} AND status = ${status}
    ORDER BY id ASC
  `.execute(db);
  return rows.rows.map((row) => {
    const tags = tagsOf(jsonValue(row.tags_json));
    const optionImages = jsonValue(row.option_images);
    const refs = jsonValue(row.source_references);
    const civilSource = row.civil_source === 'true' || row.civil_source === '1';
    return {
      id: row.id,
      category: row.category,
      stem: row.stem,
      status: row.status,
      typeName: questionTypeName({
        category: row.category,
        civilSource,
        displayKind: row.display_kind || '',
        tags,
      }),
      tag: tags.find((tag) => tag !== '智鼎IQ') || row.category,
      thumbnail: row.stem_image || '',
      hasOptionImages: Boolean(optionImages && typeof optionImages === 'object' && Object.keys(optionImages).length),
      sourceBookId: row.source_book_id || '',
      page: row.page || '',
      kind: row.ref_kind || '',
      transcript: row.transcript || '',
      paperIds: Array.isArray(refs)
        ? refs.map((item) => (item && typeof item === 'object' ? String((item as { paperId?: string }).paperId || '') : '')).filter(Boolean)
        : [],
      modules: Array.isArray(refs)
        ? refs.map((item) => (item && typeof item === 'object' ? String((item as { module?: string }).module || '') : '')).filter(Boolean)
        : [],
    };
  });
}

function allowedPaperIds(papers: CollectionPaper[], query: CollectionQuery) {
  if (!query.year && !query.region && !query.paper) return null;
  return new Set(
    papers
      .filter((paper) => {
        if (query.paper) return paper.id === query.paper;
        if (query.year && paper.year !== query.year) return false;
        if (query.region && paper.region !== query.region) return false;
        return true;
      })
      .map((paper) => paper.id),
  );
}

function filterEntries(
  entries: Awaited<ReturnType<typeof loadBatchRows>>,
  query: CollectionQuery,
  papers: CollectionPaper[],
) {
  const allowed = allowedPaperIds(papers, query);
  const paperOrder =
    query.paper ? new Map((papers.find((paper) => paper.id === query.paper)?.questions || []).map((id, index) => [id, index])) : null;
  let list = entries.filter((entry) => {
    if (query.book && entry.sourceBookId !== query.book) return false;
    if (!matchesKind(entry.typeName, query.kind || '')) return false;
    if (allowed && !entry.paperIds.some((id) => allowed.has(id))) return false;
    if (query.module && !entry.modules.includes(query.module)) return false;
    return true;
  });
  if (paperOrder) list = [...list].sort((a, b) => (paperOrder.get(a.id) ?? 1e9) - (paperOrder.get(b.id) ?? 1e9));
  return list;
}

export async function loadCollection(db: Kysely<Database>, query: CollectionQuery) {
  const batchId = query.batchId;
  const counts = await sql<{ published: number; reference_count: number }>`
    SELECT SUM(status = 'published') AS published, SUM(status = 'reference') AS reference_count
    FROM t_xingce_question
    WHERE delete_flag = 'NOT_DELETE' AND batch_id = ${batchId}
  `.execute(db);
  const published = Number(counts.rows[0]?.published ?? 0);
  const referenceCount = Number(counts.rows[0]?.reference_count ?? 0);
  const referenceOnly = published === 0 && referenceCount > 0;
  const papers = batchId === 'civil-service-2016-2026' ? await loadCollectionPapers(db) : [];
  const entries = await loadBatchRows(db, batchId, referenceOnly ? 'reference' : 'published');
  const unkinded = filterEntries(entries, { ...query, kind: 'all' }, papers);
  const filtered = filterEntries(entries, query, papers);
  const kindCounts: Record<string, number> = { all: unkinded.length };
  for (const name of KIND_FILTERS.slice(1)) {
    kindCounts[name] = unkinded.filter((entry) => entry.typeName === name).length;
  }
  const pageSize = referenceOnly ? 10 : COLLECTION_PAGE_SIZE;
  const page = Math.max(0, query.page ?? 0);
  const start = page * pageSize;
  const shown = filtered.slice(start, start + pageSize).map(({ paperIds, modules, ...entry }) => entry);
  const sources = [...new Set(entries.map((entry) => entry.sourceBookId).filter(Boolean))].map((id) => ({
    id,
    name: id.endsWith('-1') ? '北森题库性格测试（第1套）' : id.endsWith('-2') ? '北森题库性格测试（第2套）' : id,
  }));
  return {
    referenceOnly,
    total: unkinded.length,
    filtered: filtered.length,
    kindCounts,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(filtered.length / pageSize)),
    papers: papers.map(({ questions, ...paper }) => paper),
    sources,
    questions: shown,
    ids: filtered.map((entry) => entry.id),
  };
}

function needsFullCollection(query: CollectionQuery) {
  return Boolean(
    (query.kind && query.kind !== 'all' && query.kind !== '全部') ||
      query.year ||
      query.region ||
      query.paper ||
      query.module ||
      query.book,
  );
}

async function sliceOrderedIds(db: Kysely<Database>, query: CollectionQuery) {
  const batchId = query.batchId;
  const counts = await sql<{ published: number; reference_count: number }>`
    SELECT SUM(status = 'published') AS published, SUM(status = 'reference') AS reference_count
    FROM t_xingce_question
    WHERE delete_flag = 'NOT_DELETE' AND batch_id = ${batchId}
  `.execute(db);
  const published = Number(counts.rows[0]?.published ?? 0);
  const referenceOnly = published === 0 && Number(counts.rows[0]?.reference_count ?? 0) > 0;
  const status = referenceOnly ? 'reference' : 'published';
  const questionId = query.questionId || '';
  const position = await sql<{ total: number; before_count: number; found: number }>`
    SELECT COUNT(*) AS total,
      SUM(id < ${questionId}) AS before_count,
      SUM(id = ${questionId}) AS found
    FROM t_xingce_question
    WHERE delete_flag = 'NOT_DELETE' AND batch_id = ${batchId} AND status = ${status}
  `.execute(db);
  const total = Number(position.rows[0]?.total ?? 0);
  const limit = query.limit ?? PRACTICE_GROUP_SIZE;
  let offset = Math.max(0, query.offset ?? 0);
  if (questionId && Number(position.rows[0]?.found ?? 0) > 0) {
    offset = Math.floor(Number(position.rows[0]?.before_count ?? 0) / PRACTICE_GROUP_SIZE) * PRACTICE_GROUP_SIZE;
  }
  offset = Math.min(offset, Math.max(0, total - (total % limit || limit)));
  const rows = await sql<{ id: string }>`
    SELECT id FROM t_xingce_question
    WHERE delete_flag = 'NOT_DELETE' AND batch_id = ${batchId} AND status = ${status}
    ORDER BY id ASC
    LIMIT ${limit} OFFSET ${offset}
  `.execute(db);
  return { ids: rows.rows.map((row) => row.id), total, offset, referenceOnly };
}

export async function collectionSlice(db: Kysely<Database>, query: CollectionQuery) {
  if (!needsFullCollection(query)) return sliceOrderedIds(db, query);
  const collection = await loadCollection(db, { ...query, page: 0 });
  let offset = Math.max(0, query.offset ?? 0);
  if (query.questionId) {
    const index = collection.ids.indexOf(query.questionId);
    if (index >= 0) offset = Math.floor(index / PRACTICE_GROUP_SIZE) * PRACTICE_GROUP_SIZE;
  }
  const ids = collection.ids.slice(offset, offset + (query.limit ?? PRACTICE_GROUP_SIZE));
  return { ids, total: collection.ids.length, offset, referenceOnly: collection.referenceOnly };
}
