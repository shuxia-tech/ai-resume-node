import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { AppEnv } from '@/config/env.js';
import type { Database } from '@/infrastructure/database.js';
import { opsWebhook, postFeishuText } from '@/modules/payment/feishu-notify.js';

type StatRow = {
  todayNewUser: number | string | null;
  monthNewUser: number | string | null;
  totalUser: number | string | null;
  todayIncome: number | string | null;
  monthIncome: number | string | null;
  todayOrderCount: number | string | null;
  monthOrderCount: number | string | null;
  totalOrderCount: number | string | null;
  todayReadSysNotice: number | string | null;
  todayReadActNotice: number | string | null;
  todayReadLikeMsg: number | string | null;
  todayReadCollectMsg: number | string | null;
};

function count(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: number | string | null | undefined) {
  return `${count(value).toFixed(2)} 元`;
}

export function shanghaiClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${read('year')}-${read('month')}-${read('day')}`,
    hour: read('hour'),
    minute: read('minute'),
  };
}

export function operationStatText(row: StatRow) {
  return (
    '📊 AI 简历：运营数据统计\n\n' +
    '👤 用户数据\n' +
    `  - 今日新增用户: ${count(row.todayNewUser)}\n` +
    `  - 本月新增用户: ${count(row.monthNewUser)}\n` +
    `  - 总用户数量: ${count(row.totalUser)}\n\n` +
    '💰 收入数据\n' +
    `  - 今日收入: ${money(row.todayIncome)}\n` +
    `  - 本月收入: ${money(row.monthIncome)}\n` +
    `  - 今日订单数量: ${count(row.todayOrderCount)}\n` +
    `  - 本月订单数量: ${count(row.monthOrderCount)}\n` +
    `  - 总订单数量: ${count(row.totalOrderCount)}\n\n` +
    '📨 消息数据\n' +
    `  - 今日已读系统公告: ${count(row.todayReadSysNotice)}\n` +
    `  - 今日已读活动公告: ${count(row.todayReadActNotice)}\n` +
    `  - 今日已读点赞消息: ${count(row.todayReadLikeMsg)}\n` +
    `  - 今日已读收藏消息: ${count(row.todayReadCollectMsg)}\n`
  );
}

export async function loadOperationStat(db: Kysely<Database>) {
  const result = await sql<StatRow>`
    SELECT
      (SELECT count(*) FROM client_user WHERE TO_DAYS(create_time) = TO_DAYS(now())) AS todayNewUser,
      (SELECT count(*) FROM client_user WHERE YEAR(create_time) = YEAR(CURDATE()) AND MONTH(create_time) = MONTH(CURDATE())) AS monthNewUser,
      (SELECT count(*) FROM client_user WHERE create_time > '2024-07-00') AS totalUser,
      (SELECT SUM(amount) * 0.01 FROM t_payment_order WHERE status = '支付成功' AND TO_DAYS(create_time) = TO_DAYS(now())) AS todayIncome,
      (SELECT SUM(amount) * 0.01 FROM t_payment_order WHERE status = '支付成功' AND YEAR(create_time) = YEAR(CURDATE()) AND MONTH(create_time) = MONTH(CURDATE())) AS monthIncome,
      (SELECT count(*) FROM t_payment_order WHERE status = '支付成功' AND YEAR(create_time) = YEAR(CURDATE()) AND MONTH(create_time) = MONTH(CURDATE()) AND DAY(create_time) = DAY(CURDATE())) AS todayOrderCount,
      (SELECT count(*) FROM t_payment_order WHERE status = '支付成功' AND YEAR(create_time) = YEAR(CURDATE()) AND MONTH(create_time) = MONTH(CURDATE())) AS monthOrderCount,
      (SELECT count(*) FROM t_payment_order WHERE status = '支付成功' AND create_time > '2024-07-24') AS totalOrderCount,
      (SELECT count(*) FROM sc_user_notification WHERE type = '系统公告' AND TO_DAYS(create_time) = TO_DAYS(now())) AS todayReadSysNotice,
      (SELECT count(*) FROM sc_user_notification WHERE type = '活动公告' AND TO_DAYS(create_time) = TO_DAYS(now())) AS todayReadActNotice,
      (SELECT count(*) FROM sc_user_notification WHERE type = '点赞' AND TO_DAYS(create_time) = TO_DAYS(now())) AS todayReadLikeMsg,
      (SELECT count(*) FROM sc_user_notification WHERE type = '收藏' AND TO_DAYS(create_time) = TO_DAYS(now())) AS todayReadCollectMsg
  `.execute(db);
  return result.rows[0];
}

export function registerOperationStatJob(app: FastifyInstance, env: AppEnv, db: Kysely<Database>) {
  const webhook = opsWebhook(env);
  if (!webhook) return;
  let sentDate = '';
  let sending = false;
  const timer = setInterval(() => {
    const clock = shanghaiClock();
    if (clock.hour !== '23' || clock.minute !== '59' || sentDate === clock.date || sending) return;
    sending = true;
    sentDate = clock.date;
    void loadOperationStat(db)
      .then((row) => {
        if (!row) throw new Error('运营统计为空');
        return postFeishuText(webhook, operationStatText(row), app.log, '飞书运营统计');
      })
      .catch((error: unknown) => {
        sentDate = '';
        app.log.error({ err: error }, '飞书运营统计失败');
      })
      .finally(() => {
        sending = false;
      });
  }, 20_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}
