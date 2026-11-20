import crypto from 'node:crypto';

/** Kriptografski slučajan token (base64url). 32 bajta = 256 bita entropije. */
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** Za tokene visoke entropije dovoljan je brz heš (nema smisla brute-force 256 bita). */
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** AES-256-GCM za tajne u bazi (npr. TOTP tajna). Format: v1.iv.tag.ciphertext */
export function encrypt(plain: string, keyB64: string): string {
  const key = Buffer.from(keyB64, 'base64');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(blob: string, keyB64: string): string {
  const [v, iv, tag, ct] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('bad ciphertext');
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
