import { describe, expect, it } from 'vitest';
import { cellText } from '@/modules/admin/admin-feature-routes.js';

describe('campus Excel cell text', () => {
  it('reads a hyperlink whose visible text is rich text instead of [object Object]', () => {
    expect(
      cellText({
        text: { richText: [{ text: '新华社公告' }] },
        hyperlink: 'https://example.com/job',
      } as never),
    ).toBe('新华社公告');
    expect(cellText({ text: '', hyperlink: 'https://example.com/job' } as never)).toBe(
      'https://example.com/job',
    );
  });
});
