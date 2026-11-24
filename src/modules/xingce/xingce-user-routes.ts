import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { AppError } from '@/common/errors.js';
import { ok } from '@/common/http-response.js';
import { requireUser, requestToken } from '@/auth/request-user.js';
import { requireAdmin } from '@/modules/admin/admin-auth-routes.js';
import type { AppEnv } from '@/config/env.js';
import type { Database } from '@/infrastructure/database.js';
import { collectionSlice, loadCollection } from '@/modules/xingce/xingce-collection.js';
import { ensureXingceTables } from '@/modules/xingce/xingce-routes.js';
import { getAdminQuestion, updateLockedQuestion } from '@/modules/xingce/xingce-admin-questions.js';
import { hasCollectionScans, loadCollectionScans } from '@/modules/xingce/xingce-scans.js';
import {
  extendExpiry,
  questionVersion,
  shouldImportAttempt,
} from '@/modules/xingce/xingce-rules.js';

const CORRECTION_TYPES = ['answer', 'stem', 'analysis', 'image', 'suggestion'];

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function guestValue(request: FastifyRequest) {
  const raw = request.headers.cookie ?? '';
  const piece = raw
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith('xc_guest='));
  const value = piece?.slice('xc_guest='.length) ?? '';
  return /^[A-Za-z0-9_-]{20,80}$/.test(value) ? value : '';
}

