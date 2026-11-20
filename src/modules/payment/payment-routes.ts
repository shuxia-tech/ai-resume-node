/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AppError } from '@/common/errors.js';
import { fail, ok } from '@/common/http-response.js';
import { requireUser } from '@/auth/request-user.js';
import type { AppEnv } from '@/config/env.js';
import type { Database, MemberPackageRow } from '@/infrastructure/database.js';
import { notifyPaymentWebSocket } from '@/modules/payment/payment-websocket.js';
import {
  buildJsapiPayParams,
  chargeFen,
  createOutTradeNo,
  createUnifiedOrder,
  parseWechatXml,
  queryWechatOrder,
  paymentNotifyUrl,
  renderPayQr,
  verifyWechatSign,
  wechatClientIp,
  wechatNotifyXml,
  type WechatPayConfig,
} from '@/modules/payment/wechat-pay.js';

type PaymentBody = {
  packageId?: string;
  redeemCode?: string;
  orderNo?: string;
  out_trade_no?: string;
  status?: string;
  webName?: string;
};

export function buildMockJsapiParams(orderId: string) {
  return {
    appId: 'mock-app-id',
    timeStamp: String(Math.floor(Date.now() / 1000)),
    nonceStr: orderId.slice(0, 16),
    package: `prepay_id=mock_${orderId.slice(0, 16)}`,
    signType: 'MD5',
    paySign: 'mock-signature',
  };
}

export function canApplyMockPaymentSuccess(status: string | null | undefined) {
  return status === '待支付';
}

function packageCategory(webName?: string) {
  if (webName === 'offer') return 'offer星球';
  if (webName === 'photo') return 'AI证件照';
  if (webName === 'jisu') return '极速海投';
  return '高分简历';
}

function parseCallback(body: unknown): PaymentBody {
  if (typeof body === 'object' && body) {
    const value = body as PaymentBody;
    return {
      ...value,
      ...(value.orderNo || !value.out_trade_no ? {} : { orderNo: value.out_trade_no }),
    };
  }
  const text = String(body ?? '');
  const value = (name: string) => text.match(new RegExp('<' + name + '>([^<]+)'))?.[1];
  const orderNo = value('out_trade_no') ?? value('orderNo');
  const status = value('result_code') ?? value('status');
  return { ...(orderNo ? { orderNo } : {}), ...(status ? { status } : {}) };
}

async function findPackage(
  db: Kysely<Database>,
  packageId: string,
  webName?: string,
): Promise<MemberPackageRow> {
  const row = await db
    .selectFrom('sc_member_package')
    .selectAll()
    .where('id', '=', packageId)
    .where('delete_flag', '=', 'NOT_DELETE')
    .executeTakeFirst();
  if (!row) throw new AppError(404, '不存在该会员套餐或已下架');
  const category = packageCategory(webName);
  let ext: Record<string, unknown> = {};
  try {
    ext = row.ext_json ? JSON.parse(row.ext_json) : {};
  } catch {
    /* preserve legacy rows */
  }
  if (ext.category && ext.category !== category) throw new AppError(400, '套餐类型不匹配');
  return row;
}

