import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { requireUser } from '@/auth/request-user.js';
import { AppError } from '@/common/errors.js';
import { ok } from '@/common/http-response.js';
import type { AppEnv } from '@/config/env.js';
import type { Database } from '@/infrastructure/database.js';
import { requireAdmin } from '@/modules/admin/admin-auth-routes.js';
import { adminPage } from '@/modules/admin/admin-crud.js';

const PENDING = 'PENDING';
const APPROVED = 'APPROVED';
const REJECTED = 'REJECTED';
const PHONE = /^1[3-9]\d{9}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LINK = /^(?:https?:\/\/)\S+$/i;

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS sc_referral_submission (
    id varchar(64) NOT NULL,
    user_id varchar(64) NOT NULL,
    company varchar(100) NOT NULL,
    referral_code varchar(100) NOT NULL,
    referral_method varchar(1000) NOT NULL,
    positions varchar(300) NOT NULL,
    work_location varchar(200) NOT NULL,
    industry varchar(100) NOT NULL,
    referrer_identity varchar(20) NOT NULL,
    contact_name varchar(50) NOT NULL,
    contact_type varchar(20) NOT NULL,
    contact varchar(100) NOT NULL,
    remarks varchar(500) DEFAULT NULL,
    status varchar(20) NOT NULL DEFAULT 'PENDING',
    reject_reason varchar(500) DEFAULT NULL,
    recruitment_id varchar(64) DEFAULT NULL,
    reviewer_id varchar(64) DEFAULT NULL,
    review_time datetime DEFAULT NULL,
    create_time datetime NOT NULL,
    PRIMARY KEY (id),
    KEY idx_referral_submission_status (status, create_time),
    KEY idx_referral_submission_user (user_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='内推投稿'
`;

type SubmissionInput = {
  company: string;
  referralCode: string;
  referralMethod: string;
  positions: string;
  workLocation: string;
  industry: string;
  identity: string;
  name: string;
  contactType: string;
  contact: string;
  remarks: string;
};

type SubmissionRow = SubmissionInput & {
  id: string;
  userId: string;
  status: string;
  rejectReason: string | null;
  recruitmentId: string | null;
  createTime: Date | null;
  reviewTime: Date | null;
};

const SUBMISSION_COLUMNS = sql`
  id, user_id AS userId, company, referral_code AS referralCode, referral_method AS referralMethod,
  positions, work_location AS workLocation, industry, referrer_identity AS identity,
  contact_name AS name, contact_type AS contactType, contact, remarks, status,
  reject_reason AS rejectReason, recruitment_id AS recruitmentId, create_time AS createTime,
  review_time AS reviewTime
`;

let tableReady: Promise<void> | null = null;

function ensureReferralTable(db: Kysely<Database>) {
  tableReady ??= prepareReferralTable(db).catch((error: unknown) => {
    tableReady = null;
    throw error;
  });
  return tableReady;
}

async function prepareReferralTable(db: Kysely<Database>) {
  await sql.raw(CREATE_TABLE_SQL).execute(db);
  const column = await sql<{ total: number | string }>`
    SELECT COUNT(1) AS total FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'sc_referral_submission' AND column_name = 'reject_reason'
  `.execute(db);
  if (Number(column.rows[0]?.total ?? 0) === 0) {
    await sql`ALTER TABLE sc_referral_submission ADD COLUMN reject_reason varchar(500) DEFAULT NULL`.execute(db);
  }
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function required(raw: unknown, label: string, max: number) {
  const value = text(raw);
  if (!value) throw new AppError(400, `请填写${label}`);
  if (value.length > max) throw new AppError(400, `${label}最多${max}字`);
  return value;
}

export function normalizeReferralSubmission(body: unknown): SubmissionInput {
  const source = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  if (!source) throw new AppError(400, '请填写内推信息');
  const company = required(source.company, '公司名称', 100);
  const referralCode = required(source.referralCode, '内推码', 100);
  const referralMethod = required(source.referralMethod, '投递链接', 1000);
  if (!LINK.test(referralMethod)) throw new AppError(400, '投递链接须以 http:// 或 https:// 开头');
  const positions = required(source.positions, '招聘岗位', 300);
  const workLocation = required(source.workLocation, '工作地点', 200);
  const industry = required(source.industry, '所属行业', 100);
  const identity = required(source.identity, '内推人身份', 20);
  if (identity !== '校园大使' && identity !== '企业员工') throw new AppError(400, '请选择校园大使或企业员工');
  const name = required(source.name, '联系人姓名', 50);
  const contactType = required(source.contactType, '联系方式类型', 20);
  const contact = required(source.contact, '联系方式', 100);
  if (contactType === '手机号') {
    if (!PHONE.test(contact)) throw new AppError(400, '请输入有效的11位手机号');
  } else if (contactType === '邮箱') {
    if (!EMAIL.test(contact)) throw new AppError(400, '请输入有效的邮箱地址');
  } else if (contactType !== '微信') {
    throw new AppError(400, '联系方式类型只能是微信、手机号或邮箱');
  }
  const remarks = text(source.remarks);
  if (remarks.length > 500) throw new AppError(400, '补充说明最多500字');
  return {
    company,
    referralCode,
    referralMethod,
    positions,
    workLocation,
    industry,
    identity,
    name,
    contactType,
    contact,
    remarks,
  };
}

function normalizeStatus(status: unknown) {
  const value = text(status);
  if (!value || value.toUpperCase() === 'ALL') return null;
  if (value === PENDING || value === APPROVED || value === REJECTED) return value;
  throw new AppError(400, '不支持的审核状态');
}

function requiredId(body: unknown) {
  const id = body && typeof body === 'object' ? text((body as { id?: unknown }).id) : '';
  if (!id) throw new AppError(400, 'id不能为空');
  return id;
}

function affected(result: { numAffectedRows?: bigint | number }) {
  return Number(result.numAffectedRows ?? 0);
}

async function latestByUser(db: Kysely<Database>, userId: string) {
  const rows = await sql<SubmissionRow>`
    SELECT ${SUBMISSION_COLUMNS} FROM sc_referral_submission
    WHERE user_id = ${userId} ORDER BY create_time DESC LIMIT 1
  `.execute(db);
  return rows.rows[0] ?? null;
}

async function unpublish(db: Kysely<Database>, recruitmentId: string | null) {
  if (!recruitmentId) return;
  await sql`DELETE FROM sc_campus_recruitment WHERE id = ${recruitmentId}`.execute(db);
}

async function removeOtherSubmissions(db: Kysely<Database>, userId: string, keepId: string) {
  const rows = await sql<{ recruitmentId: string | null }>`
    SELECT recruitment_id AS recruitmentId FROM sc_referral_submission
    WHERE user_id = ${userId} AND id <> ${keepId}
  `.execute(db);
  for (const row of rows.rows) await unpublish(db, row.recruitmentId);
  await sql`DELETE FROM sc_referral_submission WHERE user_id = ${userId} AND id <> ${keepId}`.execute(db);
}

async function saveSubmission(db: Kysely<Database>, userId: string, value: SubmissionInput) {
  const existing = await latestByUser(db, userId);
  if (existing?.status === PENDING) throw new AppError(400, '审核中的内推信息不能修改');
  const remarks = value.remarks || null;
  if (!existing) {
    const id = randomUUID().replaceAll('-', '');
    await sql`
      INSERT INTO sc_referral_submission (
        id, user_id, company, referral_code, referral_method, positions, work_location, industry,
        referrer_identity, contact_name, contact_type, contact, remarks, status, create_time
      ) VALUES (
        ${id}, ${userId}, ${value.company}, ${value.referralCode}, ${value.referralMethod}, ${value.positions},
        ${value.workLocation}, ${value.industry}, ${value.identity}, ${value.name}, ${value.contactType},
        ${value.contact}, ${remarks}, ${PENDING}, NOW()
      )
    `.execute(db);
    return id;
  }
  if (existing.status === APPROVED) await unpublish(db, existing.recruitmentId);
  const updated = await sql`
    UPDATE sc_referral_submission SET
      company = ${value.company}, referral_code = ${value.referralCode}, referral_method = ${value.referralMethod},
      positions = ${value.positions}, work_location = ${value.workLocation}, industry = ${value.industry},
      referrer_identity = ${value.identity}, contact_name = ${value.name}, contact_type = ${value.contactType},
      contact = ${value.contact}, remarks = ${remarks}, status = ${PENDING}, reject_reason = NULL,
      recruitment_id = NULL, reviewer_id = NULL, review_time = NULL, create_time = NOW()
    WHERE id = ${existing.id}
  `.execute(db);
  if (affected(updated) !== 1) throw new AppError(400, '投稿状态已变化，请刷新后重试');
  await removeOtherSubmissions(db, userId, existing.id);
  return existing.id;
}

async function requirePending(db: Kysely<Database>, id: string) {
  const rows = await sql<SubmissionRow>`
    SELECT ${SUBMISSION_COLUMNS} FROM sc_referral_submission WHERE id = ${id}
  `.execute(db);
  const submission = rows.rows[0];
  if (!submission) throw new AppError(400, '投稿不存在');
  if (submission.status !== PENDING) throw new AppError(400, '只有待审核的投稿可以处理');
  return submission;
}

export function registerReferralSubmissionRoutes(app: FastifyInstance, env: AppEnv, db: Kysely<Database>) {
  const authenticate = requireUser(env);
  const adminGuard = requireAdmin(env, db);

  app.get('/c/resume/campusRecruitment/referral/submission', { preHandler: authenticate }, async (request) => {
    await ensureReferralTable(db);
    return ok(await latestByUser(db, request.userId!));
  });

  app.post('/c/resume/campusRecruitment/referral/submission', { preHandler: authenticate }, async (request) => {
    const value = normalizeReferralSubmission(request.body);
    await ensureReferralTable(db);
    const current = await latestByUser(db, request.userId!);
    if (current?.status === PENDING) {
      await db.transaction().execute((trx) => removeOtherSubmissions(trx, request.userId!, current.id));
      throw new AppError(400, '审核中的内推信息不能修改');
    }
    const id = await db.transaction().execute((trx) => saveSubmission(trx, request.userId!, value));
    return ok({ id });
  });

  app.get<{ Querystring: { status?: string; current?: string; size?: string } }>(
    '/app/campusrecruitment/referral/submission/page',
    { preHandler: adminGuard },
    async (request) => {
      const status = normalizeStatus(request.query.status);
      const current = Math.max(Number(request.query.current) || 1, 1);
      const size = Math.min(Math.max(Number(request.query.size) || 10, 1), 100);
      await ensureReferralTable(db);
      const where = status ? sql`WHERE status = ${status}` : sql``;
      const total = await sql<{ total: number | string }>`
        SELECT COUNT(1) AS total FROM sc_referral_submission ${where}
      `.execute(db);
      const offset = (current - 1) * size;
      const rows = await sql<SubmissionRow>`
        SELECT ${SUBMISSION_COLUMNS} FROM sc_referral_submission ${where}
        ORDER BY create_time DESC
        LIMIT ${sql.raw(String(offset))}, ${sql.raw(String(size))}
      `.execute(db);
      return ok(adminPage(rows.rows, Number(total.rows[0]?.total ?? 0), current, size));
    },
  );

  app.get('/app/campusrecruitment/referral/submission/pendingCount', { preHandler: adminGuard }, async () => {
    await ensureReferralTable(db);
    const counts = { all: 0, approved: 0, pending: 0, count: 0 };
    const rows = await sql<{ status: string; total: number | string }>`
      SELECT status, COUNT(1) AS total FROM sc_referral_submission GROUP BY status
    `.execute(db);
    for (const row of rows.rows) {
      const total = Number(row.total);
      counts.all += total;
      if (row.status === APPROVED) counts.approved = total;
      if (row.status === PENDING) {
        counts.pending = total;
        counts.count = total;
      }
    }
    return ok(counts);
  });

  app.post('/app/campusrecruitment/referral/submission/approve', { preHandler: adminGuard }, async (request) => {
    const id = requiredId(request.body);
    await ensureReferralTable(db);
    await db.transaction().execute(async (trx) => {
      const submission = await requirePending(trx, id);
      await unpublish(trx, submission.recruitmentId);
      const recruitmentId = randomUUID().replaceAll('-', '');
      const now = new Date();
      await trx
        .insertInto('sc_campus_recruitment')
        .values({
          id: recruitmentId,
          company: submission.company,
          referral_code: submission.referralCode,
          referral_method: submission.referralMethod,
          positions: submission.positions,
          work_location: submission.workLocation,
          industry: submission.industry,
          title: null,
          progress_check: null,
          remarks: submission.remarks || null,
          main_business: null,
          info_type: '内推',
          record_time: now,
          expiration_time: null,
          create_time: now,
          update_time: now,
        })
        .execute();
      const updated = await sql`
        UPDATE sc_referral_submission
        SET status = ${APPROVED}, recruitment_id = ${recruitmentId}, reviewer_id = ${request.adminId ?? null},
            review_time = NOW(), reject_reason = NULL
        WHERE id = ${id} AND status = ${PENDING}
      `.execute(trx);
      if (affected(updated) !== 1) throw new AppError(400, '投稿状态已变化，请刷新后重试');
    });
    return ok(null);
  });

  app.post('/app/campusrecruitment/referral/submission/reject', { preHandler: adminGuard }, async (request) => {
    const id = requiredId(request.body);
    const reason = required(
      request.body && typeof request.body === 'object' ? (request.body as { reason?: unknown }).reason : '',
      '驳回原因',
      500,
    );
    await ensureReferralTable(db);
    await requirePending(db, id);
    const updated = await sql`
      UPDATE sc_referral_submission
      SET status = ${REJECTED}, reject_reason = ${reason}, reviewer_id = ${request.adminId ?? null}, review_time = NOW()
      WHERE id = ${id} AND status = ${PENDING}
    `.execute(db);
    if (affected(updated) !== 1) throw new AppError(400, '投稿状态已变化，请刷新后重试');
    return ok(null);
  });

  app.post('/app/campusrecruitment/referral/submission/delete', { preHandler: adminGuard }, async (request) => {
    const id = requiredId(request.body);
    await ensureReferralTable(db);
    await db.transaction().execute(async (trx) => {
      const rows = await sql<{ recruitmentId: string | null }>`
        SELECT recruitment_id AS recruitmentId FROM sc_referral_submission WHERE id = ${id}
      `.execute(trx);
      if (!rows.rows.length) throw new AppError(400, '投稿不存在');
      await unpublish(trx, rows.rows[0]?.recruitmentId ?? null);
      const deleted = await sql`DELETE FROM sc_referral_submission WHERE id = ${id}`.execute(trx);
      if (affected(deleted) !== 1) throw new AppError(400, '投稿不存在');
    });
    return ok(null);
  });
}
