import { describe, expect, it } from 'vitest';
import { toPhotoPaymentRecord } from '@/modules/payment/payment-routes.js';

describe('photo payment history', () => {
  it('converts a paid WeChat order from fen to yuan', () => {
    const record = toPhotoPaymentRecord({
      id: 'order-1',
      order_no: 'P202610230001',
      amount: '10.00',
      status: '支付成功',
      pay_channel: '微信',
      create_time: new Date('2026-10-23T01:00:00.000Z'),
      update_time: new Date('2026-10-23T01:02:00.000Z'),
      package_name: '测试套餐',
      usage_count: 3,
    });
    expect(record).toMatchObject({
      id: 'order-1',
      orderNo: 'P202610230001',
      packageName: '测试套餐',
      usageCount: 3,
      amount: 0.1,
      status: 'PAID',
      paymentMethod: '微信支付',
      paidAt: new Date('2026-10-23T01:02:00.000Z'),
    });
    expect(record).not.toHaveProperty('refundedAt');
  });

  it('keeps the refund time separate from the original order time', () => {
    const record = toPhotoPaymentRecord({
      id: 'order-2',
      order_no: 'P202610230002',
      amount: 100,
      status: '已退款',
      pay_channel: '微信',
      create_time: new Date('2026-10-12T04:08:35.000Z'),
      update_time: new Date('2026-10-13T02:30:00.000Z'),
      package_name: null,
      usage_count: null,
    });
    expect(record).toMatchObject({
      packageName: '次数包',
      usageCount: 0,
      amount: 1,
      status: 'REFUNDED',
      paidAt: new Date('2026-10-12T04:08:35.000Z'),
      refundedAt: new Date('2026-10-13T02:30:00.000Z'),
    });
  });
});
