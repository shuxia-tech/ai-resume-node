import { describe, expect, it } from 'vitest';
import {
  formatJavaDate,
  formatPayloadDates,
  isActiveShanghaiWallClock,
} from '@/common/java-date.js';

describe('java date wire format', () => {
  it('prints DATETIME digits as yyyy-MM-dd HH:mm:ss', () => {
    expect(formatJavaDate(new Date('2026-10-13T00:00:00.000Z'))).toBe('2026-10-13 00:00:00');
    expect(formatJavaDate(new Date('2026-10-13T20:06:23.000Z'))).toBe('2026-10-13 20:06:23');
  });

  it('formats dates nested in a response without mutating buffers', () => {
    const payload = formatPayloadDates({
      recordTime: new Date('2026-10-13T00:00:00.000Z'),
      list: [{ createTime: new Date('2026-10-13T20:06:23.000Z') }],
    });
    expect(payload).toEqual({
      recordTime: '2026-10-13 00:00:00',
      list: [{ createTime: '2026-10-13 20:06:23' }],
    });
  });

  it('treats stored Shanghai wall-clock expiry as GMT+8', () => {
    const expired = new Date('2026-09-04T15:02:20.000Z');
    const active = new Date('2099-01-01T00:00:00.000Z');
    const now = new Date('2026-10-13T13:00:00.000Z').getTime();
    expect(isActiveShanghaiWallClock(expired, now)).toBe(false);
    expect(isActiveShanghaiWallClock(active, now)).toBe(true);
    expect(isActiveShanghaiWallClock(null, now)).toBe(false);
  });
});
