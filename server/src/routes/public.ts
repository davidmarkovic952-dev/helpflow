import { Router } from 'express';
import { z } from 'zod';
import { withOrg, type Db } from '../db/pool.js';
import { audit } from '../security/audit.js';
import { randomToken, sha256 } from '../security/crypto.js';
import { RateLimiter } from '../security/rateLimit.js';
import type { Llm } from '../ai/provider.js';
import { triage } from './tickets.js';
import { ah, limit, parse } from './util.js';

const NewTicket = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(10).max(10000),
  website: z.string().max(0).optional() // honeypot: ljudi ga ne vide, botovi ga popune
}).strict();
const Reply = z.object({ body: z.string().trim().min(1).max(10000) }).strict();

/**
 * Javni portal za kupce (bez naloga). Pristup tiketu ide preko nasumičnog tokena od 256 bita
 * koji kupac dobija jednom; u bazi je samo heš. Interne beleške agenata nikad ne izlaze ovde.
 */
export function publicRoutes(db: Db, llm: Llm | null) {
  const r = Router();
  const createLimiter = new RateLimiter(5, 60 * 60_000);
  const readLimiter = new RateLimiter(120, 60 * 60_000);

  r.get('/orgs/:slug', limit(readLimiter, req => `pr:${req.ip}`), ah(async (req, res) => {
    const o = (await db.query('SELECT * FROM public_org_by_slug($1)', [String(req.params.slug).slice(0, 50)])).rows[0];
    if (!o) return res.status(404).json({ error: 'Nije pronađeno' });
    res.json({ name: o.name });
  }));

  r.post('/orgs/:slug/tickets', limit(createLimiter, req => `pc:${req.ip}`), ah(async (req, res) => {
    const b = parse(NewTicket, req.body, res); if (!b) return;
    const org = (await db.query('SELECT * FROM public_org_by_slug($1)', [String(req.params.slug).slice(0, 50)])).rows[0];
    if (!org) return res.status(404).json({ error: 'Nije pronađeno' });
    const t = await triage(llm, b.subject, b.body);
    const token = randomToken(32);
    const out = await withOrg(db, org.id, async tx => {
      const c = (await tx.query(
        `INSERT INTO customers (org_id, email, name) VALUES ($1, $2, $3)
         ON CONFLICT (org_id, lower(email)) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [org.id, b.email, b.name])).rows[0];
      const num = (await tx.query('UPDATE orgs SET ticket_seq = ticket_seq + 1 WHERE id = $1 RETURNING ticket_seq', [org.id])).rows[0].ticket_seq;
      const tk = (await tx.query(
        `INSERT INTO tickets (org_id, number, public_token_hash, customer_id, subject, priority, category, sentiment, ai_triage)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, number`,
        [org.id, num, sha256(token), c.id, b.subject, t.priority, t.category, t.sentiment, JSON.stringify(t)])).rows[0];
      await tx.query(`INSERT INTO messages (org_id, ticket_id, author_type, body) VALUES ($1,$2,'customer',$3)`, [org.id, tk.id, b.body]);
      await audit(tx, { orgId: org.id, actorUserId: null, action: 'ticket.created', targetType: 'ticket', targetId: tk.id, ip: req.ip, metadata: { channel: 'portal', triage: t.source } });
      return tk;
    });
    res.status(201).json({ number: out.number, token });
  }));

  const loadByToken = async (token: string) => {
    const th = sha256(token.slice(0, 100));
    const orgId = (await db.query('SELECT public_ticket_org($1) AS o', [th])).rows[0]?.o;
    return orgId ? { orgId: orgId as number, th } : null;
  };

  r.get('/tickets/:token', limit(readLimiter, req => `pr:${req.ip}`), ah(async (req, res) => {
    const k = await loadByToken(String(req.params.token));
    if (!k) return res.status(404).json({ error: 'Nije pronađeno' });
    const out = await withOrg(db, k.orgId, async tx => {
      const t = (await tx.query('SELECT id, number, subject, status, created_at FROM tickets WHERE public_token_hash = $1', [k.th])).rows[0];
      const msgs = (await tx.query(
        `SELECT m.author_type, m.body, m.created_at, CASE WHEN m.author_type = 'agent' THEN split_part(u.name, ' ', 1) END AS agent
         FROM messages m LEFT JOIN users u ON u.id = m.author_user_id
         WHERE m.ticket_id = $1 AND NOT m.internal ORDER BY m.created_at`, [t.id])).rows;
      const org = (await tx.query('SELECT name FROM orgs WHERE id = $1', [k.orgId])).rows[0];
      const { id: _id, ...pub } = t;
      return { ...pub, org: org.name, messages: msgs };
    });
    res.json(out);
  }));

  r.post('/tickets/:token/messages', limit(createLimiter, req => `pc:${req.ip}`), ah(async (req, res) => {
    const b = parse(Reply, req.body, res); if (!b) return;
    const k = await loadByToken(String(req.params.token));
    if (!k) return res.status(404).json({ error: 'Nije pronađeno' });
    await withOrg(db, k.orgId, async tx => {
      const t = (await tx.query('SELECT id, status FROM tickets WHERE public_token_hash = $1 FOR UPDATE', [k.th])).rows[0];
      await tx.query(`INSERT INTO messages (org_id, ticket_id, author_type, body) VALUES ($1,$2,'customer',$3)`, [k.orgId, t.id, b.body]);
      await tx.query(`UPDATE tickets SET status = CASE WHEN status IN ('pending','resolved','closed') THEN 'open' ELSE status END, resolved_at = NULL, updated_at = now() WHERE id = $1`, [t.id]);
      await audit(tx, { orgId: k.orgId, actorUserId: null, action: 'ticket.customer_replied', targetType: 'ticket', targetId: t.id, ip: req.ip });
    });
    res.status(201).json({ ok: true });
  }));

  return r;
}
