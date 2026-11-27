import type { FastifyInstance } from 'fastify';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { AppError } from '@/common/errors.js';
import { ok } from '@/common/http-response.js';
import type { AppEnv } from '@/config/env.js';
import type { Database } from '@/infrastructure/database.js';
import { adminPage, pageArgs, queryText } from '@/modules/admin/admin-crud.js';
import { requireAdmin } from '@/modules/admin/admin-auth-routes.js';

type OrderQuery = {
  current?: unknown;
  size?: unknown;
  orderNo?: unknown;
  nickname?: unknown;
  userId?: unknown;
  startCreateTime?: unknown;
  endCreateTime?: unknown;
};

type OrderRow = {
  id: string;
  orderNo: string;
  userId: string | null;
  nickname: string | null;
  avatar: string | null;
  packageName: string | null;
  product: string | null;
  payChannel: string | null;
  status: string | null;
  amount: number | string | null;
  createTime: Date | string | null;
};

export function orderAmountYuan(amount: unknown, payChannel: string | null | undefined): number {
  const value = Number(amount);
  if (!Number.isFinite(value)) return 0;
  const channel = (payChannel ?? '').trim().toLowerCase();
  const storedAsYuan = channel.includes('stripe') || channel === 'mock';
  const yuan = storedAsYuan ? value : value / 100;
  return Math.round(yuan * 100) / 100;
}

export function shanghaiMonthRange(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const start = `${year}-${String(month).padStart(2, '0')}-01 00:00:00`;
  const next = new Date(Date.UTC(year, month, 1));
  const end = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01 00:00:00`;
  return { start, end, label: `${year}-${String(month).padStart(2, '0')}` };
}

function productName(value: string | null) {
  if (!value) return null;
  const text = value.trim();
  if (!text.startsWith('{')) return text;
  try {
    const parsed = JSON.parse(text) as { category?: unknown; webName?: unknown };
    if (typeof parsed.category === 'string' && parsed.category) return parsed.category;
    if (typeof parsed.webName === 'string' && parsed.webName) return parsed.webName;
  } catch {
    return null;
  }
  return null;
}

function dateText(value: unknown, label: string) {
  const text = queryText(value);
  if (!text) return '';
  if (!/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/.test(text)) {
    throw new AppError(400, `${label}格式不正确`);
  }
  return text.length === 10 ? `${text} ${label.startsWith('结束') ? '23:59:59' : '00:00:00'}` : text;
}

function filters(query: OrderQuery, range?: { start: string; end: string }) {
  const parts: RawBuilder<unknown>[] = [sql`o.delete_flag = 'NOT_DELETE'`];
  const orderNo = queryText(query.orderNo);
  const nickname = queryText(query.nickname);
  const userId = queryText(query.userId);
  if (orderNo) parts.push(sql`o.order_no LIKE ${`%${orderNo}%`}`);
  if (nickname) parts.push(sql`cu.NICKNAME LIKE ${`%${nickname}%`}`);
  if (userId) parts.push(sql`o.user_id = ${userId}`);
  if (range) {
    parts.push(sql`o.create_time >= ${range.start}`);
    parts.push(sql`o.create_time < ${range.end}`);
  } else {
    const start = dateText(query.startCreateTime, '开始时间');
    const end = dateText(query.endCreateTime, '结束时间');
    if (start) parts.push(sql`o.create_time >= ${start}`);
    if (end) parts.push(sql`o.create_time <= ${end}`);
  }
  return sql.join(parts, sql` AND `);
}

const amountYuan = sql`
  CASE
    WHEN LOWER(IFNULL(o.pay_channel, '')) LIKE '%stripe%' OR LOWER(o.pay_channel) = 'mock'
      THEN o.amount
    ELSE o.amount / 100
  END
`;

export function registerPaymentOrderAdminRoutes(
  app: FastifyInstance,
  env: AppEnv,
  db: Kysely<Database>,
) {
  const adminGuard = requireAdmin(env, db);

  app.get<{ Querystring: OrderQuery }>(
    '/app/paymentorder/statistics',
    { preHandler: adminGuard },
    async (request) => {
      const month = shanghaiMonthRange();
      const where = filters({}, month);
      const result = await sql<{ income: number | string | null; paidCount: number | string | null }>`
        SELECT COALESCE(SUM(${amountYuan}), 0) AS income, COUNT(*) AS paidCount
        FROM t_payment_order o
        LEFT JOIN client_user cu ON cu.ID = o.user_id AND cu.DELETE_FLAG = 'NOT_DELETE'
        WHERE ${where} AND o.status = '支付成功'
      `.execute(db);
      const row = result.rows[0];
      return ok({
        month: month.label,
        monthIncome: Math.round(Number(row?.income ?? 0) * 100) / 100,
        monthPaidCount: Number(row?.paidCount ?? 0),
      });
    },
  );

  app.get<{ Querystring: OrderQuery }>(
    '/app/paymentorder/page',
    { preHandler: adminGuard },
    async (request) => {
      const { current, size, offset } = pageArgs(request.query);
      const where = filters(request.query);
      const from = sql`
        FROM t_payment_order o
        LEFT JOIN client_user cu ON cu.ID = o.user_id AND cu.DELETE_FLAG = 'NOT_DELETE'
        LEFT JOIN sc_member_package p ON p.id = o.product_id AND p.delete_flag = 'NOT_DELETE'
        WHERE ${where}
      `;
      const total = await sql<{ total: number }>`SELECT COUNT(*) AS total ${from}`.execute(db);
      const rows = await sql<OrderRow>`
        SELECT
          o.id AS id,
          o.order_no AS orderNo,
          o.user_id AS userId,
          cu.NICKNAME AS nickname,
          cu.AVATAR AS avatar,
          p.package_name AS packageName,
          COALESCE(NULLIF(p.ext_json, ''), o.remark) AS product,
          o.pay_channel AS payChannel,
          o.status AS status,
          ROUND(${amountYuan}, 2) AS amount,
          o.create_time AS createTime
        ${from}
        ORDER BY o.create_time DESC, o.id DESC
        LIMIT ${size} OFFSET ${offset}
      `.execute(db);
      return ok(
        adminPage(
          rows.rows.map((row) => ({
            ...row,
            amount: Math.round(Number(row.amount ?? 0) * 100) / 100,
            product: productName(row.product),
          })),
          Number(total.rows[0]?.total ?? 0),
          current,
          size,
        ),
      );
    },
  );
}
