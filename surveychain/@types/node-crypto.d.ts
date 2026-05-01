declare module 'crypto' {
  function randomBytes(size: number): Buffer;
  function scryptSync(password: string | Buffer, salt: string | Buffer, keylen: number): Buffer;
  function createCipheriv(algorithm: string, key: Buffer, iv: Buffer): Cipher;
  function createDecipheriv(algorithm: string, key: Buffer, iv: Buffer): Decipher;

  interface Cipher {
    update(data: string | Buffer, inputEncoding?: string, outputEncoding?: string): Buffer;
    final(outputEncoding?: string): Buffer;
  }

  interface Decipher {
    update(data: Buffer | string, inputEncoding?: string, outputEncoding?: string): Buffer;
    final(outputEncoding?: string): Buffer;
  }
}
