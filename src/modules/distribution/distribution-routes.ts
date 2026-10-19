import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { readRedisSetSize, requireUser } from '@/auth/request-user.js';
import { ok } from '@/common/http-response.js';
import type { AppEnv } from '@/config/env.js';
import type { Database } from '@/infrastructure/database.js';

type DistributionQuery = { page?: string; limit?: string; userNameKeyword?: string };

function pageValue(value: string | undefined, fallback: number, max: number) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function pageData<T>(records: T[], total: number, current: number, size: number) {
  return {
    page: current,
    limit: size,
    totalPage: Math.ceil(total / size),
    total,
    list: records,
    reservedObject: null,
  };
}

function numberValue(value: unknown) {
  return Number(value ?? 0);
}

function maskUserName(userName: string | null) {
  if (!userName) return userName;
  if (userName.length === 1) return userName;
  return `${userName.charAt(0)}***`;
}

export function registerDistributionRoutes(
  app: FastifyInstance,
  env: AppEnv,
  db: Kysely<Database>,
) {
  const authenticate = requireUser(env);

  app.get('/c/resume/distribution/stat', { preHandler: authenticate }, async (request) => {
    const userId = request.userId as string;
    const [user, aggregate, relationCount, redeem] = await Promise.all([
      db
        .selectFrom('client_user')
        .select([
          'invitation_code as invitationCode',
          'has_distribution_promo_code as hasDistributionPromoCode',
          'withdrawn_rebate_amount as withdrawnRebateAmount',
        ] as const)
        .where('ID', '=', userId)
        .where('DELETE_FLAG', '=', 'NOT_DELETE')
        .executeTakeFirst(),
      db
        .selectFrom('t_invitation_records')
        .select([
          sql<number>`count(*)`.as('orderTotalCount'),
          sql<number>`coalesce(sum(case when category = '二级返佣' then rebate_amount else 0 end), 0)`.as(
            'subReferralRebateRate',
          ),
          sql<number>`coalesce(sum(case when category = '邀请码' then recharged_amount else 0 end), 0)`.as(
            'inviteRechargeTotalAmount',
          ),
          sql<number>`coalesce(sum(case when category = '邀请码' then rebate_amount else 0 end), 0)`.as(
            'inviteRebateTotalAmount',
          ),
          sql<number>`coalesce(sum(case when category = '优惠码' then recharged_amount else 0 end), 0)`.as(
            'discountsRechargeTotalAmount',
          ),
          sql<number>`coalesce(sum(case when category = '优惠码' then rebate_amount else 0 end), 0)`.as(
            'discountsRebateTotalAmount',
          ),
        ])
        .where('user_id', '=', userId)
        .where('delete_flag', '=', 'NOT_DELETE')
        .executeTakeFirst(),
      db
        .selectFrom('t_front_relation')
        .select(sql<number>`count(distinct target_id)`.as('count'))
        .where('user_id', '=', userId)
        .where('category', 'in', ['用户优惠码关联', '用户邀请码关联'])
        .executeTakeFirst(),
      db
        .selectFrom('t_redeem_code')
        .select(['code', 'rebate_rate as rebateRate', 'ext_json as extJson'])
        .where('user_id', '=', userId)
        .where('delete_flag', '=', 'NOT_DELETE')
        .orderBy('create_time', 'desc')
        .executeTakeFirst(),
    ]);
    const inviteRebate = numberValue(aggregate?.inviteRebateTotalAmount);
    const subRebate = numberValue(aggregate?.subReferralRebateRate);
    const total = inviteRebate + subRebate;
    const withdrawn = numberValue(user?.withdrawnRebateAmount);
    const invitationCode = user?.invitationCode ?? null;
    const ipCount = invitationCode
      ? await readRedisSetSize(env, `InvitationUserList_${invitationCode}`)
      : 0;
    let discountRebate = 0;
    if (redeem?.extJson) {
      try {
        discountRebate = numberValue(JSON.parse(redeem.extJson));
      } catch {
        discountRebate = numberValue(redeem.extJson);
      }
    }
    return ok({
      orderTotalCount: numberValue(aggregate?.orderTotalCount),
      ipCount,
      userCount: numberValue(relationCount?.count),
      inviteRechargeTotalAmount: numberValue(aggregate?.inviteRechargeTotalAmount),
      inviteRebateTotalAmount: inviteRebate,
      discountsRechargeTotalAmount: numberValue(aggregate?.discountsRechargeTotalAmount),
      discountsRebateTotalAmount: numberValue(aggregate?.discountsRebateTotalAmount),
      subReferralRebateRate: subRebate,
      inviteTotalEarnings: total,
      withdrawnRebateAmount: withdrawn,
      availableRebateAmount: total - withdrawn,
      hasDistributionPromoCode: Boolean(user?.hasDistributionPromoCode),
      discountsCode: redeem?.code ?? null,
      discountsCodeRebateRate: redeem?.rebateRate ?? null,
      discountRebate,
      invitationCode: user?.invitationCode ?? null,
    });
  });

  app.get('/c/resume/invitationRecords', { preHandler: authenticate }, async (request) => {
    const query = request.query as DistributionQuery;
    const current = pageValue(query.page, 1, 10_000);
    const size = pageValue(query.limit, 10, 100);
    const userId = request.userId as string;
    const base = db
      .selectFrom('t_invitation_records')
      .select([
        'id',
        'delete_flag as deleteFlag',
        'create_time as createTime',
        'user_id as userId',
        'target_user_id as targetUserId',
        'invitation_code as invitationCode',
        'ip',
        'recharged_amount as rechargedAmount',
        'category',
        'rebate_amount as rebateAmount',
        'rebate_rate as rebateRate',
      ] as const)
      .where('user_id', '=', userId)
      .where('delete_flag', '=', 'NOT_DELETE');
    const [records, count] = await Promise.all([
      base
        .orderBy('create_time', 'desc')
        .limit(size)
        .offset((current - 1) * size)
        .execute(),
      db
        .selectFrom('t_invitation_records')
        .select(sql<number>`count(*)`.as('count'))
        .where('user_id', '=', userId)
        .where('delete_flag', '=', 'NOT_DELETE')
        .executeTakeFirst(),
    ]);
    return ok(pageData(records, numberValue(count?.count), current, size));
  });

  app.get('/c/resume/invitedUserDetails', { preHandler: authenticate }, async (request) => {
    const query = request.query as DistributionQuery;
    const current = pageValue(query.page, 1, 10_000);
    const size = pageValue(query.limit, 10, 100);
    const userId = request.userId as string;
    const keyword = query.userNameKeyword?.trim() ?? '';
    const keywordFilter = keyword ? sql`AND cu.name LIKE ${`%${keyword}%`}` : sql``;
    const records = await sql<{
      userId: string;
      userName: string | null;
      totalConsumption: number | string | null;
      rebateAmount: number | string | null;
      inviteTime: string | null;
      userStatus: string | null;
    }>`
      SELECT
        cu.id AS userId,
        cu.NICKNAME AS userName,
        COALESCE(recharge_sum.totalConsumption, 0) AS totalConsumption,
        COALESCE(rebate_sum.rebateAmount, 0) AS rebateAmount,
        DATE_FORMAT(MIN(fr.create_time), '%Y-%m-%d %H:%i:%s') AS inviteTime,
        cu.user_status AS userStatus
      FROM client_user cu
      INNER JOIN t_front_relation fr
        ON fr.target_id = cu.id
        AND fr.user_id = ${userId}
        AND fr.category IN ('用户优惠码关联', '用户邀请码关联')
      LEFT JOIN (
        SELECT user_id, SUM(amount / 100) AS totalConsumption
        FROM t_recharge_record
        WHERE DELETE_FLAG = 'NOT_DELETE'
        GROUP BY user_id
      ) recharge_sum ON recharge_sum.user_id = cu.id
      LEFT JOIN (
        SELECT target_user_id, SUM(rebate_amount) AS rebateAmount
        FROM t_invitation_records
        WHERE user_id = ${userId}
          AND DELETE_FLAG = 'NOT_DELETE'
        GROUP BY target_user_id
      ) rebate_sum ON rebate_sum.target_user_id = cu.id
      WHERE cu.delete_flag = 'NOT_DELETE'
        ${keywordFilter}
      GROUP BY cu.id, cu.NICKNAME, cu.user_status, recharge_sum.totalConsumption, rebate_sum.rebateAmount
      ORDER BY rebateAmount DESC
      LIMIT ${size} OFFSET ${(current - 1) * size}
    `.execute(db);
    const count = await sql<{ count: number | string }>`
      SELECT COUNT(DISTINCT cu.id) AS count
      FROM client_user cu
      INNER JOIN t_front_relation fr
        ON fr.target_id = cu.id
        AND fr.user_id = ${userId}
        AND fr.category IN ('用户优惠码关联', '用户邀请码关联')
      WHERE cu.delete_flag = 'NOT_DELETE'
        ${keywordFilter}
    `.execute(db);
    return ok(
      pageData(
        records.rows.map((record) => ({
          userId: record.userId == null ? record.userId : String(record.userId),
          userName: maskUserName(record.userName),
          totalConsumption: numberValue(record.totalConsumption),
          rebateAmount: numberValue(record.rebateAmount),
          inviteTime: record.inviteTime,
          userStatus: record.userStatus,
        })),
        numberValue(count.rows[0]?.count),
        current,
        size,
      ),
    );
  });

  app.get<{ Params: { invitationCode: string } }>(
    '/c/resume/redeemCode/:invitationCode',
    async (request) => {
      const row = await db
        .selectFrom('client_user as cu')
        .innerJoin('t_redeem_code as rc', 'cu.ID', 'rc.user_id')
        .select(['cu.AVATAR as avatar', 'cu.NICKNAME as nickname', 'rc.code'])
        .where('cu.invitation_code', '=', request.params.invitationCode)
        .where('cu.DELETE_FLAG', '=', 'NOT_DELETE')
        .where('rc.delete_flag', '=', 'NOT_DELETE')
        .orderBy('rc.create_time', 'desc')
        .executeTakeFirst();
      return ok(row ?? null);
    },
  );
}
