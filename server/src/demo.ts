/**
 * Lokalni demo bez instalacije baze: pokreće pravi PostgreSQL (embedded-postgres), primenjuje migracije,
 * ubacuje demo podatke i diže server. Ništa se ne čuva posle gašenja.
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { migrate } from './db/migrate.js';
import { seed } from './seed.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { createApp } from './app.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helpflow-'));
fs.chmodSync(dir, 0o777);
const port = 54400 + Math.floor(Math.random() * 500);
const adminPw = crypto.randomBytes(12).toString('hex'), appPw = crypto.randomBytes(12).toString('hex');
const pg = new EmbeddedPostgres({ databaseDir: path.join(dir, 'data'), user: 'postgres', password: adminPw, port, persistent: false, onLog: () => {} });
await pg.initialise(); await pg.start(); await pg.createDatabase('helpflow');
const adminUrl = `postgres://postgres:${adminPw}@localhost:${port}/helpflow`;
await migrate(adminUrl, appPw);
await seed(adminUrl);

const cfg = loadConfig({
  ...process.env, NODE_ENV: 'development',
  DATABASE_URL: `postgres://helpflow_app:${appPw}@localhost:${port}/helpflow`,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('base64'),
  COOKIE_SECURE: process.env.COOKIE_SECURE || 'false',
  APP_ORIGIN: process.env.APP_ORIGIN || 'http://localhost:3000',
  PORT: process.env.PORT || '3000'
});
const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
const server = createApp(createPool(cfg.DATABASE_URL), cfg, { clientDir }).listen(cfg.PORT, () => {
  console.log(`\nHelpFlow demo: http://localhost:${cfg.PORT}`);
  console.log('Prijava: owner@demo.rs / admin@demo.rs / agent@demo.rs — lozinka: demo-lozinka-2026');
  console.log(`Portal za kupce: http://localhost:${cfg.PORT}/s/demo\n`);
});
const stop = async () => { server.close(); await pg.stop(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
