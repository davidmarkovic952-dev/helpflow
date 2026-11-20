import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 10, statement_timeout: 10_000, idleTimeoutMillis: 30_000 });
}

/**
 * Svaki rad sa podacima organizacije ide kroz ovu funkciju: transakcija + SET LOCAL app.org_id.
 * Row Level Security u bazi onda garantuje da upit ne može da vidi ili izmeni tuđe redove,
 * čak i ako u aplikacionom kodu fali WHERE org_id = ...
 */
export async function withOrg<T>(db: Db, orgId: number, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!Number.isInteger(orgId) || orgId <= 0) throw new Error('invalid org');
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    await tx.query("SELECT set_config('app.org_id', $1, true)", [String(orgId)]);
    const out = await fn(tx);
    await tx.query('COMMIT');
    return out;
  } catch (e) {
    await tx.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    tx.release();
  }
}
