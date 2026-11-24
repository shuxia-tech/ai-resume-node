import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { AppError } from '@/common/errors.js';
import type { Database } from '@/infrastructure/database.js';
import { imagesOf } from '@/modules/xingce/xingce-import.js';

const PAGE_SIZE = 25;
export const QUESTION_OPTION_KEYS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
type QuestionRow = {
  id: string;
  batch_id: string;
  category: string;
  question_type: string;
  stem: string;
  options_json: string | null;
  answer: string;
  analysis: string | null;
  source: string;
  status: string;
  payload_json: string;
};

const columns = sql`id, batch_id, category, question_type, stem, options_json, answer, analysis, source, status, payload_json`;

export function objectValue(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

export function parseRecord(input: string | null): Record<string, unknown> {
  try {
    return objectValue(JSON.parse(input ?? 'null'));
  } catch {
    return {};
  }
}

export function contentText(input: unknown, max: number) {
  return typeof input === 'string' ? input.trim().slice(0, max) : '';
}

function versionOf(row: QuestionRow) {
  return createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

export function adminQuestion(row: QuestionRow) {
  const raw = parseRecord(row.payload_json);
  return {
    ...raw,
    id: row.id,
    batchId: row.batch_id,
    type: row.question_type,
    category: row.category,
    stem: row.stem,
    options: parseRecord(row.options_json),
    answer: row.answer,
    analysis: row.analysis ?? '',
    source: row.source,
    status: row.status,
    version: versionOf(row),
  };
}

async function readQuestion(db: Kysely<Database>, id: string, lock = false) {
  const result = await sql<QuestionRow>`
    SELECT ${columns} FROM t_xingce_question
    WHERE id = ${id} AND delete_flag = 'NOT_DELETE' ${lock ? sql`FOR UPDATE` : sql``}
  `.execute(db);
  const row = result.rows[0];
  if (!row) throw new AppError(404, '题目不存在');
  return row;
}

export async function getAdminQuestion(db: Kysely<Database>, id: string) {
  return adminQuestion(await readQuestion(db, id));
}

export async function listAdminQuestions(db: Kysely<Database>, query: Record<string, unknown>) {
  const figures = query.status === 'figures';
  const status =
    query.status === 'draft' || query.status === 'withdrawn' ? query.status : 'published';
  const batch = contentText(query.batch, 80);
  const source = contentText(query.source, 500);
  const search = contentText(query.search, 150);
  const offset = Math.max(0, Math.min(1_000_000, Math.trunc(Number(query.offset) || 0)));
  const requestedSize = Number(query.pageSize);
  const pageSize = requestedSize === 60 || requestedSize === 20 ? requestedSize : PAGE_SIZE;
  const from = sql`FROM t_xingce_question WHERE delete_flag = 'NOT_DELETE' AND status = ${status}
    ${batch ? sql`AND batch_id = ${batch}` : sql``}
    ${source ? sql`AND source = ${source}` : sql``}
    ${search ? sql`AND (LOCATE(${search}, stem) > 0 OR LOCATE(${search}, source) > 0 OR LOCATE(${search}, category) > 0 OR LOCATE(${search}, id) > 0)` : sql``}
    ${query.flagged === '1' ? sql`AND (JSON_LENGTH(JSON_EXTRACT(payload_json, '$.qualityFlags')) > 0 OR JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.reviewRequired')) IN ('true', '1'))` : sql``}
    ${
      figures
        ? sql`AND (
      JSON_CONTAINS_PATH(payload_json, 'one', '$.vectorAssets', '$.redrawAssets') = 1
      OR JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.stemImage')) LIKE '%/figure-redraws/%'
    )`
        : sql``
    }`;
  const [count, result] = await Promise.all([
    sql<{ total: number }>`SELECT COUNT(*) AS total ${from}`.execute(db),
    sql<{
      id: string;
      batchId: string;
      category: string;
      stem: string;
      answer: string;
      source: string;
      status: string;
      page: string | null;
      region: string | null;
    }>`
      SELECT id, batch_id AS batchId, category, LEFT(stem, 240) AS stem, answer, source, status,
        NULLIF(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.page')), 'null') AS page,
        NULLIF(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.region')), 'null') AS region
      ${from}
      ORDER BY ${batch ? sql`id ASC` : sql`update_time DESC, id ASC`}
      LIMIT ${pageSize} OFFSET ${offset}
    `.execute(db),
  ]);
  return { questions: result.rows, total: Number(count.rows[0]?.total ?? 0), pageSize };
}

export async function listAdminQuestionSources(db: Kysely<Database>, batch: string) {
  const result = await sql<{ source: string }>`
    SELECT DISTINCT source FROM t_xingce_question
    WHERE status = 'draft' AND delete_flag = 'NOT_DELETE' AND source <> ''
      ${batch ? sql`AND batch_id = ${batch}` : sql``}
    ORDER BY source ASC LIMIT 500
  `.execute(db);
  return { sources: result.rows.map((row) => row.source) };
}

async function insertDraft(
  db: Kysely<Database>,
  raw: Record<string, unknown>,
  batchId: string,
  now: Date,
) {
  const id = randomUUID();
  const options = objectValue(raw.options);
  const source = contentText(raw.source, 500);
  const stem = contentText(raw.stem, 200_000);
  const category = contentText(raw.category, 40);
  const answer = contentText(raw.answer, 8);
  const analysis = contentText(raw.analysis, 200_000);
  const payload = {
    ...raw,
    id,
    type: 'single',
    status: 'draft',
    batchId,
    stem,
    category,
    options,
    answer,
    analysis,
    source,
  };
  await sql`
    INSERT INTO t_xingce_question (id, batch_id, category, question_type, stem, options_json, answer, analysis,
      status, source, image_json, payload_json, edited, create_time, update_time, delete_flag)
    VALUES (${id}, ${batchId}, ${category}, 'single', ${stem}, ${JSON.stringify(options)}, ${answer}, ${analysis},
      'draft', ${source}, ${JSON.stringify(imagesOf(payload))}, ${JSON.stringify(payload)}, 1, ${now}, ${now}, 'NOT_DELETE')
  `.execute(db);
  return { id };
}

export async function createAdminDraft(db: Kysely<Database>, input: unknown) {
  const body = objectValue(input);
  const now = new Date();
  const copyId = contentText(body.copyId, 160);
  if (copyId) {
    const row = await readQuestion(db, copyId);
    return insertDraft(db, { ...adminQuestion(row), version: undefined }, row.batch_id, now);
  }
  return insertDraft(
    db,
    {
      source: contentText(body.source, 500),
      sourceArchiveKey: contentText(body.sourceArchiveKey, 600),
    },
    contentText(body.batchId, 80) || 'manual',
    now,
  );
}

export async function updateLockedQuestion(trx: Kysely<Database>, id: string, input: unknown) {
  const body = objectValue(input);
  const row = await readQuestion(trx, id, true);
  if (body.version !== versionOf(row)) throw new AppError(409, '题目已更新，请重新打开后再操作');
  const now = new Date();
  if (body.action === 'delete') {
    if (row.status !== 'draft') throw new AppError(400, '只有草稿可以删除');
    await sql`UPDATE t_xingce_question SET delete_flag = 'DELETED', edited = 1, update_time = ${now} WHERE id = ${id}`.execute(
      trx,
    );
    return { id, status: 'deleted' };
  }

  const action = body.action;
  if (action !== 'save' && action !== 'publish' && action !== 'withdraw' && action !== 'restore') {
    throw new AppError(400, '无法识别的题目操作');
  }
  if (
    (action === 'publish' && row.status !== 'draft') ||
    (action === 'withdraw' && row.status !== 'published') ||
    (action === 'restore' && row.status !== 'withdrawn')
  )
    throw new AppError(409, '题目状态已变化');

  const status =
    action === 'withdraw'
      ? 'withdrawn'
      : action === 'publish' || action === 'restore'
        ? 'published'
        : row.status;
  const raw = parseRecord(row.payload_json);
  const patch = objectValue(body.patch);
  const stem = contentText(patch.stem ?? row.stem, 200_000);
  const category = contentText(patch.category ?? row.category, 40);
  const answer = contentText(patch.answer ?? row.answer, 8).toUpperCase();
  const analysis = contentText(patch.analysis ?? row.analysis, 200_000);
  const source = contentText(patch.source ?? row.source, 500);
  const options =
    patch.options === undefined
      ? parseRecord(row.options_json)
      : Object.fromEntries(
          Object.entries(objectValue(patch.options))
            .filter(([key]) => QUESTION_OPTION_KEYS.includes(key))
            .map(([key, value]) => [key, contentText(value, 20_000)]),
        );
  const stemImage = contentText(patch.stemImage ?? raw.stemImage, 2000);
  const optionImages = objectValue(raw.optionImages);
  if (status === 'published') {
    const valid = Object.keys(options).filter((key) =>
      Boolean(options[key] || optionImages[key] || stemImage),
    );
    if (!stem || !category || valid.length < 2 || !valid.includes(answer)) {
      throw new AppError(400, '请补齐题干、分类、选项和正确答案后再发布');
    }
    if (action === 'publish' && raw.reviewRequired === true && body.acknowledged !== true) {
      throw new AppError(400, '请先确认已对照原页核对题目');
    }
    if (action === 'publish') {
      const duplicates = await sql<{ id: string }>`
        SELECT id FROM t_xingce_question WHERE batch_id = ${row.batch_id} AND status = 'published'
          AND delete_flag = 'NOT_DELETE' AND stem = ${stem} AND options_json = ${JSON.stringify(options)}
        LIMIT 1 FOR UPDATE
      `.execute(trx);
      if (duplicates.rows.length)
        throw new AppError(409, '同批次已有相同题干和选项，请核对后再入库');
    }
  }
  const next = {
    ...raw,
    stem,
    category,
    answer,
    analysis,
    source,
    options,
    status,
    stemImage,
    ...(patch.difficulty !== undefined ? { difficulty: contentText(patch.difficulty, 24) } : {}),
    ...(patch.page !== undefined ? { page: contentText(String(patch.page ?? ''), 24) } : {}),
    ...(Array.isArray(patch.tags)
      ? {
          tags: patch.tags
            .map((tag) => contentText(tag, 100))
            .filter(Boolean)
            .slice(0, 30),
        }
      : {}),
    ...(action === 'publish' ? { reviewRequired: false, reviewStatus: 'user_checked' } : {}),
  };
  await sql`
    UPDATE t_xingce_question SET stem = ${stem}, options_json = ${JSON.stringify(options)}, category = ${category},
      answer = ${answer}, analysis = ${analysis}, source = ${source}, status = ${status},
      image_json = ${JSON.stringify(imagesOf(next))}, payload_json = ${JSON.stringify(next)}, edited = 1, update_time = ${now}
    WHERE id = ${id}
  `.execute(trx);
  return { id, status };
}

export function updateAdminQuestion(db: Kysely<Database>, id: string, input: unknown) {
  return db.transaction().execute((trx) => updateLockedQuestion(trx, id, input));
}
