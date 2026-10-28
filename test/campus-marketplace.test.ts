import { describe, expect, it } from 'vitest';
import { CampusError } from '@/modules/campus-circle/campus-support.js';
import { assertQuote, isCaseArticle, isPresentation, isWechatArticle } from '@/modules/campus-circle/campus-marketplace.js';

describe('campus marketplace checks', () => {
  it('accepts a WeChat article link and rejects other hosts', () => {
    expect(isWechatArticle('https://mp.weixin.qq.com/s/abc')).toBe(true);
    expect(isWechatArticle('https://mp.weixin.qq.com/s?__biz=1')).toBe(true);
    expect(isWechatArticle('http://mp.weixin.qq.com/s/abc')).toBe(false);
    expect(isWechatArticle('https://example.com/s/abc')).toBe(false);
    expect(isCaseArticle('https://mp.weixin.qq.com/s?__biz=1')).toBe(true);
    expect(isCaseArticle('https://mp.weixin.qq.com/other')).toBe(false);
  });

  it('recognizes PPT and PPTX payloads', () => {
    const pptx = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('ppt/presentation.xml [Content_Types].xml', 'latin1'),
    ]);
    const ppt = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.from('PowerPoint Document', 'utf16le'),
    ]);
    expect(isPresentation(pptx, 'pptx')).toBe(true);
    expect(isPresentation(ppt, 'ppt')).toBe(true);
    expect(isPresentation(Buffer.from('hello'), 'pptx')).toBe(false);
  });

  it('keeps advertising quotes to two decimal places', () => {
    expect(assertQuote(12.5)).toBe(12.5);
    expect(assertQuote('0.01')).toBe(0.01);
    expect(() => assertQuote(0)).toThrow(CampusError);
    expect(() => assertQuote(1.239)).toThrow(CampusError);
  });
});
