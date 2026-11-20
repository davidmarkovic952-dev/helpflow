import crypto from 'node:crypto';
import type { Tx } from '../db/pool.js';

export interface AuditEvent {
  orgId: number; actorUserId: number | null; action: string;
  targetType?: string; targetId?: string | number; ip?: string; metadata?: Record<string, unknown>;
}

const GENESIS = '0'.repeat(64);

/** Kanonski JSON (sortirani ključevi) da isti sadržaj uvek da isti heš. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

export function entryHash(prev: string, e: { org_id: number; actor_user_id: number | null; action: string; target_type: string | null; target_id: string | null; metadata: unknown; created_at: string }) {
  return crypto.createHash('sha256').update(prev + canonical(e)).digest('hex');
}

/**
 * Upis u revizijsku sled unutar iste transakcije kao i promena. Advisory lock serijalizuje
 * upise po organizaciji, pa lanac heševa ostaje linearan i pri paralelnim zahtevima.
 */
export async function audit(tx: Tx, ev: AuditEvent) {
  await tx.query('SELECT pg_advisory_xact_lock(42, $1)', [ev.orgId]);
  const last = await tx.query('SELECT hash FROM audit_log WHERE org_id = $1 ORDER BY id DESC LIMIT 1', [ev.orgId]);
  const prev = last.rows[0]?.hash ?? GENESIS;
  const created_at = new Date().toISOString();
  const row = {
    org_id: ev.orgId, actor_user_id: ev.actorUserId, action: ev.action,
    target_type: ev.targetType ?? null, target_id: ev.targetId === undefined ? null : String(ev.targetId),
    metadata: ev.metadata ?? {}, created_at
  };
  const hash = entryHash(prev, row);
  await tx.query(
    `INSERT INTO audit_log (org_id, actor_user_id, action, target_type, target_id, ip, metadata, created_at, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [row.org_id, row.actor_user_id, row.action, row.target_type, row.target_id, ev.ip ?? null, JSON.stringify(row.metadata), created_at, prev, hash]);
}

/** Proverava ceo lanac; vraća prvi neispravan zapis ako je neko menjao podatke mimo aplikacije. */
export async function verifyChain(tx: Tx, orgId: number) {
  const { rows } = await tx.query(
    `SELECT id, org_id, actor_user_id, action, target_type, target_id, metadata,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at, prev_hash, hash
     FROM audit_log WHERE org_id = $1 ORDER BY id`, [orgId]);
  let prev = GENESIS;
  for (const r of rows) {
    const expected = entryHash(prev, { org_id: r.org_id, actor_user_id: r.actor_user_id, action: r.action, target_type: r.target_type, target_id: r.target_id, metadata: r.metadata, created_at: r.created_at });
    if (r.prev_hash !== prev || r.hash !== expected) return { ok: false as const, entries: rows.length, brokenAt: Number(r.id) };
    prev = r.hash;
  }
  return { ok: true as const, entries: rows.length, head: prev };
}
