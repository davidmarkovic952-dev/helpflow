import { authenticator } from 'otplib';
import { randomToken, sha256 } from './crypto.js';

authenticator.options = { window: 1, step: 30, digits: 6 }; // ±30 s tolerancija sata

export const newTotpSecret = () => authenticator.generateSecret(20);
export const totpUri = (secret: string, email: string, issuer = 'HelpFlow') => authenticator.keyuri(email, issuer, secret);
export const verifyTotp = (secret: string, code: string) => /^\d{6}$/.test(code) && authenticator.check(code, secret);

/** 10 jednokratnih kodova za oporavak; u bazi se čuvaju samo heševi. */
export function newRecoveryCodes(n = 10) {
  const codes = Array.from({ length: n }, () => randomToken(8).replace(/[-_]/g, 'x').slice(0, 10).toLowerCase());
  return { codes, hashes: codes.map(c => sha256(c)) };
}
