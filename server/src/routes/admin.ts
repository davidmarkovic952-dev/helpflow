import { Router } from 'express';
import { z } from 'zod';
import { withOrg, type Db } from '../db/pool.js';
import { audit, verifyChain } from '../security/audit.js';
import { sha256 } from '../security/crypto.js';
import { requireAuth } from '../security/session.js';
import { newInviteToken } from './auth.js';
import { ah, idParam, parse } from './util.js';

const Invite = z.object({ email: z.string().email().max(254), name: z.string().trim().min(1).max(120), role: z.enum(['admin', 'agent']) }).strict();
const UpdUser = z.object({ role: z.enum(['owner', 'admin', 'agent']).optional(), active: z.boolean().optional() }).strict();

export function adminRoutes(db: Db) {
  const r = Router();
  r.use(requireAuth('admin'));

  r.get('/users', ah(async (req, res) => {
    const rows = await withOrg(db, req.auth!.orgId, tx => tx.query(
      `SELECT id, email, name, role, active, totp_enabled, locked_until, created_at, (password_hash IS NULL) AS invite_pending FROM users ORDER BY id`));
    res.json(rows.rows);
  }));

  r.post('/users', ah(async (req, res) => {
    const b = parse(Invite, req.body, res); if (!b) return;
    const a = req.auth!;
    const exists = await db.query('SELECT 1 FROM auth_user_by_email($1)', [b.email]);
    if (exists.rowCount) return res.status(409).json({ error: 'Korisnik sa tim emailom već postoji' });
    const token = newInviteToken();
    const user = await withOrg(db, a.orgId, async tx => {
      const u = (await tx.query('INSERT INTO users (org_id, email, name, role) VALUES ($1,$2,$3,$4) RETURNING id, email, name, role', [a.orgId, b.email, b.name, b.role])).rows[0];
      await tx.query(`INSERT INTO invites (org_id, user_id, token_hash, expires_at) VALUES ($1,$2,$3, now() + interval '48 hours')`, [a.orgId, u.id, sha256(token)]);
      await audit(tx, { orgId: a.orgId, actorUserId: a.userId, action: 'user.invited', targetType: 'user', targetId: u.id, ip: req.ip, metadata: { role: b.role } });
      return u;
    });
    // Link se prikazuje JEDNOM (ili šalje mejlom); u bazi je samo heš.
    res.status(201).json({ user, inviteLink: `/invite/${token}`, expiresInHours: 48 });
  }));

  r.patch('/users/:id', ah(async (req, res) => {
    const id = idParam(req); if (!id) return res.status(404).json({ error: 'Nije pronađeno' });
    const b = parse(UpdUser, req.body, res); if (!b) return;
    const a = req.auth!;
    const out = await withOrg(db, a.orgId, async tx => {
      const u = (await tx.query('SELECT id, role, active FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!u) return { s: 404, e: 'Nije pronađeno' };
      if (id === a.userId) return { s: 400, e: 'Ne možete menjati sopstvenu ulogu ili status' };
      const touchesOwner = u.role === 'owner' || b.role === 'owner' || (u.role === 'admin' && b.role !== undefined);
      if (touchesOwner && a.role !== 'owner') return { s: 403, e: 'Samo vlasnik može menjati administratore i vlasnike' };
      if (u.role === 'owner' && (b.role && b.role !== 'owner' || b.active === false)) {
        const owners = (await tx.query(`SELECT count(*)::int AS n FROM users WHERE role = 'owner' AND active`)).rows[0].n;
        if (owners <= 1) return { s: 400, e: 'Organizacija mora imati bar jednog aktivnog vlasnika' };
      }
      await tx.query('UPDATE users SET role = COALESCE($2, role), active = COALESCE($3, active) WHERE id = $1', [id, b.role ?? null, b.active ?? null]);
      if (b.active === false) await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      await audit(tx, { orgId: a.orgId, actorUserId: a.userId, action: 'user.updated', targetType: 'user', targetId: id, ip: req.ip, metadata: { from: { role: u.role, active: u.active }, to: b } });
      return { s: 200 };
    });
    if (out.s !== 200) return res.status(out.s).json({ error: out.e });
    res.json({ ok: true });
  }));

  r.post('/users/:id/unlock', ah(async (req, res) => {
    const id = idParam(req); if (!id) return res.status(404).json({ error: 'Nije pronađeno' });
    const a = req.auth!;
    await withOrg(db, a.orgId, async tx => {
      const x = await tx.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [id]);
      if (x.rowCount) await audit(tx, { orgId: a.orgId, actorUserId: a.userId, action: 'user.unlocked', targetType: 'user', targetId: id, ip: req.ip });
    });
    res.json({ ok: true });
  }));

  r.get('/audit', ah(async (req, res) => {
    const before = Number(req.query.before) || null;
    const rows = await withOrg(db, req.auth!.orgId, tx => tx.query(
      `SELECT a.id, a.action, a.target_type, a.target_id, a.ip, a.metadata, a.created_at, a.hash, u.name AS actor_name
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
       ${before ? 'WHERE a.id < $1' : ''} ORDER BY a.id DESC LIMIT 100`, before ? [before] : []));
    res.json(rows.rows);
  }));

  r.get('/audit/verify', ah(async (req, res) => {
    res.json(await withOrg(db, req.auth!.orgId, tx => verifyChain(tx, req.auth!.orgId)));
  }));

  return r;
}
