import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import EmbeddedPostgres from 'embedded-postgres';
import type { TestProject } from 'vitest/node';
import { migrate } from '../src/db/migrate.js';

let pg: EmbeddedPostgres | null = null;
let dir = '';

export async function setup(project: TestProject) {
  let adminUrl = process.env.TEST_DATABASE_ADMIN_URL; // CI: Postgres servis
  const appPw = 'test-app-pw';
  if (!adminUrl) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-test-'));
    fs.chmodSync(dir, 0o777);
    const port = 55400 + Math.floor(Math.random() * 400);
    pg = new EmbeddedPostgres({ databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'pw', port, persistent: false, onLog: () => {} });
    await pg.initialise(); await pg.start(); await pg.createDatabase('hf');
    adminUrl = `postgres://postgres:pw@localhost:${port}/hf`;
  }
  await migrate(adminUrl, appPw);
  const u = new URL(adminUrl);
  u.username = 'helpflow_app'; u.password = appPw;
  project.provide('adminUrl', adminUrl);
  project.provide('appUrl', u.toString());
}

export async function teardown() {
  if (pg) await pg.stop();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

declare module 'vitest' {
  export interface ProvidedContext { adminUrl: string; appUrl: string }
}