export function registerPaymentRoutes(app: FastifyInstance, env: AppEnv, db: Kysely<Database>) {
  const authenticate = requireUser(env);

  function livePayConfig(): WechatPayConfig {
    const appId = env.WECHAT_PAY_APP_ID;
    const mchId = env.WECHAT_PAY_MCH_ID;
    const mchKey = env.WECHAT_PAY_MCH_KEY;
    const notifyUrl = env.WECHAT_PAY_NOTIFY_URL;
    if (!appId || !mchId || !mchKey || !notifyUrl) throw new AppError(503, '微信支付未配置');
    return { appId, mchId, mchKey, notifyUrl };
  }

  async function createOrder(
    request: any,
    webName: string | undefined,
    reply: FastifyReply | undefined,
    qrResponse: boolean,
  ) {
    await authenticate(request);
    if (env.PAYMENT_MODE === 'live') return createLiveOrder(request, webName, reply, qrResponse);
    if (!env.TEST_AUTH_ENABLED || request.userId !== env.TEST_USER_ID)
      throw new AppError(403, '模拟支付只允许测试账号');
    const params = (request.params ?? {}) as { code?: string; packageId?: string };
    const body = (request.body ?? {}) as { redeemCode?: string; packageId?: string };
    const packageId = params.packageId ?? body.packageId;
    if (!packageId) throw new AppError(400, 'packageId不能为空');
    const memberPackage = await findPackage(db, packageId, webName);
    const id = randomUUID().replaceAll('-', '');
    const orderNo = `codex_migration_test_order_${Date.now()}_${id.slice(0, 8)}`;
    await db
      .insertInto('t_payment_order')
      .values({
        id,
        delete_flag: 'NOT_DELETE',
        create_time: new Date(),
        update_time: new Date(),
        pay_channel: 'MOCK',
        amount: memberPackage.current_amount,
        recharge_record_id: null,
        order_no: orderNo,
        status: '待支付',
        openid: null,
        product_id: memberPackage.id,
        remark: `migration mock ${webName ?? 'resume'}`,
        ip: null,
        code_url: `mock://wechat-pay/${orderNo}`,
        user_id: request.userId,
        ext_json: JSON.stringify({
          mode: 'mock',
          webName: webName ?? null,
          redeemCode: params.code ?? body.redeemCode ?? '0',
        }),
        redeem_code_id: null,
      } as any)
      .execute();
    const result = {
      orderNo,
      outTradeNo: orderNo,
      codeUrl: `mock://wechat-pay/${orderNo}`,
      amount: memberPackage.current_amount,
      mode: 'mock',
      packageId: memberPackage.id,
      // Keep the JSAPI response shape consumable by the existing member page
      // while making it explicit that these values are mock-only and must
      // never be sent to WeChat.
      ...(qrResponse
        ? {}
        : {
            jsapiParams: {
              ...buildMockJsapiParams(id),
            },
          }),
    };
    if (qrResponse && reply) {
      const escapedOrderNo = orderNo.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
      return reply
        .header('x-mock-order-no', orderNo)
        .type('image/svg+xml')
        .send(
          `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320"><rect width="320" height="320" fill="white"/><rect x="16" y="16" width="288" height="288" fill="none" stroke="black" stroke-width="4"/><text x="160" y="145" text-anchor="middle" font-size="20">MOCK WECHAT PAY</text><text x="160" y="180" text-anchor="middle" font-size="12">${escapedOrderNo}</text><text x="160" y="215" text-anchor="middle" font-size="12">仅用于迁移测试，不可真实支付</text></svg>`,
        );
    }
    return ok(result);
  }

  async function createLiveOrder(
    request: any,
    webName: string | undefined,
    reply: FastifyReply | undefined,
    qrResponse: boolean,
  ) {
    const config = livePayConfig();
    const params = (request.params ?? {}) as { code?: string; packageId?: string };
    const body = (request.body ?? {}) as { redeemCode?: string; packageId?: string };
    const packageId = params.packageId ?? body.packageId;
    if (!packageId) throw new AppError(400, 'packageId不能为空');
    const memberPackage = await findPackage(db, packageId, webName);
    if (
      webName === 'photo' &&
      memberPackage.billing_mode === 'COUNT_PACKAGE' &&
      Number(memberPackage.usage_count ?? 0) <= 0
    ) {
      throw new AppError(400, 'AI证件照次数套餐未配置购买次数');
    }
    const userId = request.userId as string;
    const payer = await db
      .selectFrom('client_user')
      .select(['wechat_openid', 'create_time'] as const)
      .where('ID', '=', userId)
      .where('DELETE_FLAG', '=', 'NOT_DELETE')
      .executeTakeFirst();
    if (!payer) throw new AppError(404, '用户不存在');
    const redeemCode = params.code ?? body.redeemCode ?? '0';
    const redeem =
      redeemCode === '0'
        ? undefined
        : await db
            .selectFrom('t_redeem_code')
            .select(['code_id', 'member_package_id', 'ext_json'] as const)
            .where('code', '=', redeemCode)
            .where('delete_flag', '=', 'NOT_DELETE')
            .where('expiration_time', '>', new Date())
            .executeTakeFirst();
    const rate = redeem ? Number(redeem.ext_json) : Number.NaN;
    const redeemApplies = Boolean(
      redeem &&
      Number.isFinite(rate) &&
      rate > 0 &&
      rate <= 1 &&
      (redeem.member_package_id
        ? redeem.member_package_id === memberPackage.id
        : memberPackage.id !== '1'),
    );
    const priced = chargeFen({
      currentAmount: Number(memberPackage.current_amount),
      packageId: memberPackage.id,
      webName,
      billingMode: memberPackage.billing_mode,
      createdAt: payer.create_time,
      redeemRate: Number.isFinite(rate) ? rate : null,
      redeemApplies,
    });
    if (qrResponse === false && !payer.wechat_openid) {
      throw new AppError(400, '当前用户未通过微信登录，无法使用 JSAPI 支付');
    }
    const outTradeNo = createOutTradeNo();
    const orderId = randomUUID().replaceAll('-', '');
    const openid = payer.wechat_openid ?? undefined;
    const clientIp = wechatClientIp(request.ip);
    await db
      .insertInto('t_payment_order')
      .values({
        id: orderId,
        delete_flag: 'NOT_DELETE',
        create_time: new Date(),
        update_time: new Date(),
        pay_channel: '微信',
        amount: priced.fen,
        recharge_record_id: null,
        order_no: outTradeNo,
        status: '待支付',
        openid: payer.wechat_openid,
        product_id: memberPackage.id,
        remark: webName ?? 'resume',
        ip: clientIp,
        code_url: null,
        user_id: userId,
        ext_json: JSON.stringify({
          mode: 'live',
          webName: webName ?? null,
          redeemCodeId: priced.usedRedeem ? (redeem?.code_id ?? null) : null,
        }),
        redeem_code_id: priced.usedRedeem ? (redeem?.code_id ?? null) : null,
      } as any)
      .execute();
    let unified: Awaited<ReturnType<typeof createUnifiedOrder>>;
    try {
      unified = await createUnifiedOrder({
        config: { ...config, notifyUrl: paymentNotifyUrl(config.notifyUrl, webName) },
        body: memberPackage.package_name,
        outTradeNo,
        totalFee: priced.fen,
        ip: clientIp,
        tradeType: qrResponse ? 'NATIVE' : 'JSAPI',
        productId: memberPackage.id,
        ...(openid ? { openid } : {}),
      });
    } catch (error) {
      await db
        .updateTable('t_payment_order')
        .set({ status: '支付失败', update_time: new Date() })
        .where('id', '=', orderId)
        .execute();
      throw error;
    }
    if (unified.codeUrl) {
      await db
        .updateTable('t_payment_order')
        .set({ code_url: unified.codeUrl, update_time: new Date() })
        .where('id', '=', orderId)
        .execute();
    }
    if (qrResponse) {
      if (!unified.codeUrl || !reply) throw new AppError(502, '微信支付未返回二维码');
      const png = await renderPayQr(unified.codeUrl);
      return reply.type('image/png').send(png);
    }
    if (!unified.prepayId) throw new AppError(502, '微信支付未返回预支付单号');
    return ok({
      orderId,
      outTradeNo,
      packageName: memberPackage.package_name,
      amount: priced.fen / 100,
      billingMode: memberPackage.billing_mode,
      usageCount: memberPackage.usage_count,
      jsapiParams: buildJsapiPayParams(config.appId, unified.prepayId, config.mchKey),
    });
  }

  for (const [path, webName] of [
    ['/c/resume/memberPackage/createOrder/:code/:packageId', undefined],
    ['/c/resume/memberPackage/createOrder/offer/:code/:packageId', 'offer'],
    ['/c/resume/memberPackage/createOrder/photo/:code/:packageId', 'photo'],
    ['/c/resume/memberPackage/createOrder/jisu/:code/:packageId', 'jisu'],
  ] as const)
    app.post(path, async (request, reply) => createOrder(request, webName, reply, true));

  for (const [path, webName] of [
    ['/c/resume/memberPackage/createJSAPIOrder', undefined],
    ['/c/resume/memberPackage/createJSAPIOrder/offer', 'offer'],
    ['/c/resume/memberPackage/createJSAPIOrder/photo', 'photo'],
    ['/c/resume/memberPackage/createJSAPIOrder/jisu', 'jisu'],
  ] as const)
    app.post(path, async (request, reply) => createOrder(request, webName, reply, false));

  async function createFreeOrder(request: any, webName: string | undefined) {
    await authenticate(request);
    const params = request.params as { code: string; packageId: string };
    const memberPackage = await findPackage(db, params.packageId, webName);
    const userId = request.userId!;
    await db.transaction().execute(async (trx) => {
      const redeem = await trx
        .selectFrom('t_redeem_code')
        .selectAll()
        .where('code', '=', params.code)
        .where('delete_flag', '=', 'NOT_DELETE')
        .where('expiration_time', '>', new Date())
        .forUpdate()
        .executeTakeFirst();
      if (!redeem || redeem.ext_json !== '0') throw new AppError(400, '该优惠码不支持免费领取');
      if (
        redeem.max_redemption !== null &&
        redeem.max_redemption !== undefined &&
        (redeem.current_redemption ?? 0) >= redeem.max_redemption
      ) {
        throw new AppError(400, '该优惠码已达到使用次数上限');
      }
      if (redeem.user_id && redeem.user_id === userId) {
        throw new AppError(400, '无法使用自己的优惠券');
      }
      const user = await trx
        .selectFrom('client_user')
        .select([
          'member_expiration_time',
          'offer_member_expiration_time',
          'photo_member_expiration_time',
        ] as any)
        .where('ID', '=', userId)
        .where('DELETE_FLAG', '=', 'NOT_DELETE')
        .forUpdate()
        .executeTakeFirst();
      if (!user) throw new AppError(404, '用户不存在');
      await grantPackage(trx, userId, memberPackage, webName, user);
      await trx
        .updateTable('t_redeem_code')
        .set({ current_redemption: (redeem.current_redemption ?? 0) + 1, update_time: new Date() })
        .where('code_id', '=', redeem.code_id)
        .execute();
    });
    return ok(null);
  }

  for (const [path, webName] of [
    ['/c/resume/memberPackage/createFreeOrder/:code/:packageId', undefined],
    ['/c/resume/memberPackage/createFreeOrder/offer/:code/:packageId', 'offer'],
    ['/c/resume/memberPackage/createFreeOrder/photo/:code/:packageId', 'photo'],
    ['/c/resume/memberPackage/createFreeOrder/jisu/:code/:packageId', 'jisu'],
  ] as const)
    app.post(path, async (request) => createFreeOrder(request, webName));

  app.post('/c/resume/memberPackage/createLinkFreeOrder', { preHandler: authenticate }, async () =>
    ok(null),
  );
  app.post(
    '/c/resume/memberPackage/createLinkFreeOrder/offer',
    { preHandler: authenticate },
    async () => ok(null),
  );
  app.post(
    '/c/resume/memberPackage/createLinkFreeOrder/jisu',
    { preHandler: authenticate },
    async () => ok(null),
  );

  async function callback(request: any, reply: FastifyReply, webName: string | undefined) {
    if (env.PAYMENT_MODE === 'live') return handleLiveCallback(request, reply, webName);
    const payload = parseCallback(request.body);
    if (!payload.orderNo) throw new AppError(400, '缺少订单号');
    const orderNo = payload.orderNo;
    const result = await db.transaction().execute(async (trx) => {
      const order = await trx
        .selectFrom('t_payment_order')
        .selectAll()
        .where('order_no', '=', orderNo)
        .where('user_id', '=', env.TEST_USER_ID ?? '')
        .forUpdate()
        .executeTakeFirst();
      if (!order) throw new AppError(404, '测试订单不存在');
      if (order.status === '支付成功')
        return { response: 'SUCCESS', changed: false, userId: order.user_id };
      if (!canApplyMockPaymentSuccess(order.status))
        return { response: 'SUCCESS', changed: false, userId: order.user_id };
      if (payload.status && !['SUCCESS', '支付成功', '成功'].includes(payload.status)) {
        await trx
          .updateTable('t_payment_order')
          .set({ status: '支付失败', update_time: new Date() })
          .where('id', '=', order.id)
          .execute();
        return { response: 'SUCCESS', changed: false, userId: order.user_id };
      }
      const memberPackage = await findPackage(trx, order.product_id!, webName);
      const user = await trx
        .selectFrom('client_user')
        .select([
          'member_expiration_time',
          'offer_member_expiration_time',
          'photo_member_expiration_time',
        ] as any)
        .where('ID', '=', order.user_id!)
        .where('DELETE_FLAG', '=', 'NOT_DELETE')
        .forUpdate()
        .executeTakeFirst();
      if (!user) throw new AppError(404, '用户不存在');
      await grantPackage(trx, order.user_id!, memberPackage, webName, user);
      await trx
        .updateTable('t_payment_order')
        .set({
          status: '支付成功',
          update_time: new Date(),
          recharge_record_id: `mock_${order.id.slice(0, 14)}`,
        })
        .where('id', '=', order.id)
        .execute();
      return { response: 'SUCCESS', changed: true, userId: order.user_id };
    });
    if (result.changed && result.userId) {
      notifyPaymentWebSocket(result.userId, 'WxPay', {
        code: 200,
        success: true,
        data: '支付成功',
        msg: '操作成功',
      });
    }
    return result.response;
  }

  async function handleLiveCallback(
    request: any,
    reply: FastifyReply,
    webName: string | undefined,
  ) {
    const config = livePayConfig();
    const xml = typeof request.body === 'string' ? request.body : '';
    const notice = parseWechatXml(xml);
    const reject = (message: string) =>
      reply.type('text/xml').send(wechatNotifyXml(false, message));
    if (
      !verifyWechatSign(notice, config.mchKey) ||
      notice.appid !== config.appId ||
      notice.mch_id !== config.mchId
    ) {
      return reject('签名校验失败');
    }
    if (notice.return_code !== 'SUCCESS' || notice.result_code !== 'SUCCESS') {
      return reject('支付结果未成功');
    }
    const orderNo = notice.out_trade_no;
    const totalFee = Number(notice.total_fee);
    if (!orderNo || !Number.isSafeInteger(totalFee)) return reject('通知缺少订单号或金额');
    const result = await db.transaction().execute(async (trx) => {
      const order = await trx
        .selectFrom('t_payment_order')
        .selectAll()
        .where('order_no', '=', orderNo)
        .where('delete_flag', '=', 'NOT_DELETE')
        .forUpdate()
        .executeTakeFirst();
      if (!order) return { response: '订单不存在', changed: false, userId: undefined };
      if (order.status === '支付成功')
        return { response: 'OK', changed: false, userId: order.user_id };
      if (!canApplyMockPaymentSuccess(order.status))
        return { response: 'OK', changed: false, userId: order.user_id };
      if (Number(order.amount) !== totalFee)
        return { response: '金额不一致', changed: false, userId: undefined };
      if (!order.product_id || !order.user_id)
        return { response: '订单数据不完整', changed: false, userId: undefined };
      const memberPackage = await findPackage(trx, order.product_id, webName);
      const user = await trx
        .selectFrom('client_user')
        .select([
          'member_expiration_time',
          'offer_member_expiration_time',
          'photo_member_expiration_time',
        ] as any)
        .where('ID', '=', order.user_id)
        .where('DELETE_FLAG', '=', 'NOT_DELETE')
        .forUpdate()
        .executeTakeFirst();
      if (!user) return { response: '用户不存在', changed: false, userId: undefined };
      await grantPackage(trx, order.user_id, memberPackage, webName, user);
      await trx
        .updateTable('t_payment_order')
        .set({
          status: '支付成功',
          update_time: new Date(),
          openid: notice.openid ?? order.openid,
          ext_json: JSON.stringify({
            mode: 'live',
            transactionId: notice.transaction_id ?? null,
          }),
        })
        .where('id', '=', order.id)
        .execute();
      return { response: 'OK', changed: true, userId: order.user_id };
    });
    if (result.changed && result.userId) {
      notifyPaymentWebSocket(result.userId, 'WxPay', {
        code: 200,
        success: true,
        data: '支付成功',
        msg: '操作成功',
      });
    }
    return reply.type('text/xml').send(wechatNotifyXml(result.response === 'OK', result.response));
  }

  app.post('/c/resume/memberPackage/wxPayCallback', async (request, reply) =>
    callback(request, reply, undefined),
  );
  app.post('/c/resume/memberPackage/wxPayCallback/offer', async (request, reply) =>
    callback(request, reply, 'offer'),
  );
  app.post('/c/resume/memberPackage/wxPayCallback/photo', async (request, reply) =>
    callback(request, reply, 'photo'),
  );
  app.post('/c/resume/memberPackage/wxPayCallback/jisu', async (request, reply) =>
    callback(request, reply, 'jisu'),
  );

  // The photo site polls this while the WeChat callback is delayed. A paid
  // order returns the remaining quota; an unpaid order stays HTTP 200 so the
  // client can keep polling instead of treating it as a request failure.
  app.post(
    '/c/resume/memberPackage/syncOrder/photo',
    { preHandler: authenticate },
    async (request) => {
      const userId = request.userId as string;
      const packages = await db
        .selectFrom('sc_member_package')
        .select('id')
        .where('ext_json', '=', 'AI证件照')
        .where('delete_flag', '=', 'NOT_DELETE')
        .execute();
      if (packages.length === 0) return fail(500, '未配置AI证件照会员套餐');
      const order = await db
        .selectFrom('t_payment_order')
        .selectAll()
        .where('user_id', '=', userId)
        .where(
          'product_id',
          'in',
          packages.map((item) => item.id),
        )
        .where('delete_flag', '=', 'NOT_DELETE')
        .orderBy('create_time', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (!order) return fail(500, '未找到AI证件照支付订单');
      if (order.status === '支付成功') {
        return ok({ remainingCount: await photoRemainingCount(db, userId) }, '订单已支付成功');
      }
      if (env.PAYMENT_MODE !== 'live') return ok(null, '订单尚未支付成功');

      let queried: Awaited<ReturnType<typeof queryWechatOrder>>;
      try {
        queried = await queryWechatOrder(livePayConfig(), order.order_no);
      } catch (error) {
        const message =
          error instanceof AppError ? error.message : '同步订单失败：微信支付查询失败';
        return fail(500, message.startsWith('同步订单失败') ? message : `同步订单失败：${message}`);
      }
      if (queried.tradeState !== 'SUCCESS') return ok(null, '订单尚未支付成功');
      if (Number(order.amount) !== queried.totalFee) return fail(500, '同步订单失败：金额不一致');

      const settled = await db.transaction().execute(async (trx) => {
        const locked = await trx
          .selectFrom('t_payment_order')
          .selectAll()
          .where('id', '=', order.id)
          .where('delete_flag', '=', 'NOT_DELETE')
          .forUpdate()
          .executeTakeFirst();
        if (!locked?.user_id || !locked.product_id) return 'missing' as const;
        if (locked.status === '支付成功') return 'already' as const;
        if (!canApplyMockPaymentSuccess(locked.status)) return 'closed' as const;
        if (Number(locked.amount) !== queried.totalFee) return 'amount' as const;
        const memberPackage = await findPackage(trx, locked.product_id, 'photo');
        const user = await trx
          .selectFrom('client_user')
          .select([
            'member_level',
            'member_expiration_time',
            'offer_member_expiration_time',
            'photo_member_expiration_time',
          ] as any)
          .where('ID', '=', locked.user_id)
          .where('DELETE_FLAG', '=', 'NOT_DELETE')
          .forUpdate()
          .executeTakeFirst();
        if (!user) return 'user' as const;
        const rechargeId = randomUUID().replaceAll('-', '');
        await trx
          .insertInto('t_recharge_record')
          .values({
            id: rechargeId,
            delete_flag: 'NOT_DELETE',
            create_time: new Date(),
            update_time: new Date(),
            membership_package_id: memberPackage.id,
            amount: locked.amount,
            payment_order_id: locked.id,
            user_id: locked.user_id,
            package_name: memberPackage.package_name,
            gift_day: memberPackage.gift_day,
            before_member_level: (user as any).member_level ?? null,
            before_member_expiration_time: (user as any).member_expiration_time ?? null,
            ext_json: JSON.stringify({
              membershipPackage: {
                id: memberPackage.id,
                packageName: memberPackage.package_name,
                billingMode: memberPackage.billing_mode,
                usageCount: memberPackage.usage_count,
                giftDay: memberPackage.gift_day,
              },
              clientMemberInfo: {
                memberLevel: (user as any).member_level ?? null,
                memberExpirationTime: (user as any).member_expiration_time ?? null,
              },
            }),
          } as any)
          .execute();
        await grantPackage(trx, locked.user_id, memberPackage, 'photo', user);
        await trx
          .updateTable('t_payment_order')
          .set({
            status: '支付成功',
            update_time: new Date(),
            openid: queried.openid ?? locked.openid,
            recharge_record_id: rechargeId,
            ext_json: JSON.stringify({
              mode: 'live',
              tradeState: queried.tradeState,
              transactionId: queried.transactionId,
              totalFee: queried.totalFee,
            }),
          })
          .where('id', '=', locked.id)
          .execute();
        return 'granted' as const;
      });
      if (settled === 'amount') return fail(500, '同步订单失败：金额不一致');
      if (settled === 'user' || settled === 'missing')
        return fail(500, '同步订单失败：订单数据不完整');
      if (settled === 'closed') return ok(null, '订单尚未支付成功');
      if (settled === 'granted') {
        notifyPaymentWebSocket(userId, 'WxPay', {
          code: 200,
          success: true,
          data: '支付成功',
          msg: '操作成功',
        });
        return ok(
          { remainingCount: await photoRemainingCount(db, userId) },
          '支付成功，次数已到账',
        );
      }
      return ok({ remainingCount: await photoRemainingCount(db, userId) }, '订单已支付成功');
    },
  );

  // Paid and refunded AI-photo orders for the signed-in user. Amount is stored
  // in fen, matching the WeChat total_fee check, and returned in yuan.
  app.get('/c/photo/payment', { preHandler: authenticate }, async (request) => {
    const userId = request.userId as string;
    const rows = await db
      .selectFrom('t_payment_order as o')
      .innerJoin('sc_member_package as p', 'p.id', 'o.product_id')
      .select([
        'o.id',
        'o.order_no',
        'o.amount',
        'o.status',
        'o.pay_channel',
        'o.create_time',
        'o.update_time',
        'p.package_name',
        'p.usage_count',
      ])
      .where('o.user_id', '=', userId)
      .where('o.delete_flag', '=', 'NOT_DELETE')
      .where('o.status', 'in', ['支付成功', '已退款'])
      .where('p.ext_json', '=', 'AI证件照')
      .orderBy('o.update_time', 'desc')
      .orderBy('o.create_time', 'desc')
      .execute();
    return ok(rows.map(toPhotoPaymentRecord));
  });
}

type PhotoPaymentRow = {
  id: string;
  order_no: string;
  amount: number | string | null;
  status: string | null;
  pay_channel: string | null;
  create_time: Date | null;
  update_time: Date | null;
  package_name: string | null;
  usage_count: number | null;
};

export function toPhotoPaymentRecord(row: PhotoPaymentRow) {
  const refunded = row.status === '已退款';
  const paidAt = refunded ? row.create_time ?? row.update_time : row.update_time ?? row.create_time;
  return {
    id: row.id,
    orderNo: row.order_no,
    packageName: row.package_name || '次数包',
    usageCount: Number(row.usage_count ?? 0),
    amount: Number.isFinite(Number(row.amount)) ? Math.round(Number(row.amount)) / 100 : 0,
    status: refunded ? 'REFUNDED' : 'PAID',
    paymentMethod: row.pay_channel === '微信' || !row.pay_channel ? '微信支付' : row.pay_channel,
    paidAt: paidAt ?? new Date(0),
    ...(refunded && row.update_time ? { refundedAt: row.update_time } : {}),
  };
}

async function photoRemainingCount(db: Kysely<Database>, userId: string) {
  const row = await db
    .selectFrom('sc_user_function_limits')
    .select('remaining_uses')
    .where('user_id', '=', userId)
    .where('function_name', '=', 'AI证件照生成')
    .executeTakeFirst();
  return Number(row?.remaining_uses ?? 0);
}

async function grantPackage(
  db: Kysely<Database>,
  userId: string,
  memberPackage: MemberPackageRow,
  webName: string | undefined,
  user: any,
) {
  if (memberPackage.billing_mode === 'COUNT_PACKAGE') {
    const functionName = webName === 'photo' ? 'AI证件照生成' : '简历分析';
    const amount = Number(memberPackage.usage_count ?? 0);
    const existing = await db
      .selectFrom('sc_user_function_limits')
      .selectAll()
      .where('user_id', '=', userId)
      .where('function_name', '=', functionName)
      .executeTakeFirst();
    if (existing)
      await db
        .updateTable('sc_user_function_limits')
        .set({
          remaining_uses: Number(existing.remaining_uses ?? 0) + amount,
          update_time: new Date(),
        })
        .where('id', '=', existing.id)
        .execute();
    else
      await db
        .insertInto('sc_user_function_limits')
        .values({
          id: randomUUID().replaceAll('-', ''),
          user_id: userId,
          function_name: functionName,
          remaining_uses: amount,
          create_time: new Date(),
          update_time: new Date(),
        })
        .execute();
    return;
  }
  const days = Number(memberPackage.gift_day ?? 0);
  const field =
    webName === 'offer' || webName === 'jisu'
      ? 'offer_member_expiration_time'
      : webName === 'photo'
        ? 'photo_member_expiration_time'
        : 'member_expiration_time';
  const current =
    user[field] && new Date(user[field]).getTime() > Date.now()
      ? new Date(user[field])
      : new Date();
  current.setDate(current.getDate() + days);
  await db
    .updateTable('client_user')
    .set({ [field]: current, member_level: '会员', update_time: new Date() } as any)
    .where('ID', '=', userId)
    .execute();
}
