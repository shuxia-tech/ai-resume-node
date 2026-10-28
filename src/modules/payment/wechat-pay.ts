import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { toBuffer } from 'qrcode';
import { AppError } from '@/common/errors.js';
import { fetchWithTimeout } from '@/common/http-client.js';

const UNIFIED_ORDER_URL = 'https://api.mch.weixin.qq.com/pay/unifiedorder';
const ORDER_QUERY_URL = 'https://api.mch.weixin.qq.com/pay/orderquery';

export type WechatPayConfig = {
  appId: string;
  mchId: string;
  mchKey: string;
  notifyUrl: string;
};

export function signWechatParams(fields: Record<string, string>, mchKey: string): string {
  const plain = Object.keys(fields)
    .filter((key) => key !== 'sign' && fields[key] !== '')
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('&');
  return createHash('md5').update(`${plain}&key=${mchKey}`).digest('hex').toUpperCase();
}

export function verifyWechatSign(fields: Record<string, string>, mchKey: string): boolean {
  const given = fields.sign;
  if (!given) return false;
  const expected = signWechatParams(fields, mchKey);
  const actual = Buffer.from(given);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length) return false;
  return timingSafeEqual(actual, wanted);
}

export function buildWechatXml(fields: Record<string, string>): string {
  const body = Object.entries(fields)
    .map(
      ([key, value]) =>
        `<${key}><![CDATA[${value.replaceAll(']]>', ']]]]><![CDATA[>')}]]></${key}>`,
    )
    .join('');
  return `<xml>${body}</xml>`;
}

export function wechatNotifyXml(success: boolean, message: string): string {
  return buildWechatXml({
    return_code: success ? 'SUCCESS' : 'FAIL',
    return_msg: message,
  });
}

export function parseWechatXml(xml: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const pattern = /<([A-Za-z0-9_]+)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g;
  for (const match of xml.matchAll(pattern)) {
    const key = match[1];
    if (!key) continue;
    fields[key] = match[2] ?? match[3] ?? '';
  }
  return fields;
}

export function wechatClientIp(ip: string | undefined): string {
  const value = ip?.replace(/^::ffff:/, '') ?? '';
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) ? value : '127.0.0.1';
}

export function paymentNotifyUrl(base: string, webName: string | undefined): string {
  const trimmed = base.replace(/\/$/, '');
  if (webName === 'offer') return `${trimmed}/offer`;
  if (webName === 'photo') return `${trimmed}/photo`;
  return trimmed;
}

export function chargeFen(input: {
  currentAmount: number;
  packageId: string;
  webName: string | undefined;
  billingMode: string | null;
  createdAt: Date | string | null;
  redeemRate: number | null;
  redeemApplies: boolean;
}): { fen: number; usedRedeem: boolean } {
  const baseFen = Math.round(input.currentAmount * 100);
  if (!Number.isSafeInteger(baseFen) || baseFen < 1) {
    throw new AppError(400, '套餐金额无效');
  }
  if (input.redeemApplies && input.redeemRate !== null) {
    const fen = Math.trunc(baseFen * input.redeemRate);
    if (fen < 1) throw new AppError(400, '优惠后金额无效，请改用免费领取');
    return { fen, usedRedeem: true };
  }
  const photoCount = input.webName === 'photo' && input.billingMode === 'COUNT_PACKAGE';
  const createdAt = input.createdAt ? new Date(input.createdAt).getTime() : Number.NaN;
  const within72Hours = Number.isFinite(createdAt) && Date.now() - createdAt <= 72 * 60 * 60 * 1000;
  if (within72Hours && input.packageId !== '1' && !photoCount) {
    const fen = Math.trunc(baseFen * 0.8);
    if (fen < 1) throw new AppError(400, '优惠后金额无效');
    return { fen, usedRedeem: false };
  }
  return { fen: baseFen, usedRedeem: false };
}

export function buildJsapiPayParams(appId: string, prepayId: string, mchKey: string) {
  const fields = {
    appId,
    timeStamp: String(Math.floor(Date.now() / 1000)),
    nonceStr: randomBytes(16).toString('hex'),
    package: `prepay_id=${prepayId}`,
    signType: 'MD5',
  };
  return { ...fields, paySign: signWechatParams(fields, mchKey) };
}

export function createOutTradeNo(): string {
  return `${Date.now()}${randomBytes(2).toString('hex')}`;
}

