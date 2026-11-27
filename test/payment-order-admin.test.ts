import { describe, expect, it } from 'vitest';
import { orderAmountYuan, shanghaiMonthRange } from '@/modules/admin/payment-order-routes.js';

describe('payment order admin', () => {
  it('converts WeChat fen to yuan and keeps Stripe or mock amounts', () => {
    expect(orderAmountYuan(1990, '微信')).toBe(19.9);
    expect(orderAmountYuan(19.9, 'stripe支付')).toBe(19.9);
    expect(orderAmountYuan(19.9, 'MOCK')).toBe(19.9);
    expect(orderAmountYuan(null, '微信')).toBe(0);
  });

  it('uses the Shanghai calendar month for income', () => {
    const range = shanghaiMonthRange(new Date('2026-11-26T10:00:00+08:00'));
    expect(range).toEqual({
      start: '2026-11-01 00:00:00',
      end: '2026-12-01 00:00:00',
      label: '2026-11',
    });
    expect(shanghaiMonthRange(new Date('2026-12-31T23:30:00+08:00')).end).toBe(
      '2027-01-01 00:00:00',
    );
  });
});