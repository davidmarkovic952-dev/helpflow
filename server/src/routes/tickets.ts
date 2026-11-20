import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import { withOrg, type Db, type Tx } from '../db/pool.js';
import { audit } from '../security/audit.js';
import { requireAuth } from '../security/session.js';
import { canTransition, slaStatus } from '../domain/sla.js';
import { searchKb, type Article } from '../ai/kb.js';
import { buildReplyPrompt, sanitizeDraft, templateDraft } from '../ai/reply.js';
import { buildTriagePrompt, parseTriage, rulesTriage, Category, Priority, type Triage } from '../ai/triage.js';
import type { Llm } from '../ai/provider.js';
import { RateLimiter } from '../security/rateLimit.js';
import { ah, idParam, limit, parse } from './util.js';

const ListQ = z.object({
  status: z.enum(['new', 'open', 'pending', 'resolved', 'closed', 'active']).optional(),
  priority: Priority.optional(),
  assignee: z.union([z.literal('me'), z.literal('none'), z.coerce.number().int().positive()]).optional(),
  q: z.string().max(100).optional()
});
const Patch = z.object({
  status: z.enum(['new', 'open', 'pending', 'resolved', 'closed']).optional(),
  priority: Priority.optional(),
  category: Category.optional(),
  assigneeId: z.number().int().positive().nullable().optional()
}).strict();
const NewMsg = z.object({ body: z.string().trim().min(1).max(20000), internal: z.boolean().default(false) }).strict();

/** Trijaža: LLM ako je podešen, a pri bilo kakvoj grešci ili neispravnom odgovoru — pravila. */
export async function triage(llm: Llm | null, subject: string, body: string): Promise<Triage> {
  if (!llm) return rulesTriage(subject, body);
  try {
    return parseTriage(await llm({ ...buildTriagePrompt(subject, body), json: true, maxTokens: 400 }));
  } catch {
    return { ...rulesTriage(subject, body), reasons: ['AI nije dostupan — korišćena pravila'] };
  }
}

async function loadTicket(tx: Tx, id: number) {
  const t = (await tx.query(
    `SELECT t.*, c.name AS customer_name, c.email AS customer_email, u.name AS assignee_name
     FROM tickets t JOIN customers c ON c.id = t.customer_id LEFT JOIN users u ON u.id = t.assignee_id WHERE t.id = $1`, [id])).rows[0];
  return t;
}

