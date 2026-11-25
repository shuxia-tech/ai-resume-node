import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { AppError } from '@/common/errors.js';
import { requireLogin } from '@/auth/request-user.js';
import { ok } from '@/common/http-response.js';
import { requireAdmin } from '@/modules/admin/admin-auth-routes.js';
import { uploadToCosKey } from '@/modules/storage/cos-service.js';
import { loadAdminBatchQuestions, exportAdminBatch } from '@/modules/xingce/xingce-admin-batches.js';
import { registerAdminContentRoutes } from '@/modules/xingce/xingce-admin-content-routes.js';
import type { AppEnv } from '@/config/env.js';
import type { Database } from '@/infrastructure/database.js';
import {
  planImport,
  type ImportOptions,
  type DailyDraft,
  type InterviewDraft,
  type QuestionDraft,
} from '@/modules/xingce/xingce-import.js';

let tablesReady: Promise<void> | undefined;

export function ensureXingceTables(db: Kysely<Database>): Promise<void> {
  tablesReady ??= (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS t_xingce_question (
        id varchar(160) NOT NULL COMMENT '题目ID',
        batch_id varchar(80) NOT NULL DEFAULT '' COMMENT '题集',
        category varchar(40) NOT NULL DEFAULT '' COMMENT '分类',
        question_type varchar(20) NOT NULL DEFAULT 'single' COMMENT '题型',
        stem mediumtext NOT NULL COMMENT '题干',
        options_json longtext NULL COMMENT '选项JSON',
        answer varchar(8) NOT NULL DEFAULT '' COMMENT '答案',
        analysis mediumtext NULL COMMENT '解析',
        status varchar(20) NOT NULL DEFAULT 'published' COMMENT 'published/draft/withdrawn/reference',
        source varchar(500) NOT NULL DEFAULT '' COMMENT '来源',
        image_json longtext NULL COMMENT '图片路径JSON',
        payload_json longtext NOT NULL COMMENT '原始记录',
        edited tinyint NOT NULL DEFAULT 0 COMMENT '后台改过则不再被导入覆盖',
        create_time datetime NOT NULL COMMENT '创建时间',
        update_time datetime NOT NULL COMMENT '更新时间',
        delete_flag varchar(32) NOT NULL DEFAULT 'NOT_DELETE' COMMENT '删除标识',
        PRIMARY KEY (id),
        KEY idx_xingce_question_batch (batch_id, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='行测题目'
    `.execute(db);
    await sql`
      CREATE TABLE IF NOT EXISTS t_xingce_paper (
        id varchar(80) NOT NULL COMMENT '试卷ID',
        title varchar(300) NOT NULL COMMENT '试卷名',
        year varchar(10) NOT NULL DEFAULT '' COMMENT '年份',
        region varchar(40) NOT NULL DEFAULT '' COMMENT '地区',
        payload_json longtext NOT NULL COMMENT '原始记录',
        create_time datetime NOT NULL COMMENT '创建时间',
        update_time datetime NOT NULL COMMENT '更新时间',
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='行测试卷'
    `.execute(db);
    await sql`
      CREATE TABLE IF NOT EXISTS t_xingce_interview (
        id varchar(160) NOT NULL COMMENT '面经ID',
        title varchar(300) NOT NULL COMMENT '标题',
        company varchar(120) NOT NULL DEFAULT '' COMMENT '公司',
        role_name varchar(120) NOT NULL DEFAULT '' COMMENT '岗位',
        recruitment varchar(40) NOT NULL DEFAULT '' COMMENT '阶段',
        status varchar(20) NOT NULL DEFAULT 'published' COMMENT '状态',
        payload_json longtext NOT NULL COMMENT '原始记录',
        edited tinyint NOT NULL DEFAULT 0 COMMENT '后台改过则不再被导入覆盖',
        create_time datetime NOT NULL COMMENT '创建时间',
        update_time datetime NOT NULL COMMENT '更新时间',
        delete_flag varchar(32) NOT NULL DEFAULT 'NOT_DELETE' COMMENT '删除标识',
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='行测面经'
    `.execute(db);
    await sql`
      CREATE TABLE IF NOT EXISTS t_xingce_daily_question (
        id varchar(160) NOT NULL COMMENT '每日一问ID',
        topic varchar(80) NOT NULL DEFAULT '' COMMENT '主题',
        question mediumtext NOT NULL COMMENT '问题',
        published_date varchar(20) NOT NULL DEFAULT '' COMMENT '资料发布日期',
        payload_json longtext NOT NULL COMMENT '原始记录',
        edited tinyint NOT NULL DEFAULT 0 COMMENT '后台改过则不再被导入覆盖',
        create_time datetime NOT NULL COMMENT '创建时间',
        update_time datetime NOT NULL COMMENT '更新时间',
        delete_flag varchar(32) NOT NULL DEFAULT 'NOT_DELETE' COMMENT '删除标识',
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='行测每日一问'
    `.execute(db);
  })().catch((error: unknown) => {
    tablesReady = undefined;
    throw error;
  });
  return tablesReady;
}

function duplicateKey(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return code === 'ER_DUP_ENTRY' || code === '1062';
}

async function insertQuestion(db: Kysely<Database>, row: QuestionDraft, now: Date, skipExisting = false) {
  return sql`
    INSERT INTO t_xingce_question (
      id, batch_id, category, question_type, stem, options_json, answer, analysis, status,
      source, image_json, payload_json, edited, create_time, update_time, delete_flag
    ) VALUES (
      ${row.id}, ${row.batchId}, ${row.category}, ${row.questionType}, ${row.stem},
      ${row.optionsJson}, ${row.answer}, ${row.analysis}, ${row.status}, ${row.source},
      ${row.imageJson}, ${row.payloadJson}, 0, ${now}, ${now}, 'NOT_DELETE'
    )
    ${skipExisting ? sql`` : sql`ON DUPLICATE KEY UPDATE
      batch_id = IF(edited = 0, VALUES(batch_id), batch_id),
      category = IF(edited = 0, VALUES(category), category),
      question_type = IF(edited = 0, VALUES(question_type), question_type),
      stem = IF(edited = 0, VALUES(stem), stem),
      options_json = IF(edited = 0, VALUES(options_json), options_json),
      answer = IF(edited = 0, VALUES(answer), answer),
      analysis = IF(edited = 0, VALUES(analysis), analysis),
      status = IF(edited = 0, VALUES(status), status),
      source = IF(edited = 0, VALUES(source), source),
      image_json = IF(edited = 0, VALUES(image_json), image_json),
      payload_json = IF(edited = 0, VALUES(payload_json), payload_json),
      update_time = IF(edited = 0, VALUES(update_time), update_time),
      delete_flag = IF(edited = 0, 'NOT_DELETE', delete_flag)`}
  `.execute(db);
}

async function insertInterview(db: Kysely<Database>, row: InterviewDraft, now: Date, skipExisting = false) {
  return sql`
    INSERT INTO t_xingce_interview (
      id, title, company, role_name, recruitment, status, payload_json, edited,
      create_time, update_time, delete_flag
    ) VALUES (
      ${row.id}, ${row.title}, ${row.company}, ${row.role}, ${row.recruitment}, ${row.status},
      ${row.payloadJson}, 0, ${now}, ${now}, 'NOT_DELETE'
    )
    ${skipExisting ? sql`` : sql`ON DUPLICATE KEY UPDATE
      title = IF(edited = 0, VALUES(title), title),
      company = IF(edited = 0, VALUES(company), company),
      role_name = IF(edited = 0, VALUES(role_name), role_name),
      recruitment = IF(edited = 0, VALUES(recruitment), recruitment),
      status = IF(edited = 0, VALUES(status), status),
      payload_json = IF(edited = 0, VALUES(payload_json), payload_json),
      update_time = IF(edited = 0, VALUES(update_time), update_time),
      delete_flag = IF(edited = 0, 'NOT_DELETE', delete_flag)`}
  `.execute(db);
}

async function insertDaily(db: Kysely<Database>, row: DailyDraft, now: Date, skipExisting = false) {
  return sql`
    INSERT INTO t_xingce_daily_question (
      id, topic, question, published_date, payload_json, edited, create_time, update_time, delete_flag
    ) VALUES (
      ${row.id}, ${row.topic}, ${row.question}, ${row.publishedDate}, ${row.payloadJson},
      0, ${now}, ${now}, 'NOT_DELETE'
    )
    ${skipExisting ? sql`` : sql`ON DUPLICATE KEY UPDATE
      topic = IF(edited = 0, VALUES(topic), topic),
      question = IF(edited = 0, VALUES(question), question),
      published_date = IF(edited = 0, VALUES(published_date), published_date),
      payload_json = IF(edited = 0, VALUES(payload_json), payload_json),
      update_time = IF(edited = 0, VALUES(update_time), update_time),
      delete_flag = IF(edited = 0, 'NOT_DELETE', delete_flag)`}
  `.execute(db);
}

export async function upsertXingcePaper(
  db: Kysely<Database>,
  row: { id: string; title: string; year: string; region: string; payloadJson: string },
) {
  await ensureXingceTables(db);
  const now = new Date();
  await sql`
    INSERT INTO t_xingce_paper (id, title, year, region, payload_json, create_time, update_time)
    VALUES (${row.id}, ${row.title}, ${row.year}, ${row.region}, ${row.payloadJson}, ${now}, ${now})
    ON DUPLICATE KEY UPDATE
      title = VALUES(title),
      year = VALUES(year),
      region = VALUES(region),
      payload_json = VALUES(payload_json),
      update_time = VALUES(update_time)
  `.execute(db);
}

export async function importXingcePayload(
  db: Kysely<Database>,
  payload: unknown,
  options: ImportOptions & { skipExisting?: boolean } = {},
) {
  await ensureXingceTables(db);
  const plan = planImport(payload, options);
  const now = new Date();
  const result =
    plan.kind === 'questions'
      ? await insertAll(plan.questions, (row) => insertQuestion(db, row, now, options.skipExisting))
      : plan.kind === 'interviews'
        ? await insertAll(plan.interviews, (row) => insertInterview(db, row, now, options.skipExisting))
        : await insertAll(plan.daily, (row) => insertDaily(db, row, now, options.skipExisting));
  return { kind: plan.kind, batchId: plan.batchId, ...result };
}

async function insertAll<T>(
  rows: T[],
  insert: (row: T) => Promise<{ numAffectedRows?: bigint | number } | unknown>,
) {
  let inserted = 0;
  let updated = 0;
  const skipped: string[] = [];
  for (const row of rows) {
    try {
      const result = await insert(row);
      const affected = Number(
        result && typeof result === 'object' && 'numAffectedRows' in result
          ? (result as { numAffectedRows?: bigint | number }).numAffectedRows ?? 1
          : 1,
      );
      if (affected >= 2) updated += 1;
      else if (affected === 0) skipped.push(String((row as { id: string }).id));
      else inserted += 1;
    } catch (error) {
      if (!duplicateKey(error)) throw error;
      skipped.push(String((row as { id: string }).id));
    }
  }
  return { inserted, updated, skipped };
}

function extensionOf(filename: string | undefined) {
  const extension = (filename?.split('.').pop() || 'bin').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  return extension || 'bin';
}

const INTERVIEW_PAGE_SIZE = 12;
type InterviewFacet = { value: string; count: number };
type InterviewCatalog = {
  at: number;
  published: number;
  questionTotal: number;
  companies: InterviewFacet[];
  roles: InterviewFacet[];
  stages: InterviewFacet[];
};
let interviewCatalog: InterviewCatalog | undefined;

function jsonText(value: string | null) {
  return !value || value === 'null' ? '' : value;
}

function jsonTags(value: unknown) {
  if (Array.isArray(value)) return value.map((tag) => String(tag));
  if (typeof value !== 'string' || !value || value === 'null') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((tag) => String(tag)) : [];
  } catch {
    return [];
  }
}

function facetList(rows: { value: string; count: number }[]) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = row.value.trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + Number(row.count));
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => a.value.localeCompare(b.value, 'zh-CN'));
}

async function publishedInterviewCatalog(db: Kysely<Database>) {
  if (interviewCatalog && Date.now() - interviewCatalog.at < 5 * 60_000) return interviewCatalog;
  const [totals, groups] = await Promise.all([
    sql<{ published: number; questionTotal: number }>`
      SELECT COUNT(*) AS published,
        COALESCE(SUM((LENGTH(payload_json) - LENGTH(REPLACE(payload_json, '"question":', ''))) DIV 11), 0) AS questionTotal
      FROM t_xingce_interview
      WHERE delete_flag = 'NOT_DELETE' AND status = 'published'
    `.execute(db),
    sql<{ company: string; role: string; recruitment: string; count: number }>`
      SELECT company, role_name AS role, recruitment, COUNT(*) AS count
      FROM t_xingce_interview
      WHERE delete_flag = 'NOT_DELETE' AND status = 'published'
      GROUP BY company, role_name, recruitment
    `.execute(db),
  ]);
  interviewCatalog = {
    at: Date.now(),
    published: Number(totals.rows[0]?.published ?? 0),
    questionTotal: Number(totals.rows[0]?.questionTotal ?? 0),
    companies: facetList(groups.rows.map((row) => ({ value: row.company, count: row.count }))),
    roles: facetList(groups.rows.map((row) => ({ value: row.role, count: row.count }))),
    stages: facetList(groups.rows.map((row) => ({ value: row.recruitment, count: row.count }))),
  };
  return interviewCatalog;
}

async function listPublishedInterviews(db: Kysely<Database>, query: Record<string, string | undefined>) {
  const pageSize = INTERVIEW_PAGE_SIZE;
  const offset = Math.max(0, Math.min(100_000, Math.trunc(Number(query.offset) || 0)));
  const q = (query.q || '').trim().slice(0, 80);
  const company = (query.company || '').trim().slice(0, 120);
  const role = (query.role || '').trim().slice(0, 120);
  const stage = (query.stage || '').trim().slice(0, 80);
  const where = sql`FROM t_xingce_interview WHERE delete_flag = 'NOT_DELETE' AND status = 'published'
    ${company ? sql`AND company = ${company}` : sql``}
    ${role ? sql`AND role_name = ${role}` : sql``}
    ${stage ? sql`AND recruitment = ${stage}` : sql``}
    ${q ? sql`AND (LOCATE(${q}, title) > 0 OR LOCATE(${q}, company) > 0 OR LOCATE(${q}, role_name) > 0 OR LOCATE(${q}, recruitment) > 0 OR LOCATE(${q}, payload_json) > 0)` : sql``}`;
  const [catalog, count, rows] = await Promise.all([
    publishedInterviewCatalog(db),
    sql<{ total: number }>`SELECT COUNT(*) AS total ${where}`.execute(db),
    sql<{
      id: string;
      title: string;
      company: string;
      role: string;
      recruitment: string;
      summary: string;
      tags: string;
      kind: string;
      publishedDate: string;
      roundCount: number;
      questionCount: number;
    }>`
      SELECT id, title, company, role_name AS role, recruitment,
        COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.summary')), 'null'), '') AS summary,
        JSON_EXTRACT(payload_json, '$.tags') AS tags,
        COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.kind')), 'null'), '') AS kind,
        COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.publishedDate')), 'null'), '') AS publishedDate,
        COALESCE(JSON_LENGTH(JSON_EXTRACT(payload_json, '$.rounds')), 0) AS roundCount,
        (LENGTH(payload_json) - LENGTH(REPLACE(payload_json, '"question":', ''))) DIV 11 AS questionCount
      ${where}
      ORDER BY update_time DESC, id ASC
      LIMIT ${pageSize} OFFSET ${offset}
    `.execute(db),
  ]);
  return {
    interviews: rows.rows.map((row) => ({
      id: row.id,
      title: row.title,
      company: row.company,
      role: row.role,
      recruitment: row.recruitment,
      status: 'published',
      summary: jsonText(row.summary),
      tags: jsonTags(row.tags),
      kind: jsonText(row.kind) || '面试经验',
      publishedDate: jsonText(row.publishedDate),
      roundCount: Number(row.roundCount),
      questionCount: Number(row.questionCount),
    })),
    total: Number(count.rows[0]?.total ?? 0),
    published: catalog.published,
    questionTotal: catalog.questionTotal,
    offset,
    pageSize,
    facets: { companies: catalog.companies, roles: catalog.roles, stages: catalog.stages },
  };
}

export function registerXingceRoutes(app: FastifyInstance, env: AppEnv, db: Kysely<Database>) {
  const adminGuard = requireAdmin(env, db);
  registerAdminContentRoutes(app, env, db, () => ensureXingceTables(db));

  app.get('/c/xingce/summary', async () => {
    await ensureXingceTables(db);
    const questions = await sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM t_xingce_question
      WHERE delete_flag = 'NOT_DELETE' AND status = 'published'
    `.execute(db);
    const interviews = await sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM t_xingce_interview WHERE delete_flag = 'NOT_DELETE'
    `.execute(db);
    const daily = await sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM t_xingce_daily_question WHERE delete_flag = 'NOT_DELETE'
    `.execute(db);
    const references = await sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM t_xingce_question
      WHERE delete_flag = 'NOT_DELETE' AND status = 'reference'
    `.execute(db);
    return ok({
      questions: Number(questions.rows[0]?.n ?? 0),
      interviews: Number(interviews.rows[0]?.n ?? 0),
      daily: Number(daily.rows[0]?.n ?? 0),
      references: Number(references.rows[0]?.n ?? 0),
    });
  });

  app.get('/c/xingce/batches', async () => {
    await ensureXingceTables(db);
    const rows = await sql<{
      batch_id: string;
      total: number;
      published: number;
      drafts: number;
      references_count: number;
      title: string | null;
    }>`
      SELECT batches.*,
        JSON_UNQUOTE(JSON_EXTRACT(question.payload_json, '$.batchTitle')) AS title
      FROM (
        SELECT batch_id, MAX(id) AS sample_id, COUNT(*) AS total, SUM(status = 'published') AS published,
          SUM(status = 'draft') AS drafts, SUM(status = 'reference') AS references_count
        FROM t_xingce_question
        WHERE delete_flag = 'NOT_DELETE'
        GROUP BY batch_id
      ) AS batches
      JOIN t_xingce_question AS question ON question.id = batches.sample_id
      ORDER BY batches.total DESC, batches.batch_id ASC
    `.execute(db);
    return ok({
      batches: rows.rows.map((row) => ({
        id: row.batch_id,
        total: Number(row.total),
        published: Number(row.published),
        drafts: Number(row.drafts),
        references: Number(row.references_count),
        title: row.title === 'null' ? '' : row.title ?? '',
      })),
    });
  });

  app.get<{ Params: { id: string }; Querystring: { kind?: string; offset?: string; status?: string } }>(
    '/c/xingce/admin/batches/:id/questions',
    { preHandler: adminGuard },
    async (request) => {
      await ensureXingceTables(db);
      return ok(await loadAdminBatchQuestions(db, request.params.id.slice(0, 80), request.query));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/c/xingce/admin/batches/:id/export',
    { preHandler: adminGuard },
    async (request) => {
      await ensureXingceTables(db);
      return ok(await exportAdminBatch(db, request.params.id.slice(0, 80)));
    },
  );

  app.get<{ Querystring: Record<string, string | undefined> }>('/c/xingce/interviews', async (request) => {
    await ensureXingceTables(db);
    return ok(await listPublishedInterviews(db, request.query));
  });

  app.get<{ Querystring: { batchId?: string; offset?: string } }>(
    '/c/xingce/questions',
    { preHandler: requireLogin(env) },
    async (request) => {
      await ensureXingceTables(db);
      const batchId = request.query.batchId?.slice(0, 80) ?? '';
      const offset = Math.max(0, Math.min(10_000, Number(request.query.offset) || 0));
      const rows = await sql<{
        id: string;
        batch_id: string;
        category: string;
        stem: string;
        answer: string;
        status: string;
      }>`
        SELECT id, batch_id, category, stem, answer, status
        FROM t_xingce_question
        WHERE delete_flag = 'NOT_DELETE' AND status = 'published'
          AND (${batchId} = '' OR batch_id = ${batchId})
        ORDER BY update_time DESC, id ASC
        LIMIT 10 OFFSET ${offset}
      `.execute(db);
      return ok({
        questions: rows.rows.map((row) => ({
          id: row.id,
          batchId: row.batch_id,
          category: row.category,
          stem: row.stem.slice(0, 180),
          answer: row.answer,
          status: row.status,
        })),
      });
    },
  );

  app.post(
    '/c/xingce/admin/import',
    { preHandler: adminGuard, bodyLimit: 2 * 1024 * 1024 },
    async (request: FastifyRequest) => {
      return ok(await importXingcePayload(db, request.body, { skipExisting: true, validatePublication: true }));
    },
  );

  app.post(
    '/c/xingce/admin/images',
    { preHandler: adminGuard },
    async (request: FastifyRequest) => {
      await ensureXingceTables(db);
      const part = await request.file();
      if (!part) throw new AppError(400, '请上传图片');
      const body = await part.toBuffer();
      if (body.byteLength > 8 * 1024 * 1024) throw new AppError(400, '图片不能超过 8MB');
      const day = new Date().toISOString().slice(0, 10);
      const key = `xingce/import/${day}/${randomUUID()}.${extensionOf(part.filename)}`;
      return ok({ url: await uploadToCosKey(env, body, part.mimetype, key), name: part.filename });
    },
  );
}
