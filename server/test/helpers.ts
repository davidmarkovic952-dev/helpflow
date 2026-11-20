import { inject } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import crypto from 'node:crypto';
import { loadConfig, type Config } from '../src/config.js';
import { createPool, type Db } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/security/password.js';
import type { Llm } from '../src/ai/provider.js';

export const PW = 'Tacna-lozinka-2026!';
export const ORIGIN = 'http://localhost:5173';

export function testConfig(over: Record<string, string> = {}): Config {
  return loadConfig({ NODE_ENV: 'test', DATABASE_URL: inject('appUrl'), ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), COOKIE_SECURE: 'false', APP_ORIGIN: ORIGIN, TRUST_PROXY: '1', ...over });
}

export async function admin() {
  const c = new pg.Client({ connectionString: inject('adminUrl') });
  await c.connect();
  return c;
}

/** Svaki test dobija sopstvene organizacije (izolacija bez brisanja baze). */
export async function makeOrg(name = 'org') {
  const c = await admin();
  const slug = `${name}-${crypto.randomBytes(4).toString('hex')}`;
  const org = (await c.query('INSERT INTO orgs (slug, name) VALUES ($1, $2) RETURNING id', [slug, `Org ${name}`])).rows[0].id as number;
  const hash = await hashPassword(PW);
  const mk = async (role: string) => {
    const email = `${role}-${slug}@test.rs`;
    const id = (await c.query('INSERT INTO users (org_id, email, name, role, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id', [org, email, `${role} ${name}`, role, hash])).rows[0].id as number;
    return { id, email };
  };
  const owner = await mk('owner'), adminU = await mk('admin'), agent = await mk('agent');
  await c.end();
  return { id: org, slug, owner, admin: adminU, agent };
}

export function makeApp(over: Record<string, string> = {}, llm: Llm | null = null) {
  const cfg = testConfig(over);
  const db: Db = createPool(cfg.DATABASE_URL);
  return { app: createApp(db, cfg, { llm }), db, cfg };
}

/** Prijavljen agent: supertest agent čuva kolačić; vraća i CSRF token. */
export async function login(app: Parameters<typeof request.agent>[0], email: string, password = PW) {
  const agent = request.agent(app).set('X-Forwarded-For', randomIp());
  const r = await agent.post('/api/auth/login').set('Origin', ORIGIN).send({ email, password });
  return { agent, res: r, csrf: r.body.csrfToken as string };
}

export const randomIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