export function ticketRoutes(db: Db, cfg: Config, llm: Llm | null) {
  const r = Router();
  const aiLimiter = new RateLimiter(30, 60 * 60_000); // AI pozivi koštaju: 30/h po korisniku
  r.use(requireAuth());

  r.get('/', ah(async (req, res) => {
    const q = parse(ListQ, req.query, res); if (!q) return;
    const a = req.auth!;
    const where: string[] = [];
    const p: unknown[] = [];
    if (q.status === 'active') where.push(`t.status IN ('new','open','pending')`);
    else if (q.status) { p.push(q.status); where.push(`t.status = $${p.length}`); }
    if (q.priority) { p.push(q.priority); where.push(`t.priority = $${p.length}`); }
    if (q.assignee === 'me') { p.push(a.userId); where.push(`t.assignee_id = $${p.length}`); }
    else if (q.assignee === 'none') where.push('t.assignee_id IS NULL');
    else if (typeof q.assignee === 'number') { p.push(q.assignee); where.push(`t.assignee_id = $${p.length}`); }
    if (q.q) { p.push(`%${q.q.replace(/[\\%_]/g, m => '\\' + m)}%`); where.push(`(t.subject ILIKE $${p.length} OR c.email ILIKE $${p.length} OR c.name ILIKE $${p.length})`); }
    const rows = await withOrg(db, a.orgId, tx => tx.query(
      `SELECT t.id, t.number, t.subject, t.status, t.priority, t.category, t.sentiment, t.created_at, t.updated_at,
              t.first_response_at, t.resolved_at, t.assignee_id, u.name AS assignee_name, c.name AS customer_name
       FROM tickets t JOIN customers c ON c.id = t.customer_id LEFT JOIN users u ON u.id = t.assignee_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.created_at DESC LIMIT 200`, p));
    const now = new Date();
    res.json(rows.rows.map(t => ({ ...t, sla: slaStatus(t, now) })));
  }));

  r.get('/stats', ah(async (req, res) => {
    const a = req.auth!;
    const rows = (await withOrg(db, a.orgId, tx => tx.query(
      `SELECT id, priority, status, created_at, first_response_at, resolved_at, assignee_id FROM tickets WHERE status IN ('new','open','pending')`))).rows;
    const now = new Date();
    const sla = rows.map(t => slaStatus(t, now).worst);
    res.json({
      open: rows.length,
      unassigned: rows.filter(t => !t.assignee_id).length,
      mine: rows.filter(t => t.assignee_id === a.userId).length,
      atRisk: sla.filter(s => s === 'at_risk').length,
      breached: sla.filter(s => s === 'breached').length
    });
  }));

  r.get('/agents', ah(async (req, res) => {
    const rows = await withOrg(db, req.auth!.orgId, tx => tx.query('SELECT id, name FROM users WHERE active AND password_hash IS NOT NULL ORDER BY name'));
    res.json(rows.rows);
  }));

  r.get('/:id', ah(async (req, res) => {
    const id = idParam(req); if (!id) return res.status(404).json({ error: 'Nije pronađeno' });
    const a = req.auth!;
    const out = await withOrg(db, a.orgId, async tx => {
      const t = await loadTicket(tx, id);
      if (!t) return null;
      const msgs = await tx.query(
        `SELECT m.id, m.author_type, m.body, m.internal, m.created_at, u.name AS author_name
         FROM messages m LEFT JOIN users u ON u.id = m.author_user_id WHERE m.ticket_id = $1 ORDER BY m.created_at`, [id]);
      const { public_token_hash: _omit, ...safe } = t;
      return { ...safe, messages: msgs.rows, sla: slaStatus(t) };
    });
    if (!out) return res.status(404).json({ error: 'Nije pronađeno' }); // 404 i za tuđe tikete: ne otkriva postojanje
    res.json(out);
  }));

  r.patch('/:id', ah(async (req, res) => {
    const id = idParam(req); if (!id) return res.status(404).json({ error: 'Nije pronađeno' });
    const body = parse(Patch, req.body, res); if (!body) return;
    const a = req.auth!;
    const out = await withOrg(db, a.orgId, async tx => {
      const t = (await tx.query('SELECT * FROM tickets WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!t) return { status: 404, error: 'Nije pronađeno' };
      if (body.status && !canTransition(t.status, body.status)) return { status: 409, error: `Prelaz ${t.status} → ${body.status} nije dozvoljen` };
      if (body.assigneeId) {
        const u = await tx.query('SELECT 1 FROM users WHERE id = $1 AND active', [body.assigneeId]); // RLS: samo korisnici iste org.
        if (!u.rowCount) return { status: 400, error: 'Nepostojeći agent' };
      }
      const next = { ...t, ...Object.fromEntries(Object.entries({ status: body.status, priority: body.priority, category: body.category, assignee_id: body.assigneeId }).filter(([, v]) => v !== undefined)) };
      const resolvedAt = next.status === 'resolved' || next.status === 'closed' ? (t.resolved_at ?? new Date()) : null;
      await tx.query(
        `UPDATE tickets SET status = $2, priority = $3, category = $4, assignee_id = $5, resolved_at = $6, updated_at = now() WHERE id = $1`,
        [id, next.status, next.priority, next.category, next.assignee_id, resolvedAt]);
      const changes = Object.fromEntries(['status', 'priority', 'category', 'assignee_id'].filter(k => next[k] !== t[k]).map(k => [k, { from: t[k], to: next[k] }]));
      if (Object.keys(changes).length) await audit(tx, { orgId: a.orgId, actorUserId: a.userId, action: 'ticket.updated', targetType: 'ticket', targetId: id, ip: req.ip, metadata: changes });
      return { status: 200, ticket: await loadTicket(tx, id) };
    });
    if (out.status !== 200) return res.status(out.status).json({ error: out.error });
    const { public_token_hash: _omit, ...safe } = out.ticket;
    res.json(safe);
  }));

  r.post('/:id/messages', ah(async (req, res) => {
    const id = idParam(req); if (!id) return res.status(404).json({ error: 'Nije pronađeno' });
    const body = parse(NewMsg, req.body, res); if (!body) return;
    const a = req.auth!;
    const out = await withOrg(db, a.orgId, async tx => {
      const t = (await tx.query('SELECT id, status, first_response_at FROM tickets WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!t) return null;
      const m = (await tx.query(
        `INSERT INTO messages (org_id, ticket_id, author_type, author_user_id, body, internal) VALUES ($1, $2, 'agent', $3, $4, $5) RETURNING id, created_at`,
        [a.orgId, id, a.userId, body.body, body.internal])).rows[0];
      if (!body.internal) {
        await tx.query(
          `UPDATE tickets SET first_response_at = COALESCE(first_response_at, now()),
             status = CASE WHEN status IN ('new','open') THEN 'pending' ELSE status END, updated_at = now() WHERE id = $1`, [id]);
      }
      await audit(tx, { orgId: a.orgId, actorUserId: a.userId, action: body.internal ? 'ticket.note_added' : 'ticket.replied', targetType: 'ticket', targetId: id, ip: req.ip, metadata: { messageId: m.id, length: body.body.length } });
      return m;
    });
    if (!out) return res.status(404).json({ error: 'Nije pronađeno' });
    res.status(201).json(out);
  }));

  r.post('/:id/ai/triage', limit(aiLimiter, req => `ai:${req.auth!.userId}`), ah(async (req, res) => {
    const id = idParam(req); if (!id) return res.status(404).json({ error: 'Nije pronađeno' });
    const a = req.auth!;
    const t = await withOrg(db, a.orgId, async tx => {
      const tk = (await tx.query('SELECT subject FROM tickets WHERE id = $1', [id])).rows[0];
      if (!tk) return null;
      const first = (await tx.query(`SELECT body FROM messages WHERE ticket_id = $1 AND author_type = 'customer' ORDER BY created_at LIMIT 1`, [id])).rows[0];
      return { subject: tk.subject as string, body: (first?.body as string) || '' };
    });
    if (!t) return res.status(404).json({ error: 'Nije pronađeno' });
    const result = await triage(llm, t.subject, t.body);
    await withOrg(db, a.orgId, async tx => {
      await tx.query('UPDATE tickets SET ai_triage = $2, sentiment = $3 WHERE id = $1', [id, JSON.stringify(result), result.sentiment]);
      await audit(tx, { orgId: a.orgId, actorUserId: a.userId, action: 'ai.triage', targetType: 'ticket', targetId: id, ip: req.ip, metadata: { source: result.source, priority: result.priority, category: result.category } });
    });
    res.json(result);
  }));

  r.post('/:id/ai/draft', limit(aiLimiter, req => `ai:${req.auth!.userId}`), ah(async (req, res) => {
    const id = idParam(req); if (!id) return res.status(404).json({ error: 'Nije pronađeno' });
    const a = req.auth!;
    const data = await withOrg(db, a.orgId, async tx => {
      const t = await loadTicket(tx, id);
      if (!t) return null;
      const msgs = (await tx.query('SELECT author_type, body FROM messages WHERE ticket_id = $1 AND NOT internal ORDER BY created_at', [id])).rows;
      const kb = (await tx.query('SELECT id, title, body, tags FROM kb_articles WHERE published')).rows as Article[];
      return { t, msgs, kb };
    });
    if (!data) return res.status(404).json({ error: 'Nije pronađeno' });
    const query = `${data.t.subject} ${data.msgs.filter(m => m.author_type === 'customer').map(m => m.body).join(' ')}`;
    const sources = searchKb(query, data.kb, 3).map(r2 => r2.article);
    let draft = templateDraft(data.t.customer_name, sources), source: 'llm' | 'template' = 'template';
    if (llm) {
      try {
        const prompt = buildReplyPrompt({ subject: data.t.subject, thread: data.msgs.map(m => ({ author: m.author_type, body: m.body })) }, sources);
        const out = sanitizeDraft(await llm({ ...prompt, maxTokens: 600 }), sources);
        if (out.length > 20) { draft = out; source = 'llm'; }
      } catch { /* rezervni šablon */ }
    }
    await withOrg(db, a.orgId, tx => audit(tx, { orgId: a.orgId, actorUserId: a.userId, action: 'ai.draft', targetType: 'ticket', targetId: id, ip: req.ip, metadata: { source, sources: sources.map(s => s.id) } }));
    res.json({ draft, source, sources: sources.map(s => ({ id: s.id, title: s.title })) });
  }));

  return r;
}