export async function createUnifiedOrder(input: {
  config: WechatPayConfig;
  body: string;
  outTradeNo: string;
  totalFee: number;
  ip: string;
  tradeType: 'NATIVE' | 'JSAPI';
  productId: string;
  openid?: string;
}): Promise<{ codeUrl: string | undefined; prepayId: string | undefined }> {
  const fields: Record<string, string> = {
    appid: input.config.appId,
    mch_id: input.config.mchId,
    nonce_str: randomBytes(16).toString('hex'),
    body: input.body.slice(0, 40),
    out_trade_no: input.outTradeNo,
    total_fee: String(input.totalFee),
    spbill_create_ip: input.ip,
    notify_url: input.config.notifyUrl,
    trade_type: input.tradeType,
    fee_type: 'CNY',
    product_id: input.productId,
  };
  if (input.tradeType === 'JSAPI') {
    if (!input.openid) throw new AppError(400, '当前用户未通过微信登录，无法使用 JSAPI 支付');
    fields.openid = input.openid;
  }
  fields.sign = signWechatParams(fields, input.config.mchKey);
  let responseText: string;
  try {
    const response = await fetchWithTimeout(
      UNIFIED_ORDER_URL,
      {
        method: 'POST',
        headers: { 'content-type': 'text/xml' },
        body: buildWechatXml(fields),
      },
      15_000,
    );
    responseText = await response.text();
  } catch {
    throw new AppError(502, '微信支付下单请求失败');
  }
  const parsed = parseWechatXml(responseText);
  if (parsed.return_code !== 'SUCCESS' || parsed.result_code !== 'SUCCESS') {
    throw new AppError(502, parsed.err_code_des || parsed.return_msg || '微信支付下单失败');
  }
  if (!verifyWechatSign(parsed, input.config.mchKey)) {
    throw new AppError(502, '微信支付响应验签失败');
  }
  return { codeUrl: parsed.code_url, prepayId: parsed.prepay_id };
}

export type WechatOrderQuery = {
  tradeState: string;
  openid: string | null;
  transactionId: string | null;
  totalFee: number;
  raw: Record<string, string>;
};

export function readWechatOrderQuery(
  parsed: Record<string, string>,
  config: Pick<WechatPayConfig, 'appId' | 'mchId' | 'mchKey'>,
): WechatOrderQuery {
  if (parsed.return_code !== 'SUCCESS' || parsed.result_code !== 'SUCCESS') {
    throw new AppError(
      500,
      `同步订单失败：${parsed.err_code_des || parsed.return_msg || '微信支付查询失败'}`,
    );
  }
  if (!verifyWechatSign(parsed, config.mchKey)) {
    throw new AppError(500, '同步订单失败：微信支付响应验签失败');
  }
  if (
    (parsed.appid && parsed.appid !== config.appId) ||
    (parsed.mch_id && parsed.mch_id !== config.mchId)
  ) {
    throw new AppError(500, '同步订单失败：微信支付商户不匹配');
  }
  const totalFee = Number(parsed.total_fee);
  if (!Number.isSafeInteger(totalFee) || totalFee < 1) {
    throw new AppError(500, '同步订单失败：微信支付金额无效');
  }
  return {
    tradeState: parsed.trade_state ?? '',
    openid: parsed.openid || null,
    transactionId: parsed.transaction_id || null,
    totalFee,
    raw: parsed,
  };
}

export async function queryWechatOrder(
  config: WechatPayConfig,
  outTradeNo: string,
): Promise<WechatOrderQuery> {
  const fields: Record<string, string> = {
    appid: config.appId,
    mch_id: config.mchId,
    nonce_str: randomBytes(16).toString('hex'),
    out_trade_no: outTradeNo,
  };
  fields.sign = signWechatParams(fields, config.mchKey);
  let responseText: string;
  try {
    const response = await fetchWithTimeout(
      ORDER_QUERY_URL,
      {
        method: 'POST',
        headers: { 'content-type': 'text/xml' },
        body: buildWechatXml(fields),
      },
      15_000,
    );
    responseText = await response.text();
  } catch {
    throw new AppError(500, '同步订单失败：微信支付查询失败');
  }
  return readWechatOrderQuery(parseWechatXml(responseText), config);
}

export async function renderPayQr(codeUrl: string): Promise<Buffer> {
  return toBuffer(codeUrl, { type: 'png', width: 280, margin: 1, errorCorrectionLevel: 'M' });
}
