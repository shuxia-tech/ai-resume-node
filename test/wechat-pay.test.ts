import { describe, expect, it } from 'vitest';
import {
  chargeFen,
  parseWechatXml,
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
});
