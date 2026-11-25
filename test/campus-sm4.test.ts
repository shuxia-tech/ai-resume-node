import { describe, expect, it } from 'vitest';
import smCrypto from 'sm-crypto';
import { sm4Decrypt, sm4Encrypt } from '@/modules/campus-circle/campus-support.js';

const KEY = '0123456789abcdeffedcba9876543210';
const IV = 'fedcba98765432100123456789abcdef';

describe('campus contact encryption', () => {
  it('reads the ECB ciphertext Java actually stored', () => {
    expect(sm4Decrypt('d456ed6786b961d9f2490cb6dbf87af0')).toBe('19565151537');
  });

  it('still reads contacts written with real CBC and writes new values as ECB', () => {
    const cbc = smCrypto.sm4.encrypt('wxid_test', KEY, { mode: 'cbc', iv: IV });
    expect(sm4Decrypt(cbc)).toBe('wxid_test');
    expect(sm4Encrypt('19565151537')).toBe('d456ed6786b961d9f2490cb6dbf87af0');
  });
});
