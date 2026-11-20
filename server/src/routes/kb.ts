import { Router } from 'express';
import { z } from 'zod';
import { withOrg, type Db } from '../db/pool.js';
import { audit } from '../security/audit.js';
import { requireAuth } from '../security/session.js';
import { ah, idParam, parse } from './util.js';

const Art = z.object({
  title: z.string().trim().min(3).max(200),
  body: z.string().trim().min(1).max(50000),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).default([]),
  published: z.boolean().default(true)
}).strict();

export function kbRoutes(db: Db) {
  const r = Router();
  r.get('/', requireAuth(), ah(async (req, res) => {
    const rows = await withOrg(db, req.auth!.orgId, tx => tx.query('SELECT id, title, body, tags, published, updated_at FROM kb_articles ORDER BY updated_at DESC'));
    res.json(rows.rows);
  }));
  r.post('/', requireAuth('admin'), ah(async (req, res) => {
    const b = parse(Art, req.body, res); if (!b) return;
    const a = req.auth!;
    const row = await withOrg(db, a.orgId, async tx => {
      const x = (await tx.query('INSERT INTO kb_articles (org_id, title, body, tags, published) VALUES ($1,$2,$3,$4,$5) RETURNING *', [a.orgId, b.title, b.body, b.tags, b.published])).rows[0];
      await audit(tx, { orgId: a.orgId, actorUserId: a.userId, action: 'kb.created', targetType: 'kb_article', targetId: x.id, ip: req.ip });
      return x;
    });
    res.status(201).json(row);
  }));
  r.put('/:id', requireAuth('admin'), ah(async (req, res) => {
    const id = idParam(req); if (!id) return res.status(404).json({ error: 'Nije pronađeno' });
    const b = parse(Art, req.body, res); if (!b) return;
    const a = req.auth!;
    const row = await withOrg(db, a.orgId, async tx => {
      const x = (await tx.query('UPDATE kb_articles SET title=$2, body=$3, tags=$4, published=$5, updated_at=now() WHERE id=$1 RETURNING *', [id, b.title, b.body, b.tags, b.published])).rows[0];
      if (x) await audit(tx, { orgId: a.orgId, actorUserId: a.userId, action: 'kb.updated', targetType: 'kb_article', targetId: id, ip: req.ip });
      return x;
    });
    if (!row) return res.status(404).json({ error: 'Nije pronađeno' });
    res.json(row);
  }));
  r.delete('/:id', requireAuth('admin'), ah(async (req, res) => {
    const id = idParam(req); if (!id) return res.status(404).json({ error: 'Nije pronađeno' });
    const a = req.auth!;
    const n = await withOrg(db, a.orgId, async tx => {
      const x = await tx.query('DELETE FROM kb_articles WHERE id = $1', [id]);
      if (x.rowCount) await audit(tx, { orgId: a.orgId, actorUserId: a.userId, action: 'kb.deleted', targetType: 'kb_article', targetId: id, ip: req.ip });
      return x.rowCount;
    });
    if (!n) return res.status(404).json({ error: 'Nije pronađeno' });
    res.json({ ok: true });
  }));
  return r;
}
