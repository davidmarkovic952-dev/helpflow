import type { Request, Response, NextFunction } from 'express';
import type { Config } from '../config.js';
import { withOrg, type Db, type Tx } from '../db/pool.js';
import crypto from 'node:crypto';
import { randomToken, sha256, safeEqual } from './crypto.js';

/** CSRF token = HMAC(ključ, token sesije): vezan za sesiju, ne može se pogoditi bez kolačića. */
export const csrfFor = (sessionToken: string, keyB64: string) =>
  crypto.createHmac('sha256', Buffer.from(keyB64, 'base64')).update(`csrf:${sessionToken}`).digest('base64url');

export type Role = 'owner' | 'admin' | 'agent';
export interface SessionUser { sessionId: number; userId: number; orgId: number; role: Role; name: string; email: string; mfaPassed: boolean; totpEnabled: boolean; csrfToken: string }

declare module 'express-serve-static-core' {
  interface Request { auth?: SessionUser; db?: Db }
}

export const cookieName = (cfg: Config) => (cfg.COOKIE_SECURE ? '__Host-hf_sid' : 'hf_sid');

export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
}

export function setSessionCookie(res: Response, cfg: Config, token: string) {
  const parts = [`${cookieName(cfg)}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${cfg.SESSION_ABSOLUTE_HOURS * 3600}`];
  if (cfg.COOKIE_SECURE) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
export function clearSessionCookie(res: Response, cfg: Config) {
  res.append('Set-Cookie', `${cookieName(cfg)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${cfg.COOKIE_SECURE ? '; Secure' : ''}`);
}

/** Nova sesija (uvek novi token → nema session fixation). Vraća token i CSRF token koji se šalju klijentu. */
export async function createSession(tx: Tx, cfg: Config, u: { id: number; org_id: number }, req: Request, mfaPassed: boolean) {
  const token = randomToken(32);
  const csrf = csrfFor(token, cfg.ENCRYPTION_KEY);
  const { rows } = await tx.query(
    `INSERT INTO sessions (org_id, user_id, token_hash, csrf_hash, mfa_passed, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(hours => $8)) RETURNING id`,
    [u.org_id, u.id, sha256(token), sha256(csrf), mfaPassed, req.ip ?? null, String(req.headers['user-agent'] || '').slice(0, 200), cfg.SESSION_ABSOLUTE_HOURS]);
  return { token, csrf, sessionId: rows[0].id as number };
}

/** Učitava sesiju iz kolačića: proverava apsolutni rok, neaktivnost i opoziv. */
export function sessionMiddleware(db: Db, cfg: Config) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = readCookie(req, cookieName(cfg));
    if (!token || token.length > 100) return next();
    const th = sha256(token);
    try {
      const org = await db.query('SELECT auth_session_org($1) AS org_id', [th]);
      const orgId = org.rows[0]?.org_id;
      if (!orgId) return next();
      req.auth = await withOrg(db, orgId, async tx => {
        const { rows } = await tx.query(
          `SELECT s.id, s.user_id, s.csrf_hash, s.mfa_passed, s.last_seen_at, s.expires_at, s.revoked_at,
                  u.role, u.name, u.email, u.active, u.totp_enabled
           FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`, [th]);
        const s = rows[0];
        if (!s || s.revoked_at || !s.active) return undefined;
        const now = Date.now();
        const idle = now - new Date(s.last_seen_at).getTime() > cfg.SESSION_IDLE_MINUTES * 60_000;
        if (idle || new Date(s.expires_at).getTime() < now) {
          await tx.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [s.id]);
          return undefined;
        }
        if (now - new Date(s.last_seen_at).getTime() > 60_000) await tx.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [s.id]);
        return { sessionId: s.id, userId: s.user_id, orgId, role: s.role, name: s.name, email: s.email, mfaPassed: s.mfa_passed, totpEnabled: s.totp_enabled, csrfToken: csrfFor(token, cfg.ENCRYPTION_KEY) };
      });
    } catch (e) { return next(e); }
    next();
  };
}

const RANK: Record<Role, number> = { agent: 1, admin: 2, owner: 3 };

/** Zahteva prijavu (i završen 2FA korak, osim ako je allowPartial). */
export function requireAuth(min: Role = 'agent', { allowPartial = false } = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    const a = req.auth;
    if (!a) return res.status(401).json({ error: 'Potrebna je prijava' });
    if (!a.mfaPassed && !allowPartial) return res.status(401).json({ error: 'Potrebna je dvofaktorska provera', mfaRequired: true });
    if (RANK[a.role] < RANK[min]) return res.status(403).json({ error: 'Nemate dozvolu' });
    next();
  };
}

/**
 * CSRF: SameSite=Strict kolačić + obavezan X-CSRF-Token vezan za sesiju + provera Origin zaglavlja.
 * Važi za sve zahteve koji menjaju stanje.
 */
export function csrfProtection(cfg: Config) {
  const allowed = new URL(cfg.APP_ORIGIN).origin;
  return (req: Request, res: Response, next: NextFunction) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && origin !== allowed) return res.status(403).json({ error: 'Nedozvoljen izvor zahteva' });
    if (!req.auth) return next(); // bez sesije nema šta da se zloupotrebi; rute same traže prijavu
    const header = String(req.headers['x-csrf-token'] || '');
    if (!header || !safeEqual(header, req.auth.csrfToken)) return res.status(403).json({ error: 'Neispravan CSRF token' });
    next();
  };
}
