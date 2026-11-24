import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { AppError } from '@/common/errors.js';
import type { Database } from '@/infrastructure/database.js';
import { planImport } from '@/modules/xingce/xingce-import.js';
import { contentText, objectValue, parseRecord } from '@/modules/xingce/xingce-admin-questions.js';

function interviewVersion(payload: string) {
  return createHash('sha256').update(payload).digest('hex');
}

export async function getAdminInterview(db: Kysely<Database>, id: string) {
  const { rows } = await sql<{ payload_json: string }>`
    SELECT payload_json FROM t_xingce_interview WHERE id = ${id} AND delete_flag = 'NOT_DELETE'
  `.execute(db);
  if (!rows[0]) throw new AppError(404, '没有这篇面经');
  return {
    entry: parseRecord(rows[0].payload_json),
    version: interviewVersion(rows[0].payload_json),
  };
}

const ADMIN_INTERVIEW_PAGE = 20;

async function loadAdminInterviewCatalog(db: Kysely<Database>) {
  const [totals, groups] = await Promise.all([
    sql<{ total: number; published: number }>`
      SELECT COUNT(*) AS total, COALESCE(SUM(status = 'published'), 0) AS published
      FROM t_xingce_interview WHERE delete_flag = 'NOT_DELETE'
    `.execute(db),
    sql<{ company: string; role: string; count: number }>`
      SELECT company, role_name AS role, COUNT(*) AS count
      FROM t_xingce_interview WHERE delete_flag = 'NOT_DELETE'
      GROUP BY company, role_name
    `.execute(db),
  ]);
  return {
    total: Number(totals.rows[0]?.total ?? 0),
    published: Number(totals.rows[0]?.published ?? 0),
    pairs: groups.rows.map((row) => ({ company: row.company, role: row.role, count: Number(row.count) })),
  };
}

export async function adminInterviews(
  db: Kysely<Database>,
  backup = false,
  query: Record<string, string | undefined> = {},
) {
  if (backup) {
    const { rows } = await sql<{ payload_json: string }>`
      SELECT payload_json FROM t_xingce_interview
      WHERE delete_flag = 'NOT_DELETE' ORDER BY update_time DESC, id ASC
    `.execute(db);
    return {
      schemaVersion: 1,
      collection: 'interviews',
      entries: rows.map((row) => parseRecord(row.payload_json)),
    };
  }
  const pageSize = ADMIN_INTERVIEW_PAGE;
  const offset = Math.max(0, Math.min(100_000, Math.trunc(Number(query.offset) || 0)));
  const company = contentText(query.company, 120);
  const role = contentText(query.role, 120);
  const where = sql`FROM t_xingce_interview WHERE delete_flag = 'NOT_DELETE'
    ${company ? sql`AND company = ${company}` : sql``}
    ${role ? sql`AND role_name = ${role}` : sql``}`;
  const [catalog, count, rows] = await Promise.all([
    loadAdminInterviewCatalog(db),
    sql<{ total: number }>`SELECT COUNT(*) AS total ${where}`.execute(db),
    sql<{
      id: string;
      title: string;
      company: string;
      department: string;
      role: string;
      recruitment: string;
      status: string;
      sourceName: string;
      questionCount: number;
    }>`
      SELECT id, title, company,
        COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.department')), 'null'), '') AS department,
        role_name AS role, recruitment, status,
        COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.source.filename')), 'null'), '') AS sourceName,
        (LENGTH(payload_json) - LENGTH(REPLACE(payload_json, '"question":', ''))) DIV 11 AS questionCount
      ${where}
      ORDER BY update_time DESC, id ASC
      LIMIT ${pageSize} OFFSET ${offset}
    `.execute(db),
  ]);
  return {
    interviews: rows.rows.map((row) => ({ ...row, questionCount: Number(row.questionCount) })),
    total: Number(count.rows[0]?.total ?? 0),
    catalogTotal: catalog.total,
    published: catalog.published,
    offset,
    pageSize,
    pairs: catalog.pairs,
  };
}

function validateInterview(entry: Record<string, unknown>) {
  if (!contentText(entry.company, 120)) throw new AppError(400, '请填写面经公司');
  if (entry.status !== 'published' && entry.status !== 'draft')
    throw new AppError(400, '面经状态无效');
  const rounds = Array.isArray(entry.rounds) ? entry.rounds : [];
  if (
    entry.status === 'published' &&
    (!rounds.length || !contentText(objectValue(entry.source).filename, 300))
  ) {
    throw new AppError(400, '发布前请填写来源，并添加面试轮次和问题');
  }
  for (const round of rounds.map(objectValue)) {
    const questions = Array.isArray(round.questions) ? round.questions.map(objectValue) : [];
    if (
      !contentText(round.title, 300) ||
      (entry.status === 'published' && !questions.length) ||
      questions.some((question) => !contentText(question.question, 20_000))
    ) {
      throw new AppError(400, '请补齐轮次名称和面试问题');
    }
  }
}

export async function saveAdminInterviews(db: Kysely<Database>, entries: unknown[], version = '') {
  const normalized = entries.map((input) => {
    const entry = objectValue(input);
    return { ...entry, status: entry.status ?? 'draft' };
  });
  const plan = planImport({ collection: 'interviews', entries: normalized });
  normalized.forEach(validateInterview);
  if (version && plan.interviews.length !== 1) throw new AppError(400, '每次编辑只能保存一篇面经');
  if (new Set(plan.interviews.map((row) => row.id)).size !== plan.interviews.length) {
    throw new AppError(409, '文件内含重复面经 ID');
  }

  await db.transaction().execute(async (trx) => {
    for (const row of plan.interviews) {
      const current = await sql<{ payload_json: string; delete_flag: string }>`
        SELECT payload_json, delete_flag FROM t_xingce_interview WHERE id = ${row.id} FOR UPDATE
      `.execute(trx);
      const existing = current.rows[0];
      const now = new Date();
      if (version) {
        if (!existing || existing.delete_flag !== 'NOT_DELETE')
          throw new AppError(404, '没有这篇面经');
        if (interviewVersion(existing.payload_json) !== version)
          throw new AppError(409, '面经已更新，请重新打开后再保存');
        await sql`UPDATE t_xingce_interview SET title = ${row.title}, company = ${row.company},
          role_name = ${row.role}, recruitment = ${row.recruitment}, status = ${row.status},
          payload_json = ${row.payloadJson}, edited = 1, update_time = ${now} WHERE id = ${row.id}`.execute(
          trx,
        );
      } else {
        if (existing) throw new AppError(409, `已有同 ID 面经：${row.id}`);
        await sql`INSERT INTO t_xingce_interview (id, title, company, role_name, recruitment, status, payload_json,
          edited, create_time, update_time, delete_flag) VALUES (${row.id}, ${row.title}, ${row.company},
          ${row.role}, ${row.recruitment}, ${row.status}, ${row.payloadJson}, 1, ${now}, ${now}, 'NOT_DELETE')`.execute(
          trx,
        );
      }
    }
  });
  return { count: plan.interviews.length };
}
