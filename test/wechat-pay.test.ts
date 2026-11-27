import { describe, expect, it } from 'vitest';
import { shanghaiClock, operationStatText } from '@/modules/maintenance/operation-stat.js';
import { orderWebhook, opsWebhook, paymentSuccessText } from '@/modules/payment/feishu-notify.js';
import {
  chargeFen,
  parseWechatXml,
  paymentNotifyUrl,
  readWechatOrderQuery,
  signWechatParams,
  verifyWechatSign,
  wechatNotifyXml,
} from '@/modules/payment/wechat-pay.js';

describe('wechat pay', () => {
  it('matches the WeChat v2 MD5 sample signature', () => {
    const sign = signWechatParams(
      {
        appid: 'wxd930ea5d5a258f4f',
        mch_id: '10000100',
        device_info: '1000',
        body: 'test',
        nonce_str: 'ibuaiVcKdpRxkhJA',
      },
      '192006250b4c09247ec02edce69f6a2d',
    );
    expect(sign).toBe('9A0A8659F005D6984697E2CA0A9CF3B7');
    expect(
      verifyWechatSign(
        {
          appid: 'wxd930ea5d5a258f4f',
          mch_id: '10000100',
          device_info: '1000',
          body: 'test',
          nonce_str: 'ibuaiVcKdpRxkhJA',
          sign,
        },
        '192006250b4c09247ec02edce69f6a2d',
      ),
    ).toBe(true);
    expect(verifyWechatSign({ sign: 'BAD' }, '192006250b4c09247ec02edce69f6a2d')).toBe(false);
  });

  it('reads CDATA fields from a payment notice', () => {
    const fields = parseWechatXml(
      '<xml><return_code><![CDATA[SUCCESS]]></return_code><total_fee>1592</total_fee></xml>',
    );
    expect(fields).toMatchObject({ return_code: 'SUCCESS', total_fee: '1592' });
    expect(wechatNotifyXml(false, '签名校验失败')).toContain('FAIL');
  });

  it('appends the jisu callback path the same way as offer and photo', () => {
    const base = 'https://api.gfjianli.com/api/c/resume/memberPackage/wxPayCallback';
    expect(paymentNotifyUrl(base, 'jisu')).toBe(`${base}/jisu`);
    expect(paymentNotifyUrl(`${base}/`, 'offer')).toBe(`${base}/offer`);
  });

  it('applies the same fen amount and new-user discount as the Java order', () => {
    expect(
      chargeFen({
        currentAmount: 19.9,
        packageId: '2',
        webName: 'offer',
        billingMode: 'MEMBER_UNLIMITED',
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        redeemRate: null,
        redeemApplies: false,
      }),
    ).toEqual({ fen: 1592, usedRedeem: false });
    expect(
      chargeFen({
        currentAmount: 19.9,
        packageId: '2',
        webName: 'offer',
        billingMode: 'MEMBER_UNLIMITED',
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
        redeemRate: 0.5,
        redeemApplies: true,
      }),
    ).toEqual({ fen: 995, usedRedeem: true });
  });

  it('accepts a signed WeChat order query and rejects a bad signature', () => {
    const config = { appId: 'wx-photo', mchId: '1900000109', mchKey: 'photo-mch-key' };
    const fields = {
      return_code: 'SUCCESS',
      result_code: 'SUCCESS',
      appid: config.appId,
      mch_id: config.mchId,
      trade_state: 'SUCCESS',
      total_fee: '990',
      openid: 'openid-photo',
      transaction_id: '4200000001',
    };
    const signed = { ...fields, sign: signWechatParams(fields, config.mchKey) };
    expect(readWechatOrderQuery(signed, config)).toMatchObject({
      tradeState: 'SUCCESS',
      totalFee: 990,
      openid: 'openid-photo',
      transactionId: '4200000001',
    });
    expect(() => readWechatOrderQuery({ ...signed, sign: 'BAD' }, config)).toThrow(
      '同步订单失败：微信支付响应验签失败',
    );
    expect(() =>
      readWechatOrderQuery(
        {
          return_code: 'SUCCESS',
          result_code: 'FAIL',
          err_code_des: '订单不存在',
        },
        config,
      ),
    ).toThrow('同步订单失败：订单不存在');
  });

  it('formats the Feishu payment notice like the Java callback', () => {
    expect(
      paymentSuccessText({
        userId: 'u1',
        nickname: '小明',
        amountFen: 1990,
        packageName: '月度会员',
      }),
    ).toBe('用户：u1_小明，支付成功，支付金额：19.90，套餐：月度会员');
  });

  it('keeps the two Feishu bots on their Java webhooks in production', () => {
    const production = { NODE_ENV: 'production' as const };
    expect(orderWebhook(production)).toContain('e2531cf7-337f-40e8-abc8-b11360a2b32c');
    expect(opsWebhook(production)).toContain('9a137728-64e6-46d8-9d6e-145adbe5f19c');
    expect(orderWebhook({ NODE_ENV: 'test' })).toBeUndefined();
    expect(opsWebhook({ NODE_ENV: 'test' })).toBeUndefined();
  });

  it('sends the operation summary at 23:59 Shanghai time', () => {
    expect(shanghaiClock(new Date('2026-11-26T15:59:00.000Z'))).toMatchObject({
      date: '2026-11-26',
      hour: '23',
      minute: '59',
    });
    const text = operationStatText({
      todayNewUser: 1,
      monthNewUser: 2,
      totalUser: 3,
      todayIncome: 1.5,
      monthIncome: null,
      todayOrderCount: 4,
      monthOrderCount: 5,
      totalOrderCount: 6,
      todayReadSysNotice: 0,
      todayReadActNotice: 0,
      todayReadLikeMsg: 0,
      todayReadCollectMsg: 0,
    });
    expect(text).toContain('今日新增用户: 1');
    expect(text).toContain('今日收入: 1.50 元');
    expect(text).toContain('本月收入: 0.00 元');
  });
});
