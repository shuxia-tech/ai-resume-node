declare module 'sm-crypto' {
  export const sm2: {
    doDecrypt(ciphertext: string, privateKey: string, cipherMode?: 0 | 1): string;
  };

  export const sm3: (value: string) => string;

  export const sm4: {
    encrypt(value: string, key: string, options?: { mode?: string; iv?: string }): string;
    decrypt(value: string, key: string, options?: { mode?: string; iv?: string }): string;
  };

  const api: { sm2: typeof sm2; sm3: typeof sm3; sm4: typeof sm4 };
  export default api;
}
