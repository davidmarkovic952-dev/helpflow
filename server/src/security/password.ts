import { hash, verify } from '@node-rs/argon2';
import crypto from 'node:crypto';

/**
 * argon2id sa OWASP preporučenim parametrima (m=19 MiB, t=2, p=1).
 * Heš u sebi nosi parametre, pa se kasnije mogu pojačati bez migracije.
 */
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (pw: string) => hash(pw, OPTS);

export async function verifyPassword(stored: string | null | undefined, pw: string): Promise<boolean> {
  if (!stored) { await hash(pw, OPTS); return false; } // isto vreme odgovora i kad korisnik ne postoji
  try { return await verify(stored, pw); } catch { return false; }
}

// Najčešće lozinke (skraćena lista) — odbijaju se bez obzira na dužinu.
const COMMON = new Set(['123456789012', 'password1234', 'qwertyuiop12', '111111111111', 'iloveyou1234', 'admin1234567', 'welcome12345', 'passwordpassword', 'qwertyqwerty', 'lozinka12345', 'geslo1234567', 'sifra1234567', 'changeme1234', 'letmein12345']);

export function passwordProblems(pw: string, email = ''): string[] {
  const p: string[] = [];
  if (pw.length < 12) p.push('Lozinka mora imati najmanje 12 znakova');
  if (pw.length > 128) p.push('Lozinka može imati najviše 128 znakova');
  if (COMMON.has(pw.toLowerCase())) p.push('Lozinka je previše česta');
  const local = email.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && pw.toLowerCase().includes(local)) p.push('Lozinka ne sme sadržati deo email adrese');
  if (/^(.)\1+$/.test(pw)) p.push('Lozinka ne sme biti jedan ponovljen znak');
  return p;
}

/**
 * Provera u bazi procurelih lozinki (Have I Been Pwned) preko k-anonimnosti:
 * šalje se samo prvih 5 znakova SHA-1 heša, nikad lozinka. Ako servis ne odgovori — ne blokira.
 */
export async function isBreached(pw: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const h = crypto.createHash('sha1').update(pw).digest('hex').toUpperCase();
  try {
    const ctrl = AbortSignal.timeout(2500);
    const res = await fetcher(`https://api.pwnedpasswords.com/range/${h.slice(0, 5)}`, { headers: { 'Add-Padding': 'true' }, signal: ctrl });
    if (!res.ok) return false;
    const body = await res.text();
    return body.split('\n').some(line => line.split(':')[0]?.trim() === h.slice(5) && Number(line.split(':')[1]) > 0);
  } catch { return false; }
}
