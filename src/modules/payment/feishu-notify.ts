import type { FastifyBaseLogger } from 'fastify';
import type { Kysely } from 'kysely';
import { fetchWithTimeout } from '@/common/http-client.js';
import type { AppEnv } from '@/config/env.js';
import type { Database } from '@/infrastructure/database.js';

const JAVA_ORDER_WEBHOOK =
  'https://open.feishu.cn/open-apis/bot/v2/hook/e2531cf7-337f-40e8-abc8-b11360a2b32c';
const JAVA_OPS_WEBHOOK =
  'https://open.feishu.cn/open-apis/bot/v2/hook/9a137728-64e6-46d8-9d6e-145adbe5f19c';

export function orderWebhook(env: Pick<AppEnv, 'NODE_ENV' | 'FEISHU_ORDER_WEBHOOK_URL'>) {
  return env.FEISHU_ORDER_WEBHOOK_URL ?? (env.NODE_ENV === 'production' ? JAVA_ORDER_WEBHOOK : undefined);
}

export function opsWebhook(env: Pick<AppEnv, 'NODE_ENV' | 'FEISHU_OPS_WEBHOOK_URL'>) {
  return env.FEISHU_OPS_WEBHOOK_URL ?? (env.NODE_ENV === 'production' ? JAVA_OPS_WEBHOOK : undefined);
}

export function formatPayYuan(amountFen: number) {
  const yuan = amountFen / 100;
  return Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2);
}

export function paymentSuccessText(input: {
  userId: string;
  nickname?: string | null | undefined;
  amountFen: number;
  packageName: string;
}) {
  return `用户：${input.userId}_${input.nickname?.trim() || ''}，支付成功，支付金额：${formatPayYuan(input.amountFen)}，套餐：${input.packageName}`;
}

export async function postFeishuText(webhook: string, text: string, log: FastifyBaseLogger, label: string) {
  const response = await fetchWithTimeout(
    webhook,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }),
    },
    5_000,
  );
  const body = await response.text();
  let accepted = response.ok;
  try {
    const payload = JSON.parse(body) as { code?: number; StatusCode?: number };
    if (payload.code !== undefined) accepted = payload.code === 0;
    else if (payload.StatusCode !== undefined) accepted = payload.StatusCode === 0;
  } catch {
    accepted = false;
  }
  if (!accepted) {
    log.warn({ status: response.status, body: body.slice(0, 300) }, `${label}失败`);
    return false;
  }
  log.info(`${label}已发送`);
  return true;
}

export async function notifyPaymentSuccess(
  env: AppEnv,
  db: Kysely<Database>,
  log: FastifyBaseLogger,
  input: { userId: string; amountFen: number; packageName: string },
) {
  const webhook = orderWebhook(env);
  if (!webhook) return;
  try {
    const user = await db
      .selectFrom('client_user')
      .select('NICKNAME')
      .where('ID', '=', input.userId)
      .executeTakeFirst();
    await postFeishuText(
      webhook,
      paymentSuccessText({
        userId: input.userId,
        nickname: user?.NICKNAME,
        amountFen: input.amountFen,
        packageName: input.packageName,
      }),
      log,
      '飞书支付通知',
    );
  } catch (error) {
    log.warn({ err: error }, '飞书支付通知失败');
  }
}
