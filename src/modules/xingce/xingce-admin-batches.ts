import { sql, type Kysely } from 'kysely';
import type { Database } from '@/infrastructure/database.js';

const PAGE_SIZE = 60;

const civilSource = sql`JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.civilSource')) IN ('true', '1')`;
const displayKind = sql`JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.displayKind'))`;
const questionKind = sql`
  CASE
    WHEN ${civilSource} AND JSON_CONTAINS(JSON_EXTRACT(payload_json, '$.tags'), JSON_QUOTE('图形推理')) THEN '图形选项'
    WHEN ${civilSource} AND ${displayKind} = 'material' AND category <> '资料分析' THEN '文字题'
    WHEN ${displayKind} = 'material' THEN '资料分析'
    WHEN ${displayKind} = 'image-options' THEN '图形选项'
    WHEN ${displayKind} = 'figure' THEN '数字图形'
    ELSE '文字题'
  END
`;

export async function loadAdminBatchQuestions(
  db: Kysely<Database>,
  batchId: string,
  query: { kind?: string; offset?: string; status?: string },
) {
  const status = query.status === 'reference' || query.status === 'draft' ? query.status : 'published';
  const offset = Math.max(0, Math.min(1_000_000, Math.floor(Number(query.offset) || 0)));
  const kind = query.kind && query.kind !== 'all' ? sql`AND ${questionKind} = ${query.kind.slice(0, 20)}` : sql``;
  const from = sql`
    FROM t_xingce_question
    WHERE batch_id = ${batchId} AND status = ${status} AND delete_flag = 'NOT_DELETE' ${kind}
  `;

  const [counts, rows] = await Promise.all([
    sql<{ total: number }>`SELECT COUNT(*) AS total ${from}`.execute(db),
    sql<{ id: string; source: string; page: string | null; kind: string; stem: string; redrawn: number }>`
      SELECT id, source, LEFT(stem, 300) AS stem,
        NULLIF(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.page')), 'null') AS page,
        ${questionKind} AS kind,
        JSON_CONTAINS_PATH(payload_json, 'one', '$.vectorAssets', '$.redrawAssets') AS redrawn
      ${from}
      ORDER BY id ASC
      LIMIT ${PAGE_SIZE} OFFSET ${offset}
    `.execute(db),
  ]);

  return {
    total: Number(counts.rows[0]?.total ?? 0),
    pageSize: PAGE_SIZE,
    questions: rows.rows.map((row) => ({ ...row, redrawn: Boolean(row.redrawn) })),
  };
}

function fields(value: string | null): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(value ?? 'null');
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch {
    return {};
  }
  return {};
}

export async function exportAdminBatch(db: Kysely<Database>, batchId?: string, publishedOnly = false) {
  const { rows } = await sql<{
    id: string;
    batch_id: string;
    category: string;
    question_type: string;
    stem: string;
    options_json: string | null;
    answer: string;
    analysis: string | null;
    source: string;
    status: 'published' | 'draft' | 'reference' | 'withdrawn';
    payload_json: string;
  }>`
    SELECT id, batch_id, category, question_type, stem, options_json, answer, analysis, source, status, payload_json
    FROM t_xingce_question
    WHERE delete_flag = 'NOT_DELETE' AND status IN ('published', 'draft', 'reference', 'withdrawn')
      ${batchId ? sql`AND batch_id = ${batchId}` : sql``}
      ${publishedOnly ? sql`AND status = 'published'` : sql``}
    ORDER BY id ASC
  `.execute(db);

  const groups: Record<(typeof rows)[number]['status'], Record<string, unknown>[]> = {
    published: [],
    draft: [],
    reference: [],
    withdrawn: [],
  };
  let title = '';
  for (const row of rows) {
    const original = fields(row.payload_json);
    if (!title && typeof original.batchTitle === 'string') title = original.batchTitle;
    groups[row.status].push({
      ...original,
      id: row.id,
      batchId: row.batch_id,
      type: row.question_type,
      category: row.category,
      stem: row.stem,
      options: fields(row.options_json),
      answer: row.answer,
      analysis: row.analysis ?? '',
      source: row.source,
      status: row.status,
    });
  }
  return {
    schemaVersion: 2,
    ...(batchId ? { batch: { id: batchId, title } } : {}),
    questions: [...groups.published, ...groups.withdrawn],
    drafts: groups.draft,
    references: groups.reference,
  };
}
