import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { AppError } from '@/common/errors.js';
import { ok } from '@/common/http-response.js';
import { requireAdmin } from '@/modules/admin/admin-auth-routes.js';
import { uploadToCosKey } from '@/modules/storage/cos-service.js';
import type { AppEnv } from '@/config/env.js';
import type { Database } from '@/infrastructure/database.js';
import {
  planImport,
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

async function insertQuestion(db: Kysely<Database>, row: QuestionDraft, now: Date) {
  return sql`
    INSERT INTO t_xingce_question (
      id, batch_id, category, question_type, stem, options_json, answer, analysis, status,
      source, image_json, payload_json, edited, create_time, update_time, delete_flag
    ) VALUES (
      ${row.id}, ${row.batchId}, ${row.category}, ${row.questionType}, ${row.stem},
      ${row.optionsJson}, ${row.answer}, ${row.analysis}, ${row.status}, ${row.source},
      ${row.imageJson}, ${row.payloadJson}, 0, ${now}, ${now}, 'NOT_DELETE'
    )
    ON DUPLICATE KEY UPDATE
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
      delete_flag = IF(edited = 0, 'NOT_DELETE', delete_flag)
  `.execute(db);
}

async function insertInterview(db: Kysely<Database>, row: InterviewDraft, now: Date) {
  return sql`
    INSERT INTO t_xingce_interview (
      id, title, company, role_name, recruitment, status, payload_json, edited,
      create_time, update_time, delete_flag
    ) VALUES (
      ${row.id}, ${row.title}, ${row.company}, ${row.role}, ${row.recruitment}, ${row.status},
      ${row.payloadJson}, 0, ${now}, ${now}, 'NOT_DELETE'
    )
    ON DUPLICATE KEY UPDATE
      title = IF(edited = 0, VALUES(title), title),
      company = IF(edited = 0, VALUES(company), company),
      role_name = IF(edited = 0, VALUES(role_name), role_name),
      recruitment = IF(edited = 0, VALUES(recruitment), recruitment),
      status = IF(edited = 0, VALUES(status), status),
      payload_json = IF(edited = 0, VALUES(payload_json), payload_json),
      update_time = IF(edited = 0, VALUES(update_time), update_time),
      delete_flag = IF(edited = 0, 'NOT_DELETE', delete_flag)
  `.execute(db);
}

async function insertDaily(db: Kysely<Database>, row: DailyDraft, now: Date) {
  return sql`
    INSERT INTO t_xingce_daily_question (
      id, topic, question, published_date, payload_json, edited, create_time, update_time, delete_flag
    ) VALUES (
      ${row.id}, ${row.topic}, ${row.question}, ${row.publishedDate}, ${row.payloadJson},
      0, ${now}, ${now}, 'NOT_DELETE'
    )
    ON DUPLICATE KEY UPDATE
      topic = IF(edited = 0, VALUES(topic), topic),
      question = IF(edited = 0, VALUES(question), question),
      published_date = IF(edited = 0, VALUES(published_date), published_date),
      payload_json = IF(edited = 0, VALUES(payload_json), payload_json),
      update_time = IF(edited = 0, VALUES(update_time), update_time),
      delete_flag = IF(edited = 0, 'NOT_DELETE', delete_flag)
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
  options: { maxRecords?: number } = {},
) {
  await ensureXingceTables(db);
  const plan = planImport(payload, options);
  const now = new Date();
  const result =
    plan.kind === 'questions'
      ? await insertAll(plan.questions, (row) => insertQuestion(db, row, now))
      : plan.kind === 'interviews'
        ? await insertAll(plan.interviews, (row) => insertInterview(db, row, now))
        : await insertAll(plan.daily, (row) => insertDaily(db, row, now));
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

export function registerXingceRoutes(app: FastifyInstance, env: AppEnv, db: Kysely<Database>) {
  const adminGuard = requireAdmin(env, db);

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
    const rows = await sql<{ batch_id: string; total: number; published: number }>`
      SELECT batch_id, COUNT(*) AS total, SUM(status = 'published') AS published
      FROM t_xingce_question
      WHERE delete_flag = 'NOT_DELETE'
      GROUP BY batch_id
      ORDER BY total DESC, batch_id ASC
    `.execute(db);
    return ok({
      batches: rows.rows.map((row) => ({
        id: row.batch_id,
        total: Number(row.total),
        published: Number(row.published),
      })),
    });
  });

  app.get('/c/xingce/interviews', async () => {
    await ensureXingceTables(db);
    const rows = await sql<{
      id: string;
      title: string;
      company: string;
      role_name: string;
      recruitment: string;
      status: string;
      payload_json: string;
    }>`
      SELECT id, title, company, role_name, recruitment, status, payload_json
      FROM t_xingce_interview
      WHERE delete_flag = 'NOT_DELETE'
      ORDER BY update_time DESC, id ASC
      LIMIT 1000
    `.execute(db);
    return ok({
      interviews: rows.rows.map((row) => {
        let summary = '';
        let tags: string[] = [];
        let kind = '面试经验';
        let publishedDate = '';
        let interviewDate = '';
        let roundCount = 0;
        let questionCount = 0;
        try {
          const payload = JSON.parse(row.payload_json);
          summary = String(payload?.summary || '');
          tags = Array.isArray(payload?.tags) ? payload.tags.map((tag: unknown) => String(tag)) : [];
          kind = String(payload?.kind || kind);
          publishedDate = String(payload?.publishedDate || '');
          interviewDate = String(payload?.interviewDate || '');
          const rounds = Array.isArray(payload?.rounds) ? payload.rounds : [];
          roundCount = rounds.length;
          questionCount = rounds.reduce(
            (sum: number, round: { questions?: unknown[] }) =>
              sum + (Array.isArray(round?.questions) ? round.questions.length : 0),
            0,
          );
        } catch {
          summary = '';
        }
        return {
          id: row.id,
          title: row.title,
          company: row.company,
          role: row.role_name,
          recruitment: row.recruitment,
          status: row.status,
          summary,
          tags,
          kind,
          publishedDate,
          interviewDate,
          roundCount,
          questionCount,
        };
      }),
    });
  });

  app.get<{ Querystring: { batchId?: string; offset?: string } }>(
    '/c/xingce/questions',
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
      return ok(await importXingcePayload(db, request.body));
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
