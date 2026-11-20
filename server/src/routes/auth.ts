import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import { withOrg, type Db } from '../db/pool.js';
import { audit } from '../security/audit.js';
import { decrypt, encrypt, randomToken, sha256 } from '../security/crypto.js';
import { hashPassword, isBreached, passwordProblems, verifyPassword } from '../security/password.js';
import { lockoutMinutes, RateLimiter } from '../security/rateLimit.js';
import { clearSessionCookie, createSession, requireAuth, setSessionCookie } from '../security/session.js';
import { newRecoveryCodes, newTotpSecret, totpUri, verifyTotp } from '../security/totp.js';
import { ah, limit, parse } from './util.js';

const Login = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(128) }).strict();
const Mfa = z.object({ code: z.string().min(6).max(20) }).strict();
const ChangePw = z.object({ current: z.string().min(1).max(128), next: z.string().min(1).max(128) }).strict();
const Accept = z.object({ password: z.string().min(1).max(128) }).strict();
const GENERIC = 'Pogrešan email ili lozinka';

export function authRoutes(db: Db, cfg: Config) {
  const r = Router();
  const ipLimiter = new RateLimiter(20, 15 * 60_000);       // 20 pokušaja / 15 min po IP-u
  const acctLimiter = new RateLimiter(10, 15 * 60_000);     // 10 / 15 min po nalogu (i pri rotaciji IP-ova)
  const mfaLimiter = new RateLimiter(5, 5 * 60_000);        // 5 kodova / 5 min po sesiji

  r.post('/login', limit(ipLimiter, req => `ip:${req.ip}`), ah(async (req, res) => {
    const body = parse(Login, req.body, res); if (!body) return;
    if (acctLimiter.take(`acct:${body.email.toLowerCase()}`) > 0) return res.status(429).json({ error: 'Previše pokušaja, pokušajte kasnije' });
    const found = (await db.query('SELECT * FROM auth_user_by_email($1)', [body.email])).rows[0];
    if (!found) { await verifyPassword(null, body.password); return res.status(401).json({ error: GENERIC }); }

    const out = await withOrg(db, found.org_id, async tx => {
      const u = (await tx.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [found.id])).rows[0];
      if (u.locked_until && new Date(u.locked_until) > new Date()) {
        await verifyPassword(null, body.password);
        await audit(tx, { orgId: u.org_id, actorUserId: u.id, action: 'auth.login_blocked', ip: req.ip, metadata: { reason: 'locked' } });
        return { status: 401 as const };
      }
      const ok = u.active && await verifyPassword(u.password_hash, body.password);
      if (!ok) {
        const failed = u.failed_logins + 1;
        const mins = lockoutMinutes(failed);
        await tx.query(`UPDATE users SET failed_logins = $2, locked_until = CASE WHEN $3 > 0 THEN now() + make_interval(mins => $3) ELSE locked_until END WHERE id = $1`, [u.id, failed, mins]);
        await audit(tx, { orgId: u.org_id, actorUserId: u.id, action: 'auth.login_failed', ip: req.ip, metadata: { failed, lockedMinutes: mins } });
        return { status: 401 as const };
      }
      await tx.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id]);
      const s = await createSession(tx, cfg, u, req, !u.totp_enabled);
      await audit(tx, { orgId: u.org_id, actorUserId: u.id, action: u.totp_enabled ? 'auth.password_ok_mfa_pending' : 'auth.login', ip: req.ip, metadata: { sessionId: s.sessionId } });
      return { status: 200 as const, s, mfaRequired: u.totp_enabled as boolean };
    });
    if (out.status !== 200) return res.status(401).json({ error: GENERIC });
    acctLimiter.reset(`acct:${body.email.toLowerCase()}`);
    setSessionCookie(res, cfg, out.s!.token);
    res.json({ mfaRequired: out.mfaRequired, csrfToken: out.s!.csrf });
  }));

  r.post('/mfa', requireAuth('agent', { allowPartial: true }), ah(async (req, res) => {
    const a = req.auth!;
    if (a.mfaPassed) return res.json({ ok: true });
    if (mfaLimiter.take(`mfa:${a.sessionId}`) > 0) return res.status(429).json({ error: 'Previše pokušaja' });
    const body = parse(Mfa, req.body, res); if (!body) return;
    const ok = await withOrg(db, a.orgId, async tx => {
      const u = (await tx.query('SELECT totp_secret_enc FROM users WHERE id = $1', [a.userId])).rows[0];
      let passed = false, via = 'totp';
      const code = body.code.replace(/\s/g, '').toLowerCase();
      if (/^\d{6}$/.test(code) && u?.totp_secret_enc) passed = verifyTotp(decrypt(u.totp_secret_enc, cfg.ENCRYPTION_KEY), code);
      else {
        const rc = await tx.query('UPDATE recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id', [a.userId, sha256(code)]);
        passed = rc.rowCount === 1; via = 'recovery_code';
      }
      if (passed) await tx.query('UPDATE sessions SET mfa_passed = TRUE WHERE id = $1', [a.sessionId]);
      await audit(tx, { orgId: a.orgId, actorUserId: a.userId, action: passed ? 'auth.login' : 'auth.mfa_failed', ip: req.ip, metadata: { via, sessionId: a.sessionId } });
      return passed;
    });
    if (!ok) return res.status(401).json({ error: 'Neispravan kod' });
    res.json({ ok: true });
  }));

  r.get('/me', requireAuth('agent', { allowPartial: true }), (req, res) => {
    const a = req.auth!;
    res.json({ user: { id: a.userId, name: a.name, email: a.email, role: a.role, totpEnabled: a.totpEnabled }, mfaRequired: !a.mfaPassed, csrfToken: a.csrfToken });
  });

  r.post('/logout', requireAuth('agent', { allowPartial: true }), ah(async (req, res) => {
    const a = req.auth!;
    await withOrg(db, a.orgId, async tx => {
      await tx.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [a.sessionId]);
      await audit(tx, { orgId: a.orgId, actorUserId: a.userId, action: 'auth.logout', ip: req.ip });
    });
    clearSessionCookie(res, cfg);
    res.json({ ok: true });
  }));

  r.get('/sessions', requireAuth(), ah(async (req, res) => {
    const a = req.auth!;
    const rows = await withOrg(db, a.orgId, tx => tx.query(
      `SELECT id, ip, user_agent, created_at, last_seen_at FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`, [a.userId]));
    res.json(rows.rows.map(s => ({ ...s, current: s.id === a.sessionId })));
  }));

  r.delete('/sessions/:id', requireAuth(), ah(async (req, res) => {
    const a = req.auth!;
    const id = Number(req.params.id);
    await withOrg(db, a.orgId, async tx => {
      const r2 = await tx.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [id, a.userId]);
      if (r2.rowCount) await audit(tx, { orgId: a.orgId, actorUserId: a.userId, action: 'auth.session_revoked', targetType: 'session', targetId: id, ip: req.ip });
    });
    res.json({ ok: true });
  }));

  r.post('/logout-all', requireAuth(), ah(async (req, res) => {
    const a = req.auth!;
    await withOrg(db, a.orgId, async tx => {
      await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [a.userId, a.sessionId]);
      await audit(tx, { orgId: a.orgId, actorUserId: a.userId, action: 'auth.logout_others', ip: req.ip });
    });
    res.json({ ok: true });
  }));

  r.post('/password', requireAuth(), ah(async (req, res) => {
    const a = req.auth!;
    const body = parse(ChangePw, req.body, res); if (!body) return;
    const problems = passwordProblems(body.next, a.email);
    if (cfg.HIBP_CHECK && !problems.length && await isBreached(body.next)) problems.push('Ova lozinka se pojavila u poznatim curenjima podataka');
    if (problems.length) return res.status(400).json({ error: problems[0], problems });
    const ok = await withOrg(db, a.orgId, async tx => {
      const u = (await tx.query('SELECT password_hash FROM users WHERE id = $1', [a.userId])).rows[0];
      if (!await verifyPassword(u.password_hash, body.current)) return false;
      await tx.query('UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1', [a.userId, await hashPassword(body.next)]);
      await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [a.userId, a.sessionId]);
      await audit(tx, { orgId: a.orgId, actorUserId: a.userId, action: 'auth.password_changed', ip: req.ip });
      return true;
    });
    if (!ok) return res.status(400).json({ error: 'Trenutna lozinka nije tačna' });
    res.json({ ok: true });
  }));

  // ---- 2FA (TOTP) ----
  r.post('/totp/setup', requireAuth(), ah(async (req, res) => {
    const a = req.auth!;
    if (a.totpEnabled) return res.status(400).json({ error: '2FA je već uključen' });
    const secret = newTotpSecret();
    await withOrg(db, a.orgId, tx => tx.query('UPDATE users SET totp_secret_enc = $2 WHERE id = $1', [a.userId, encrypt(secret, cfg.ENCRYPTION_KEY)]));
    res.json({ secret, uri: totpUri(secret, a.email) });
  }));

  r.post('/totp/enable', requireAuth(), ah(async (req, res) => {
    const a = req.auth!;
    const body = parse(Mfa, req.body, res); if (!body) return;
    const codes = await withOrg(db, a.orgId, async tx => {
      const u = (await tx.query('SELECT totp_secret_enc, totp_enabled FROM users WHERE id = $1', [a.userId])).rows[0];
      if (!u?.totp_secret_enc || u.totp_enabled) return null;
      if (!verifyTotp(decrypt(u.totp_secret_enc, cfg.ENCRYPTION_KEY), body.code)) return null;
      const rc = newRecoveryCodes();
      await tx.query('UPDATE users SET totp_enabled = TRUE WHERE id = $1', [a.userId]);
      await tx.query('DELETE FROM recovery_codes WHERE user_id = $1', [a.userId]);
      for (const h of rc.hashes) await tx.query('INSERT INTO recovery_codes (org_id, user_id, code_hash) VALUES ($1, $2, $3)', [a.orgId, a.userId, h]);
      await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [a.userId, a.sessionId]);
      await audit(tx, { orgId: a.orgId, actorUserId: a.userId, action: 'auth.mfa_enabled', ip: req.ip });
      return rc.codes;
    });
    if (!codes) return res.status(400).json({ error: 'Neispravan kod' });
    res.json({ recoveryCodes: codes });
  }));

  r.post('/totp/disable', requireAuth(), ah(async (req, res) => {
    const a = req.auth!;
    const body = parse(z.object({ password: z.string().max(128), code: z.string().max(20) }).strict(), req.body, res); if (!body) return;
    const ok = await withOrg(db, a.orgId, async tx => {
      const u = (await tx.query('SELECT password_hash, totp_secret_enc FROM users WHERE id = $1', [a.userId])).rows[0];
      if (!u.totp_secret_enc || !await verifyPassword(u.password_hash, body.password) || !verifyTotp(decrypt(u.totp_secret_enc, cfg.ENCRYPTION_KEY), body.code)) return false;
      await tx.query('UPDATE users SET totp_enabled = FALSE, totp_secret_enc = NULL WHERE id = $1', [a.userId]);
      await tx.query('DELETE FROM recovery_codes WHERE user_id = $1', [a.userId]);
      await audit(tx, { orgId: a.orgId, actorUserId: a.userId, action: 'auth.mfa_disabled', ip: req.ip });
      return true;
    });
    if (!ok) return res.status(400).json({ error: 'Lozinka ili kod nisu tačni' });
    res.json({ ok: true });
  }));

  // ---- prihvatanje pozivnice (postavljanje lozinke) ----
  r.post('/invite/:token', limit(ipLimiter, req => `ip:${req.ip}`), ah(async (req, res) => {
    const body = parse(Accept, req.body, res); if (!body) return;
    const th = sha256(String(req.params.token).slice(0, 100));
    const orgId = (await db.query('SELECT auth_invite_org($1) AS o', [th])).rows[0]?.o;
    if (!orgId) return res.status(400).json({ error: 'Pozivnica nije važeća' });
    const result = await withOrg(db, orgId, async tx => {
      const inv = (await tx.query('SELECT i.*, u.email FROM invites i JOIN users u ON u.id = i.user_id WHERE i.token_hash = $1 FOR UPDATE OF i', [th])).rows[0];
      if (!inv || inv.used_at || new Date(inv.expires_at) < new Date()) return { error: 'Pozivnica je istekla ili je već iskorišćena' };
      const problems = passwordProblems(body.password, inv.email);
      if (problems.length) return { error: problems[0] };
      await tx.query('UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1', [inv.user_id, await hashPassword(body.password)]);
      await tx.query('UPDATE invites SET used_at = now() WHERE id = $1', [inv.id]);
      await audit(tx, { orgId, actorUserId: inv.user_id, action: 'auth.invite_accepted', ip: req.ip });
      return { ok: true };
    });
    if ('error' in result) return res.status(400).json(result);
    res.json(result);
  }));

  return r;
}

export const newInviteToken = () => randomToken(32);