function setGuestCookie(reply: FastifyReply, value: string) {
  reply.header(
    'set-cookie',
    `xc_guest=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
  );
}

async function optionalUser(env: AppEnv, request: FastifyRequest) {
  if (!requestToken(request)) return;
  try {
    await requireUser(env)(request);
  } catch {
    request.userId = undefined;
  }
}

async function ensureUserTables(db: Kysely<Database>) {
  await ensureXingceTables(db);
  await sql`
    CREATE TABLE IF NOT EXISTS t_xingce_member (
      user_id varchar(128) NOT NULL COMMENT '统一账号ID',
      name varchar(60) NOT NULL COMMENT '显示名',
      invitation_code varchar(64) NOT NULL COMMENT '邀请码',
      expires_at datetime NOT NULL COMMENT '行测会员到期',
      joined_at datetime NOT NULL COMMENT '首次加入',
      PRIMARY KEY (user_id),
      UNIQUE KEY uk_xingce_invite (invitation_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='行测会员'
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS t_xingce_referral (
      invitee_id varchar(128) NOT NULL COMMENT '受邀人',
      inviter_id varchar(128) NOT NULL COMMENT '邀请人',
      awarded_at datetime NOT NULL COMMENT '发奖时间',
      PRIMARY KEY (invitee_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='行测邀请'
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS t_xingce_reward_ledger (
      id varchar(64) NOT NULL COMMENT '流水',
      user_id varchar(128) NOT NULL COMMENT '获奖用户',
      source varchar(20) NOT NULL COMMENT 'invite或correction',
      source_key varchar(220) NOT NULL COMMENT '去重键',
      days int NOT NULL COMMENT '天数',
      awarded_at datetime NOT NULL COMMENT '发奖时间',
      PRIMARY KEY (id),
      UNIQUE KEY uk_xingce_reward (source_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='行测奖励流水'
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS t_xingce_attempt (
      id varchar(64) NOT NULL COMMENT '作答ID',
      user_id varchar(128) NOT NULL COMMENT '用户',
      question_id varchar(160) NOT NULL COMMENT '题目',
      answer varchar(8) NOT NULL COMMENT '选项',
      correct tinyint NOT NULL COMMENT '是否正确',
      local_date varchar(10) NOT NULL COMMENT '本地日期',
      created_at datetime NOT NULL COMMENT '提交时间',
      PRIMARY KEY (id),
      KEY idx_xingce_attempt_user (user_id, question_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='行测作答'
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS t_xingce_favorite (
      user_id varchar(128) NOT NULL COMMENT '用户',
      question_id varchar(160) NOT NULL COMMENT '题目',
      created_at datetime NOT NULL COMMENT '收藏时间',
      PRIMARY KEY (user_id, question_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='行测收藏'
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS t_xingce_correction (
      id varchar(64) NOT NULL COMMENT '反馈ID',
      user_id varchar(128) NULL COMMENT '登录用户',
      guest_hash varchar(64) NULL COMMENT '访客凭据哈希',
      question_id varchar(160) NOT NULL COMMENT '题目',
      question_version varchar(64) NOT NULL COMMENT '题目版本',
      correction_type varchar(20) NOT NULL COMMENT '类型',
      message varchar(2000) NOT NULL COMMENT '说明',
      suggestion varchar(2000) NOT NULL DEFAULT '' COMMENT '修改建议',
      status varchar(20) NOT NULL COMMENT 'pending/approved/rejected',
      review_note varchar(1000) NOT NULL DEFAULT '' COMMENT '审核说明',
      reward_days int NOT NULL DEFAULT 0 COMMENT '已发天数',
      created_at datetime NOT NULL COMMENT '提交时间',
      reviewed_at datetime NULL COMMENT '审核时间',
      reviewer varchar(128) NOT NULL DEFAULT '' COMMENT '审核人',
      PRIMARY KEY (id),
      KEY idx_xingce_correction_status (status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='行测纠错'
  `.execute(db);
}

async function awardDays(
  db: Kysely<Database>,
  userId: string,
  source: 'invite' | 'correction',
  sourceKey: string,
  days: number,
  now: Date,
) {
  const existing = await sql<{ expires_at: Date }>`
    SELECT expires_at FROM t_xingce_member WHERE user_id = ${userId} FOR UPDATE
  `.execute(db);
  const current = existing.rows[0]?.expires_at ? new Date(existing.rows[0].expires_at) : null;
  const next = extendExpiry(current, now, days);
  await sql`
    UPDATE t_xingce_member SET expires_at = ${next} WHERE user_id = ${userId}
  `.execute(db);
  await sql`
    INSERT INTO t_xingce_reward_ledger (id, user_id, source, source_key, days, awarded_at)
    VALUES (${randomUUID()}, ${userId}, ${source}, ${sourceKey}, ${days}, ${now})
  `.execute(db);
}

async function memberSummary(db: Kysely<Database>, userId: string, name: string) {
  const row = await sql<{
    name: string;
    invitation_code: string;
    expires_at: Date;
    invited: number;
  }>`
    SELECT m.name, m.invitation_code, m.expires_at,
      (SELECT COUNT(*) FROM t_xingce_referral r WHERE r.inviter_id = m.user_id) AS invited
    FROM t_xingce_member m WHERE m.user_id = ${userId}
  `.execute(db);
  const member = row.rows[0];
  if (!member) return { authenticated: true, joined: false, name };
  const earned = await sql<{ days: number }>`
    SELECT COALESCE(SUM(days), 0) AS days FROM t_xingce_reward_ledger WHERE user_id = ${userId}
  `.execute(db);
  const history = await sql<{ name: string; awarded_at: Date }>`
    SELECT COALESCE(m.name, '同学') AS name, r.awarded_at
    FROM t_xingce_referral r
    LEFT JOIN t_xingce_member m ON m.user_id = r.invitee_id
    WHERE r.inviter_id = ${userId}
    ORDER BY r.awarded_at DESC
    LIMIT 20
  `.execute(db);
  const expires = new Date(member.expires_at);
  return {
    authenticated: true,
    joined: true,
    name: member.name,
    invitationCode: member.invitation_code,
    isMember: expires.getTime() > Date.now(),
    memberExpiresAt: expires.toISOString(),
    invitedCount: Number(member.invited),
    earnedDays: Number(earned.rows[0]?.days ?? 0),
    history: history.rows.map((item) => ({
      name: item.name,
      awardedAt: new Date(item.awarded_at).toISOString(),
    })),
  };
}

function parseOptions(value: string | null) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function practiceQuestion(row: {
  id: string;
  batch_id: string;
  category: string;
  stem: string;
  options_json: string | null;
  answer: string;
  analysis: string | null;
  payload_json: string;
  status: string;
  source: string;
}) {
  const payload = parseOptions(row.payload_json) as Record<string, unknown>;
  const optionImages =
    payload.optionImages && typeof payload.optionImages === 'object' && !Array.isArray(payload.optionImages)
      ? (payload.optionImages as Record<string, string>)
      : {};
  return {
    id: row.id,
    batchId: row.batch_id,
    category: row.category,
    stem: row.stem,
    options: parseOptions(row.options_json),
    answer: row.answer,
    analysis: row.analysis ?? '',
    tags: Array.isArray(payload.tags) ? payload.tags.map((tag) => String(tag)) : [],
    source: row.source || String(payload.source || ''),
    images: {
      stem: String(payload.stemImage || ''),
      options: optionImages,
      width: Number(payload.imageDisplayWidth) || 0,
    },
    version: questionVersion({
      stem: row.stem,
      optionsJson: row.options_json,
      answer: row.answer,
      analysis: row.analysis,
      category: row.category,
      status: row.status,
    }),
  };
}

export function registerXingceUserRoutes(
  app: FastifyInstance,
  env: AppEnv,
  db: Kysely<Database>,
) {
  const authenticate = requireUser(env);
  const adminGuard = requireAdmin(env, db);

  app.get('/c/xingce/home', async () => {
    await ensureUserTables(db);
    const rows = await sql<{ category: string; n: number }>`
      SELECT category, COUNT(*) AS n FROM t_xingce_question
      WHERE delete_flag = 'NOT_DELETE' AND status = 'published'
      GROUP BY category
    `.execute(db);
    const total = await sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM t_xingce_question
      WHERE delete_flag = 'NOT_DELETE' AND status = 'published'
    `.execute(db);
    const batches = await sql<{
      batch_id: string;
      published: number;
      reference_count: number;
    }>`
      SELECT batch_id,
        SUM(status = 'published') AS published,
        SUM(status = 'reference') AS reference_count
      FROM t_xingce_question
      WHERE delete_flag = 'NOT_DELETE'
      GROUP BY batch_id
      ORDER BY published DESC, batch_id ASC
    `.execute(db);
    return ok({
      total: Number(total.rows[0]?.n ?? 0),
      categories: rows.rows.map((row) => ({ category: row.category, count: Number(row.n) })),
      batches: batches.rows.map((row) => ({
        id: row.batch_id,
        questionCount: Number(row.published),
        referenceCount: Number(row.reference_count),
        referenceOnly: Number(row.published) === 0 && Number(row.reference_count) > 0,
      })),
    });
  });

  app.post<{ Body: { ids?: string[] } }>('/c/xingce/questions/lookup', async (request) => {
    await ensureUserTables(db);
    const ids = (Array.isArray(request.body?.ids) ? request.body.ids : [])
      .map((id) => String(id).slice(0, 160))
      .filter((id) => /^[\w.-]{1,160}$/.test(id))
      .slice(0, 120);
    if (!ids.length) return ok({ questions: [] });
    const rows = await sql<{
      id: string;
      category: string;
      stem: string;
      payload_json: string;
    }>`
      SELECT id, category, stem, payload_json FROM t_xingce_question
      WHERE delete_flag = 'NOT_DELETE' AND status = 'published' AND id IN (${sql.join(ids.map((id) => sql`${id}`))})
    `.execute(db);
    return ok({
      questions: rows.rows.map((row) => {
        let tags: string[] = [];
        try {
          const payload = JSON.parse(row.payload_json);
          if (Array.isArray(payload?.tags)) tags = payload.tags.map((tag: unknown) => String(tag));
        } catch {
          tags = [];
        }
        return { id: row.id, category: row.category, stem: row.stem, tags };
      }),
    });
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string | undefined> }>(
    '/c/xingce/collections/:id',
    async (request) => {
      await ensureUserTables(db);
      const id = request.params.id.slice(0, 80);
      const page = Math.max(0, Number(request.query.page) || 0);
      const [data, hasScans] = await Promise.all([
        loadCollection(db, {
          batchId: id,
          kind: request.query.kind?.slice(0, 20) || 'all',
          page,
          year: request.query.year?.slice(0, 10) || '',
          region: request.query.region?.slice(0, 40) || '',
          paper: request.query.paper?.slice(0, 80) || '',
          module: request.query.module?.slice(0, 40) || '',
          book: request.query.book?.slice(0, 80) || '',
        }),
        hasCollectionScans(db, id),
      ]);
      return ok({
        ...data,
        hasScans,
        ids: data.ids.length > 4000 ? [] : data.ids,
      });
    },
  );

  app.get<{ Params: { id: string } }>('/c/xingce/collections/:id/scans', async (request) => {
    await ensureXingceTables(db);
    return ok(await loadCollectionScans(db, request.params.id.slice(0, 80)));
  });

  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/c/xingce/practice',
    async (request) => {
      await ensureUserTables(db);
      const offset = Math.max(0, Math.min(50_000, Number(request.query.offset) || 0));
      const category = request.query.category?.slice(0, 40) ?? '';
      const batchId = request.query.batchId?.slice(0, 80) ?? '';
      const kind = request.query.kind?.slice(0, 20) ?? '';
      const questionId = request.query.question?.slice(0, 160) ?? '';
      if (batchId) {
        const slice = await collectionSlice(db, {
          batchId,
          kind,
          offset,
          limit: 10,
          questionId,
          year: request.query.year?.slice(0, 10) || '',
          region: request.query.region?.slice(0, 40) || '',
          paper: request.query.paper?.slice(0, 80) || '',
          module: request.query.module?.slice(0, 40) || '',
        });
        if (!slice.ids.length) return ok({ questions: [], total: slice.total, offset: slice.offset });
        const rows = await sql<{
          id: string;
          batch_id: string;
          category: string;
          stem: string;
          options_json: string | null;
          answer: string;
          analysis: string | null;
          payload_json: string;
          status: string;
          source: string;
        }>`
          SELECT id, batch_id, category, stem, options_json, answer, analysis, payload_json, status, source
          FROM t_xingce_question
          WHERE delete_flag = 'NOT_DELETE' AND id IN (${sql.join(slice.ids.map((id) => sql`${id}`))})
        `.execute(db);
        const byId = new Map(rows.rows.map((row) => [row.id, practiceQuestion(row)]));
        return ok({
          questions: slice.ids.map((id) => byId.get(id)).filter(Boolean),
          total: slice.total,
          offset: slice.offset,
        });
      }
      const rows = await sql<{
        id: string;
        batch_id: string;
        category: string;
        stem: string;
        options_json: string | null;
        answer: string;
        analysis: string | null;
        payload_json: string;
        status: string;
        source: string;
      }>`
        SELECT id, batch_id, category, stem, options_json, answer, analysis, payload_json, status, source
        FROM t_xingce_question
        WHERE delete_flag = 'NOT_DELETE' AND status = 'published'
          AND (${category} = '' OR category = ${category})
        ORDER BY id ASC
        LIMIT 200 OFFSET ${offset}
      `.execute(db);
      return ok({
        questions: rows.rows.map(practiceQuestion),
        total: rows.rows.length,
        offset,
      });
    },
  );

  app.get('/c/xingce/daily', async (request) => {
    await ensureUserTables(db);
    if ((request.query as { count?: string }).count === '1') {
      const total = await sql<{ total: number }>`
        SELECT COUNT(*) AS total FROM t_xingce_daily_question WHERE delete_flag = 'NOT_DELETE'
      `.execute(db);
      return ok({ total: Number(total.rows[0]?.total ?? 0), questions: [] });
    }
    const rows = await sql<{ id: string; topic: string; question: string; published_date: string }>`
      SELECT id, topic, question, published_date FROM t_xingce_daily_question
      WHERE delete_flag = 'NOT_DELETE' ORDER BY published_date DESC, id ASC LIMIT 500
    `.execute(db);
    return ok({
      questions: rows.rows.map((row) => ({
        id: row.id,
        topic: row.topic,
        question: row.question,
        publishedDate: row.published_date,
      })),
    });
  });

  app.get<{ Params: { id: string } }>('/c/xingce/daily/:id', async (request) => {
    await ensureUserTables(db);
    const rows = await sql<{ payload_json: string }>`
      SELECT payload_json FROM t_xingce_daily_question
      WHERE id = ${request.params.id} AND delete_flag = 'NOT_DELETE'
    `.execute(db);
    if (!rows.rows[0]) throw new AppError(404, '没有这道每日一问');
    return ok(JSON.parse(rows.rows[0].payload_json));
  });

  app.get<{ Params: { id: string } }>('/c/xingce/interviews/:id', async (request) => {
    await ensureUserTables(db);
    const rows = await sql<{ payload_json: string }>`
      SELECT payload_json FROM t_xingce_interview
      WHERE id = ${request.params.id} AND delete_flag = 'NOT_DELETE' AND status = 'published'
    `.execute(db);
    if (!rows.rows[0]) throw new AppError(404, '没有这篇面经');
    return ok(JSON.parse(rows.rows[0].payload_json));
  });

  app.post<{ Body: { invitationCode?: string } }>(
    '/c/xingce/join',
    { preHandler: authenticate },
    async (request) => {
      await ensureUserTables(db);
      const userId = request.userId!;
      const profile = await sql<{ NICKNAME: string | null; NAME: string | null }>`
        SELECT NICKNAME, NAME FROM client_user WHERE ID = ${userId} AND DELETE_FLAG = 'NOT_DELETE'
      `.execute(db);
      const name = (profile.rows[0]?.NICKNAME || profile.rows[0]?.NAME || '同学').slice(0, 60);
      const now = new Date();
      const existing = await sql<{ user_id: string }>`
        SELECT user_id FROM t_xingce_member WHERE user_id = ${userId}
      `.execute(db);
      if (existing.rows[0]) {
        await sql`UPDATE t_xingce_member SET name = ${name} WHERE user_id = ${userId}`.execute(db);
        return ok({ ...(await memberSummary(db, userId, name)), rewardAddedDays: 0 });
      }
      const code = request.body?.invitationCode?.trim() ?? '';
      let inviterId = '';
      if (code) {
        if (!/^[A-Za-z0-9_-]{16,64}$/.test(code)) throw new AppError(400, '邀请码无效');
        const inviter = await sql<{ user_id: string }>`
          SELECT user_id FROM t_xingce_member WHERE invitation_code = ${code}
        `.execute(db);
        if (!inviter.rows[0]) throw new AppError(400, '邀请链接已失效');
        if (inviter.rows[0].user_id === userId) throw new AppError(400, '不能使用自己的邀请链接');
        inviterId = inviter.rows[0].user_id;
      }
      const invitationCode = randomBytes(16).toString('base64url');
      await db.transaction().execute(async (trx) => {
        await sql`
          INSERT INTO t_xingce_member (user_id, name, invitation_code, expires_at, joined_at)
          VALUES (${userId}, ${name}, ${invitationCode}, ${now}, ${now})
        `.execute(trx);
        if (inviterId) {
          await sql`
            INSERT INTO t_xingce_referral (invitee_id, inviter_id, awarded_at)
            VALUES (${userId}, ${inviterId}, ${now})
          `.execute(trx);
          await awardDays(trx, userId, 'invite', `invite:${userId}`, 1, now);
          await awardDays(trx, inviterId, 'invite', `invite-from:${userId}`, 1, now);
        }
      });
      return ok({ ...(await memberSummary(db, userId, name)), rewardAddedDays: inviterId ? 1 : 0 });
    },
  );

  app.get('/c/xingce/me', async (request) => {
    await optionalUser(env, request);
    if (!request.userId) return ok({ authenticated: false });
    await ensureUserTables(db);
    const summary = await memberSummary(db, request.userId, '同学');
    return ok(summary);
  });

  app.get('/c/xingce/progress', { preHandler: authenticate }, async (request) => {
    await ensureUserTables(db);
    const userId = request.userId!;
    const attempts = await sql<{
      question_id: string;
      answer: string;
      correct: number;
      local_date: string;
      created_at: Date;
    }>`
      SELECT question_id, answer, correct, local_date, created_at
      FROM t_xingce_attempt WHERE user_id = ${userId}
      ORDER BY created_at ASC
    `.execute(db);
    const favorites = await sql<{ question_id: string }>`
      SELECT question_id FROM t_xingce_favorite WHERE user_id = ${userId}
    `.execute(db);
    const latest = new Map<string, { answer: string; correct: boolean; at: string }>();
    const heatmap = new Map<string, number>();
    for (const row of attempts.rows) {
      latest.set(row.question_id, {
        answer: row.answer,
        correct: Boolean(row.correct),
        at: new Date(row.created_at).toISOString(),
      });
      heatmap.set(row.local_date, (heatmap.get(row.local_date) ?? 0) + 1);
    }
    return ok({
      favorites: favorites.rows.map((row) => row.question_id),
      latest: [...latest].map(([questionId, value]) => ({ questionId, ...value })),
      heatmap: [...heatmap].map(([date, count]) => ({ date, count })),
      stats: {
        uniqueDone: latest.size,
        totalAttempts: attempts.rows.length,
        correctAttempts: attempts.rows.filter((row) => Boolean(row.correct)).length,
      },
    });
  });

  app.post<{
    Body: { questionId?: string; answer?: string; localDate?: string };
  }>('/c/xingce/attempts', { preHandler: authenticate }, async (request) => {
    await ensureUserTables(db);
    const questionId = String(request.body?.questionId ?? '');
    const answer = String(request.body?.answer ?? '').toUpperCase();
    const localDate = String(request.body?.localDate ?? '');
    if (!/^[\w.-]{1,160}$/.test(questionId) || !/^[A-H]$/.test(answer)) {
      throw new AppError(400, '作答格式无效');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) throw new AppError(400, '日期格式无效');
    const question = await sql<{ answer: string }>`
      SELECT answer FROM t_xingce_question
      WHERE id = ${questionId} AND delete_flag = 'NOT_DELETE' AND status = 'published'
    `.execute(db);
    if (!question.rows[0]) throw new AppError(404, '题目不存在或已下架');
    const correct = question.rows[0].answer === answer ? 1 : 0;
    await sql`
      INSERT INTO t_xingce_attempt (id, user_id, question_id, answer, correct, local_date, created_at)
      VALUES (${randomUUID()}, ${request.userId!}, ${questionId}, ${answer}, ${correct}, ${localDate}, ${new Date()})
    `.execute(db);
    return ok({ correct: Boolean(correct) });
  });

  app.post<{ Body: { questionId?: string; saved?: boolean } }>(
    '/c/xingce/favorites',
    { preHandler: authenticate },
    async (request) => {
      await ensureUserTables(db);
      const questionId = String(request.body?.questionId ?? '');
      if (!/^[\w.-]{1,160}$/.test(questionId)) throw new AppError(400, '题目无效');
      if (request.body?.saved) {
        await sql`
          INSERT IGNORE INTO t_xingce_favorite (user_id, question_id, created_at)
          VALUES (${request.userId!}, ${questionId}, ${new Date()})
        `.execute(db);
      } else {
        await sql`
          DELETE FROM t_xingce_favorite WHERE user_id = ${request.userId!} AND question_id = ${questionId}
        `.execute(db);
      }
      return ok({ saved: Boolean(request.body?.saved) });
    },
  );

  app.post<{
    Body: {
      attempts?: { questionId: string; answer: string; correct: boolean; at: string; localDate: string }[];
      favorites?: string[];
    };
  }>('/c/xingce/progress/import', { preHandler: authenticate }, async (request) => {
    await ensureUserTables(db);
    const userId = request.userId!;
    const attempts = Array.isArray(request.body?.attempts) ? request.body.attempts.slice(0, 500) : [];
    const favorites = Array.isArray(request.body?.favorites) ? request.body.favorites.slice(0, 500) : [];
    let imported = 0;
    for (const attempt of attempts) {
      if (!/^[\w.-]{1,160}$/.test(attempt.questionId) || !/^\d{4}-\d{2}-\d{2}/.test(attempt.at)) continue;
      const server = await sql<{ created_at: Date }>`
        SELECT created_at FROM t_xingce_attempt
        WHERE user_id = ${userId} AND question_id = ${attempt.questionId}
        ORDER BY created_at DESC LIMIT 1
      `.execute(db);
      const serverAt = server.rows[0] ? new Date(server.rows[0].created_at).toISOString() : undefined;
      if (!shouldImportAttempt(serverAt, attempt.at)) continue;
      await sql`
        INSERT INTO t_xingce_attempt (id, user_id, question_id, answer, correct, local_date, created_at)
        VALUES (
          ${randomUUID()}, ${userId}, ${attempt.questionId}, ${String(attempt.answer).slice(0, 8)},
          ${attempt.correct ? 1 : 0}, ${String(attempt.localDate).slice(0, 10)}, ${new Date(attempt.at)}
        )
      `.execute(db);
      imported += 1;
    }
    for (const questionId of favorites) {
      if (!/^[\w.-]{1,160}$/.test(questionId)) continue;
      await sql`
        INSERT IGNORE INTO t_xingce_favorite (user_id, question_id, created_at)
        VALUES (${userId}, ${questionId}, ${new Date()})
      `.execute(db);
    }
    return ok({ imported });
  });

  app.post<{
    Body: { questionId?: string; type?: string; message?: string; suggestion?: string; version?: string };
  }>('/c/xingce/corrections', async (request, reply) => {
    await ensureUserTables(db);
    await optionalUser(env, request);
    const questionId = String(request.body?.questionId ?? '');
    const type = String(request.body?.type ?? '');
    const message = String(request.body?.message ?? '').trim();
    const suggestion = String(request.body?.suggestion ?? '').trim();
    const version = String(request.body?.version ?? '');
    if (!CORRECTION_TYPES.includes(type)) throw new AppError(400, '纠错类型无效');
    if (message.length < 10 || message.length > 2000) throw new AppError(400, '问题说明需为 10–2000 字');
    const question = await sql<{
      stem: string;
      options_json: string | null;
      answer: string;
      analysis: string | null;
      category: string;
      status: string;
    }>`
      SELECT stem, options_json, answer, analysis, category, status FROM t_xingce_question
      WHERE id = ${questionId} AND delete_flag = 'NOT_DELETE' AND status = 'published'
    `.execute(db);
    if (!question.rows[0]) throw new AppError(404, '题目不存在或已下架');
    const current = questionVersion({
      stem: question.rows[0].stem,
      optionsJson: question.rows[0].options_json,
      answer: question.rows[0].answer,
      analysis: question.rows[0].analysis,
      category: question.rows[0].category,
      status: question.rows[0].status,
    });
    if (version !== current) throw new AppError(409, '题目已被更新，请刷新后再提交');
    let guest = guestValue(request);
    if (!request.userId && !guest) {
      guest = randomBytes(24).toString('base64url');
      setGuestCookie(reply, guest);
    }
    await sql`
      INSERT INTO t_xingce_correction (
        id, user_id, guest_hash, question_id, question_version, correction_type, message, suggestion,
        status, created_at
      ) VALUES (
        ${randomUUID()}, ${request.userId ?? null}, ${guest ? hash(guest) : null}, ${questionId},
        ${current}, ${type}, ${message}, ${suggestion.slice(0, 2000)}, 'pending', ${new Date()}
      )
    `.execute(db);
    return ok({ submitted: true });
  });

  app.get('/c/xingce/corrections/mine', async (request) => {
    await ensureUserTables(db);
    await optionalUser(env, request);
    const guest = guestValue(request);
    const rows = await sql<{
      id: string;
      question_id: string;
      correction_type: string;
      message: string;
      status: string;
      review_note: string;
      reward_days: number;
      created_at: Date;
    }>`
      SELECT id, question_id, correction_type, message, status, review_note, reward_days, created_at
      FROM t_xingce_correction
      WHERE user_id = ${request.userId ?? ''} OR guest_hash = ${guest ? hash(guest) : 'none'}
      ORDER BY created_at DESC LIMIT 50
    `.execute(db);
    return ok({
      reports: rows.rows.map((row) => ({
        id: row.id,
        questionId: row.question_id,
        type: row.correction_type,
        message: row.message,
        status: row.status,
        reviewNote: row.review_note,
        rewardDays: row.reward_days,
        createdAt: new Date(row.created_at).toISOString(),
      })),
    });
  });

  app.get<{ Querystring: { status?: string; offset?: string } }>(
    '/c/xingce/admin/corrections',
    { preHandler: adminGuard },
    async (request) => {
      await ensureUserTables(db);
      const requested = request.query.status ?? 'pending';
      const status = ['pending', 'approved', 'rejected', 'all'].includes(requested) ? requested : 'pending';
      const offset = Math.max(0, Math.min(100_000, Math.trunc(Number(request.query.offset) || 0)));
      const pageSize = 20;
      const [rows, counts] = await Promise.all([
        sql<{
          id: string; question_id: string; correction_type: string; message: string; suggestion: string;
          status: string; created_at: Date; review_note: string; reward_days: number; title: string | null;
        }>`
          SELECT r.id, r.question_id, r.correction_type, r.message, r.suggestion, r.status, r.created_at,
            r.review_note, r.reward_days, LEFT(q.stem, 120) AS title
          FROM t_xingce_correction AS r LEFT JOIN t_xingce_question AS q ON q.id = r.question_id
          WHERE ${status} = 'all' OR r.status = ${status}
          ORDER BY r.created_at DESC, r.id DESC LIMIT ${pageSize} OFFSET ${offset}
        `.execute(db),
        sql<{ status: string; total: number }>`SELECT status, COUNT(*) AS total FROM t_xingce_correction GROUP BY status`.execute(db),
      ]);
      return ok({
        counts: Object.fromEntries(counts.rows.map((row) => [row.status, Number(row.total)])),
        pageSize,
        reports: rows.rows.map((row) => ({
          id: row.id, questionId: row.question_id, type: row.correction_type, message: row.message,
          suggestion: row.suggestion, status: row.status, createdAt: new Date(row.created_at).toISOString(),
          reviewNote: row.review_note, rewardDays: row.reward_days, title: row.title || row.question_id,
        })),
      });
    },
  );

  app.post<{
    Params: { id: string };
    Body: { action?: string; note?: string; version?: string; patch?: unknown; stem?: string; answer?: string; analysis?: string; status?: string };
  }>('/c/xingce/admin/corrections/:id', { preHandler: adminGuard }, async (request) => {
    await ensureUserTables(db);
    const body = request.body ?? {};
    const action = body.action;
    if (action !== 'approve' && action !== 'reject' && action !== 'edit') throw new AppError(400, '审核动作无效');
    const note = String(body.note ?? '').trim().slice(0, 1000);
    if (action === 'reject' && note.length < 2) throw new AppError(400, '请填写不采纳的原因');

    const result = await db.transaction().execute(async (trx) => {
      const report = await sql<{
        id: string; user_id: string | null; question_id: string; question_version: string; status: string;
      }>`
        SELECT id, user_id, question_id, question_version, status FROM t_xingce_correction
        WHERE id = ${request.params.id} FOR UPDATE
      `.execute(trx);
      const row = report.rows[0];
      if (!row) throw new AppError(404, '反馈不存在');
      if (row.status !== 'pending') throw new AppError(409, '这条反馈已经处理过');
      const now = new Date();
      const status = action === 'reject' ? 'rejected' : 'approved';

      if (action === 'edit') {
        const question = await getAdminQuestion(trx, row.question_id);
        const patch = body.patch ?? { stem: body.stem, answer: body.answer, analysis: body.analysis };
        await updateLockedQuestion(trx, row.question_id, {
          action: body.status === 'withdrawn' ? 'withdraw' : 'save',
          version: body.version ?? question.version,
          patch,
        });
      }

      let rewarded = false;
      if (status === 'approved' && row.user_id) {
        const key = `correction:${row.user_id}:${row.question_id}:${row.question_version}`;
        const existing = await sql<{ id: string }>`
          SELECT id FROM t_xingce_reward_ledger WHERE source_key = ${key} FOR UPDATE
        `.execute(trx);
        if (!existing.rows[0]) {
          await awardDays(trx, row.user_id, 'correction', key, 3, now);
          rewarded = true;
        }
      }
      await sql`
        UPDATE t_xingce_correction
        SET status = ${status}, review_note = ${note}, reward_days = ${rewarded ? 3 : 0},
            reviewed_at = ${now}, reviewer = ${request.adminId ?? ''}
        WHERE id = ${row.id}
      `.execute(trx);
      return { status, rewarded };
    });
    return ok(result);
  });
}
