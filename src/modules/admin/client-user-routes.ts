import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { sql, type RawBuilder } from 'kysely';
import { requireAdmin } from '@/modules/admin/admin-auth-routes.js';
import { ok } from '@/common/http-response.js';
import type { AppEnv } from '@/config/env.js';
import type { Database } from '@/infrastructure/database.js';

type TimeQuery = {
  startDate?: string;
  endDate?: string;
  current?: string;
  size?: string;
  nickname?: string;
};

function pageNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function dateRange(query: TimeQuery): { start: string; end: string } | null {
  const start = query.startDate?.trim() ?? '';
  const end = query.endDate?.trim() ?? '';
  if (!start || !end) return null;
  return { start, end };
}

function dateFilter(column: RawBuilder<unknown>, range: { start: string; end: string } | null): RawBuilder<unknown> {
  if (!range) return sql``;
  return sql`AND ${column} BETWEEN ${range.start} AND ${range.end}`;
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mybatisPage<T>(records: T[], total: number, current: number, size: number) {
  return {
    records,
    total,
    size,
    current,
    pages: size > 0 ? Math.ceil(total / size) : 0,
  };
}

export function registerClientUserAdminRoutes(
  app: FastifyInstance,
  env: AppEnv,
  db: Kysely<Database>,
): void {
  const adminGuard = requireAdmin(env, db);

  app.get<{ Querystring: TimeQuery }>(
    '/client/user/distribution/rank',
    { preHandler: adminGuard },
    async (request) => ok(await listDistributionRank(db, request)),
  );

  app.get<{ Querystring: TimeQuery }>(
    '/client/user/distribution/stat',
    { preHandler: adminGuard },
    async (request) => ok(await getTotalDistributionStat(db, request.query)),
  );
}

async function listDistributionRank(db: Kysely<Database>, request: FastifyRequest<{ Querystring: TimeQuery }>) {
  const current = pageNumber(request.query.current, 1);
  const size = Math.min(pageNumber(request.query.size, 10), 200);
  const offset = (current - 1) * size;
  const range = dateRange(request.query);
  const nickname = request.query.nickname?.trim() ?? '';
  const nicknameFilter = () => (nickname ? sql`AND cu.NICKNAME LIKE ${`%${nickname}%`}` : sql``);

  const countRow = await sql<{ total: number | string }>`
    SELECT COUNT(*) AS total
    FROM client_user cu
    WHERE cu.has_distribution_promo_code = TRUE
      AND cu.delete_flag = 'NOT_DELETE'
      ${nicknameFilter()}
  `.execute(db);

  const rows = await sql<{
    userId: string;
    avatar: string | null;
    nickname: string | null;
    totalRebateAmount: number | string | null;
    primaryRebateAmount: number | string | null;
    subReferralRebateAmount: number | string | null;
    orderCount: number | string | null;
    withdrawnRebateAmount: number | string | null;
    totalInvitedUsers: number | string | null;
    paidConversionRate: number | string | null;
  }>`
    SELECT
      cu.id AS userId,
      cu.avatar AS avatar,
      cu.NICKNAME AS nickname,
      COALESCE(ir_stat.total_rebate_amount, 0) AS totalRebateAmount,
      COALESCE(ir_stat.primary_rebate_amount, 0) AS primaryRebateAmount,
      COALESCE(ir_stat.sub_referral_rebate_amount, 0) AS subReferralRebateAmount,
      COALESCE(ir_stat.order_count, 0) AS orderCount,
      COALESCE(cu.withdrawn_rebate_amount, 0) AS withdrawnRebateAmount,
      COALESCE(fr_stat.total_invited_users, 0) AS totalInvitedUsers,
      IF(
        COALESCE(fr_stat.total_invited_users, 0) = 0,
        0,
        COALESCE(ir_stat.paid_user_count, 0) / fr_stat.total_invited_users * 100
      ) AS paidConversionRate
    FROM client_user cu
    LEFT JOIN (
      SELECT
        user_id,
        COUNT(id) AS order_count,
        SUM(rebate_amount) AS total_rebate_amount,
        SUM(CASE WHEN category != '二级返佣' THEN rebate_amount ELSE 0 END) AS primary_rebate_amount,
        SUM(CASE WHEN category = '二级返佣' THEN rebate_amount ELSE 0 END) AS sub_referral_rebate_amount,
        COUNT(DISTINCT CASE WHEN recharged_amount > 0 THEN target_user_id END) AS paid_user_count
      FROM t_invitation_records
      WHERE (delete_flag = 'NOT_DELETE' OR delete_flag IS NULL)
        ${dateFilter(sql`create_time`, range)}
      GROUP BY user_id
    ) ir_stat ON cu.id = ir_stat.user_id
    LEFT JOIN (
      SELECT
        user_id,
        COUNT(DISTINCT target_id) AS total_invited_users
      FROM t_front_relation
      WHERE category IN ('用户优惠码关联', '用户邀请码关联')
        ${dateFilter(sql`create_time`, range)}
      GROUP BY user_id
    ) fr_stat ON cu.id = fr_stat.user_id
    WHERE cu.has_distribution_promo_code = TRUE
      AND cu.delete_flag = 'NOT_DELETE'
      ${nicknameFilter()}
    ORDER BY totalRebateAmount DESC, totalInvitedUsers DESC
    LIMIT ${size} OFFSET ${offset}
  `.execute(db);

  return mybatisPage(
    rows.rows.map((row) => ({
      userId: row.userId,
      avatar: row.avatar,
      nickname: row.nickname,
      totalRebateAmount: numberValue(row.totalRebateAmount),
      withdrawnRebateAmount: numberValue(row.withdrawnRebateAmount),
      totalInvitedUsers: numberValue(row.totalInvitedUsers),
      paidConversionRate: numberValue(row.paidConversionRate),
      primaryRebateAmount: numberValue(row.primaryRebateAmount),
      subReferralRebateAmount: numberValue(row.subReferralRebateAmount),
      orderCount: numberValue(row.orderCount),
    })),
    numberValue(countRow.rows[0]?.total),
    current,
    size,
  );
}

async function getTotalDistributionStat(db: Kysely<Database>, query: TimeQuery) {
  const range = dateRange(query);
  const invitedUsers = () => sql`
        SELECT COUNT(DISTINCT fr.target_id)
        FROM t_front_relation fr
        WHERE fr.category IN ('用户优惠码关联', '用户邀请码关联')
          ${dateFilter(sql`fr.create_time`, range)}
      `;

  const result = await sql<{
    totalOrderCount: number | string | null;
    totalInvitedUsers: number | string | null;
    totalRebateAmount: number | string | null;
    primaryRebateAmount: number | string | null;
    subReferralRebateAmount: number | string | null;
    withdrawnRebateAmount: number | string | null;
    pendingRebateAmount: number | string | null;
    paidConversionRate: number | string | null;
  }>`
    SELECT
      COUNT(ir.id) AS totalOrderCount,
      (${invitedUsers()}) AS totalInvitedUsers,
      COALESCE(SUM(ir.rebate_amount), 0) AS totalRebateAmount,
      COALESCE(SUM(CASE WHEN ir.category != '二级返佣' THEN ir.rebate_amount ELSE 0 END), 0) AS primaryRebateAmount,
      COALESCE(SUM(CASE WHEN ir.category = '二级返佣' THEN ir.rebate_amount ELSE 0 END), 0) AS subReferralRebateAmount,
      COALESCE(SUM(cu.withdrawn_rebate_amount), 0) AS withdrawnRebateAmount,
      COALESCE(SUM(ir.rebate_amount) - SUM(cu.withdrawn_rebate_amount), 0) AS pendingRebateAmount,
      IF(
        (${invitedUsers()}) = 0,
        0,
        COUNT(DISTINCT CASE WHEN ir.recharged_amount > 0 THEN ir.target_user_id END) /
        (${invitedUsers()}) * 100
      ) AS paidConversionRate
    FROM client_user cu
    LEFT JOIN t_invitation_records ir
      ON cu.id = ir.user_id
      ${dateFilter(sql`ir.create_time`, range)}
      AND (ir.delete_flag = 'NOT_DELETE' OR ir.delete_flag IS NULL)
    WHERE cu.has_distribution_promo_code = TRUE
      AND cu.delete_flag = 'NOT_DELETE'
      AND (ir.delete_flag = 'NOT_DELETE' OR ir.delete_flag IS NULL)
      ${dateFilter(sql`ir.create_time`, range)}
  `.execute(db);

  const row = result.rows[0];
  return {
    totalOrderCount: numberValue(row?.totalOrderCount),
    totalInvitedUsers: numberValue(row?.totalInvitedUsers),
    totalRebateAmount: numberValue(row?.totalRebateAmount),
    primaryRebateAmount: numberValue(row?.primaryRebateAmount),
    subReferralRebateAmount: numberValue(row?.subReferralRebateAmount),
    withdrawnRebateAmount: numberValue(row?.withdrawnRebateAmount),
    pendingRebateAmount: numberValue(row?.pendingRebateAmount),
    paidConversionRate: numberValue(row?.paidConversionRate),
  };
}
