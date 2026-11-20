import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { authenticator } from 'otplib';
import { admin, login, makeApp, makeOrg, ORIGIN, PW, randomIp } from './helpers.js';
import { withOrg } from '../src/db/pool.js';
import { verifyChain } from '../src/security/audit.js';

const { app, db } = makeApp();
let A: Awaited<ReturnType<typeof makeOrg>>, B: Awaited<ReturnType<typeof makeOrg>>;

async function createTicket(slug: string, subject = 'Ne radi plaćanje') {
  const r = await request(app).post(`/api/public/orgs/${slug}/tickets`).set('X-Forwarded-For', randomIp()).send({ name: 'Kupac Test', email: `kupac${Math.random()}@mail.rs`, subject, body: 'Pokušavam da platim karticom i dobijam grešku 500.' });
  expect(r.status).toBe(201);
  return r.body as { number: number; token: string };
}

beforeAll(async () => { A = await makeOrg('a'); B = await makeOrg('b'); });

describe('Autentikacija', () => {
  it('lozinke su argon2id heševi', async () => {
    const c = await admin();
    const h = (await c.query('SELECT password_hash FROM users WHERE id = $1', [A.agent.id])).rows[0].password_hash;
    await c.end();
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('ista poruka za nepostojeći nalog i pogrešnu lozinku (nema otkrivanja naloga)', async () => {
    const a = await request(app).post('/api/auth/login').set('X-Forwarded-For', randomIp()).send({ email: 'nema@nikoga.rs', password: 'x'.repeat(12) });
    const b = await request(app).post('/api/auth/login').set('X-Forwarded-For', randomIp()).send({ email: A.owner.email, password: 'pogresna-lozinka' });
    expect(a.status).toBe(401); expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
  });

  it('kolačić sesije: HttpOnly, SameSite=Strict; u bazi samo heš tokena', async () => {
    const { res } = await login(app, A.agent.email);
    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toMatch(/HttpOnly/); expect(cookie).toMatch(/SameSite=Strict/);
    const token = cookie.split(';')[0].split('=')[1];
    const c = await admin();
    const raw = await c.query('SELECT count(*)::int AS n FROM sessions WHERE token_hash = $1', [token]);
    await c.end();
    expect(raw.rows[0].n).toBe(0); // sirovi token ne postoji u bazi
  });

  it('Secure + __Host- prefiks u produkcionom režimu', async () => {
    const prod = makeApp({ COOKIE_SECURE: 'true' });
    const r = await request(prod.app).post('/api/auth/login').send({ email: A.admin.email, password: PW });
    expect(r.headers['set-cookie'][0]).toMatch(/^__Host-hf_sid=.*; Secure/);
  });

  it('zaključavanje naloga posle 5 neuspeha — ni tačna lozinka ne prolazi dok traje', async () => {
    const O = await makeOrg('lock');
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/login').set('X-Forwarded-For', randomIp()).send({ email: O.agent.email, password: 'pogresna-lozinka' });
    const r = await request(app).post('/api/auth/login').set('X-Forwarded-For', randomIp()).send({ email: O.agent.email, password: PW });
    expect(r.status).toBe(401);
    const c = await admin();
    const u = (await c.query('SELECT failed_logins, locked_until FROM users WHERE id = $1', [O.agent.id])).rows[0];
    await c.end();
    expect(u.failed_logins).toBe(5);
    expect(new Date(u.locked_until).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
  });

  it('rate limit po nalogu (429) i pri promeni IP adrese', async () => {
    const O = await makeOrg('rl');
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await request(app).post('/api/auth/login').set('X-Forwarded-For', `10.0.0.${i}`).send({ email: O.owner.email, password: 'pogresna-lozinka' })).status);
    expect(codes).toContain(429);
  });

  it('odjava poništava sesiju na serveru (stari kolačić više ne radi)', async () => {
    const { agent, csrf } = await login(app, A.agent.email);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    await agent.post('/api/auth/logout').set('Origin', ORIGIN).set('X-CSRF-Token', csrf);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('istek zbog neaktivnosti', async () => {
    const { agent } = await login(app, A.admin.email);
    const c = await admin();
    await c.query(`UPDATE sessions SET last_seen_at = now() - interval '2 hours' WHERE user_id = $1`, [A.admin.id]);
    await c.end();
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('nova prijava daje novi token (nema session fixation)', async () => {
    const r1 = await login(app, A.agent.email), r2 = await login(app, A.agent.email);
    expect(r1.res.headers['set-cookie'][0]).not.toEqual(r2.res.headers['set-cookie'][0]);
  });
});

describe('CSRF', () => {
  it('izmena bez CSRF tokena → 403; sa tokenom → prolazi', async () => {
    const { agent, csrf } = await login(app, A.agent.email);
    const t = await createTicket(A.slug);
    const list = await agent.get('/api/tickets');
    const id = list.body.find((x: { number: number }) => x.number === t.number).id;
    expect((await agent.patch(`/api/tickets/${id}`).set('Origin', ORIGIN).send({ status: 'open' })).status).toBe(403);
    expect((await agent.patch(`/api/tickets/${id}`).set('Origin', ORIGIN).set('X-CSRF-Token', 'lazni-token').send({ status: 'open' })).status).toBe(403);
    expect((await agent.patch(`/api/tickets/${id}`).set('Origin', ORIGIN).set('X-CSRF-Token', csrf).send({ status: 'open' })).status).toBe(200);
  });
  it('zahtev sa tuđeg sajta (Origin) se odbija i sa ispravnim tokenom', async () => {
    const { agent, csrf } = await login(app, A.agent.email);
    const r = await agent.post('/api/auth/logout-all').set('Origin', 'https://zli-sajt.com').set('X-CSRF-Token', csrf);
    expect(r.status).toBe(403);
  });
});

describe('Izolacija organizacija (IDOR + RLS)', () => {
  it('agent firme A dobija 404 za tiket firme B (čitanje i izmena)', async () => {
    const tb = await createTicket(B.slug);
    const { agent: bAgent } = await login(app, B.agent.email);
    const idB = (await bAgent.get('/api/tickets')).body.find((x: { number: number }) => x.number === tb.number).id;
    const { agent, csrf } = await login(app, A.agent.email);
    expect((await agent.get(`/api/tickets/${idB}`)).status).toBe(404);
    expect((await agent.patch(`/api/tickets/${idB}`).set('Origin', ORIGIN).set('X-CSRF-Token', csrf).send({ status: 'closed' })).status).toBe(404);
    expect((await agent.post(`/api/tickets/${idB}/messages`).set('Origin', ORIGIN).set('X-CSRF-Token', csrf).send({ body: 'upad' })).status).toBe(404);
    expect((await agent.get('/api/tickets')).body.some((x: { id: number }) => x.id === idB)).toBe(false);
  });

  it('RLS u bazi: i upit BEZ WHERE org_id vidi samo svoju organizaciju', async () => {
    await createTicket(A.slug); await createTicket(B.slug);
    const rows = await withOrg(db, A.id, tx => tx.query('SELECT DISTINCT org_id FROM tickets'));
    expect(rows.rows.map(r => r.org_id)).toEqual([A.id]);
    const users = await withOrg(db, A.id, tx => tx.query('SELECT org_id FROM users'));
    expect(new Set(users.rows.map(r => r.org_id))).toEqual(new Set([A.id]));
  });

  it('RLS: upis reda u tuđu organizaciju je odbijen od strane baze', async () => {
    await expect(withOrg(db, A.id, tx => tx.query(`INSERT INTO kb_articles (org_id, title, body) VALUES ($1, 'podmetnut', 'x')`, [B.id]))).rejects.toThrow(/row-level security/);
  });

  it('aplikaciona uloga bez organizacije ne vidi ništa', async () => {
    const r = await db.query('SELECT count(*)::int AS n FROM tickets');
    expect(r.rows[0].n).toBe(0);
  });

  it('dodela tiketa agentu iz druge firme je odbijena', async () => {
    const t = await createTicket(A.slug);
    const { agent, csrf } = await login(app, A.admin.email);
    const id = (await agent.get('/api/tickets')).body.find((x: { number: number }) => x.number === t.number).id;
    const r = await agent.patch(`/api/tickets/${id}`).set('Origin', ORIGIN).set('X-CSRF-Token', csrf).send({ assigneeId: B.agent.id });
    expect(r.status).toBe(400);
  });
});

describe('Uloge (RBAC)', () => {
  it('agent nema pristup admin API-ju; admin ima', async () => {
    const ag = await login(app, A.agent.email);
    expect((await ag.agent.get('/api/admin/users')).status).toBe(403);
    const ad = await login(app, A.admin.email);
    expect((await ad.agent.get('/api/admin/users')).status).toBe(200);
  });
  it('admin ne može da napravi vlasnika ni da menja druge admine; poslednji vlasnik ne može biti uklonjen', async () => {
    const ad = await login(app, A.admin.email);
    const h = { Origin: ORIGIN, 'X-CSRF-Token': ad.csrf };
    expect((await ad.agent.patch(`/api/admin/users/${A.agent.id}`).set(h).send({ role: 'owner' })).status).toBe(403);
    const ow = await login(app, A.owner.email);
    const self = await ow.agent.patch(`/api/admin/users/${A.owner.id}`).set({ Origin: ORIGIN, 'X-CSRF-Token': ow.csrf }).send({ role: 'agent' });
    expect(self.status).toBe(400);
  });
  it('deaktiviran korisnik odmah gubi sve sesije', async () => {
    const O = await makeOrg('deact');
    const victim = await login(app, O.agent.email);
    const ow = await login(app, O.owner.email);
    await ow.agent.patch(`/api/admin/users/${O.agent.id}`).set({ Origin: ORIGIN, 'X-CSRF-Token': ow.csrf }).send({ active: false });
    expect((await victim.agent.get('/api/tickets')).status).toBe(401);
  });
  it('nepoznata polja u zahtevu se odbijaju (mass assignment)', async () => {
    const t = await createTicket(A.slug);
    const { agent, csrf } = await login(app, A.agent.email);
    const id = (await agent.get('/api/tickets')).body.find((x: { number: number }) => x.number === t.number).id;
    const r = await agent.patch(`/api/tickets/${id}`).set({ Origin: ORIGIN, 'X-CSRF-Token': csrf }).send({ status: 'open', org_id: B.id });
    expect(r.status).toBe(400);
  });
});

describe('Dvofaktorska autentikacija (TOTP)', () => {
  it('uključivanje, prijava traži kod, jednokratni kod za oporavak', async () => {
    const O = await makeOrg('mfa');
    const s = await login(app, O.admin.email);
    const h = { Origin: ORIGIN, 'X-CSRF-Token': s.csrf };
    const setup = await s.agent.post('/api/auth/totp/setup').set(h);
    expect(setup.body.uri).toMatch(/^otpauth:\/\/totp\//);
    expect((await s.agent.post('/api/auth/totp/enable').set(h).send({ code: '000000' })).status).toBe(400);
    const en = await s.agent.post('/api/auth/totp/enable').set(h).send({ code: authenticator.generate(setup.body.secret) });
    expect(en.body.recoveryCodes).toHaveLength(10);

    const c = await admin();
    const stored = (await c.query('SELECT totp_secret_enc FROM users WHERE id = $1', [O.admin.id])).rows[0].totp_secret_enc;
    await c.end();
    expect(stored).toMatch(/^v1\./); expect(stored).not.toContain(setup.body.secret); // šifrovano u bazi

    const l = await login(app, O.admin.email);
    expect(l.res.body.mfaRequired).toBe(true);
    expect((await l.agent.get('/api/tickets')).status).toBe(401); // bez drugog faktora nema pristupa
    const mh = { Origin: ORIGIN, 'X-CSRF-Token': l.csrf };
    expect((await l.agent.post('/api/auth/mfa').set(mh).send({ code: '123456' })).status).toBe(401);
    expect((await l.agent.post('/api/auth/mfa').set(mh).send({ code: en.body.recoveryCodes[0] })).status).toBe(200);
    expect((await l.agent.get('/api/tickets')).status).toBe(200);

    const l2 = await login(app, O.admin.email);
    expect((await l2.agent.post('/api/auth/mfa').set({ Origin: ORIGIN, 'X-CSRF-Token': l2.csrf }).send({ code: en.body.recoveryCodes[0] })).status).toBe(401); // već iskorišćen
  });
});

describe('Revizijska sled (lanac heševa)', () => {
  it('lanac je ispravan; izmena i brisanje su blokirani u bazi', async () => {
    const O = await makeOrg('audit');
    for (let i = 0; i < 3; i++) await login(app, O.agent.email);
    const v = await withOrg(db, O.id, tx => verifyChain(tx, O.id));
    expect(v.ok).toBe(true); expect(v.entries).toBeGreaterThanOrEqual(3);
    const c = await admin();
    await expect(c.query(`UPDATE audit_log SET action = 'x' WHERE org_id = $1`, [O.id])).rejects.toThrow(/append-only/);
    await expect(c.query(`DELETE FROM audit_log WHERE org_id = $1`, [O.id])).rejects.toThrow(/append-only/);
    // Čak i ako napadač sa pristupom bazi isključi trigger i promeni zapis — provera to otkriva.
    await c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_no_update');
    const target = (await c.query('SELECT min(id) AS id FROM audit_log WHERE org_id = $1', [O.id])).rows[0].id;
    await c.query(`UPDATE audit_log SET metadata = '{"failed":0}' WHERE id = $1`, [target]);
    await c.query('ALTER TABLE audit_log ENABLE TRIGGER audit_no_update');
    await c.end();
    const v2 = await withOrg(db, O.id, tx => verifyChain(tx, O.id));
    expect(v2).toMatchObject({ ok: false, brokenAt: Number(target) });
  });
});

describe('HTTP bezbednost', () => {
  it('strogi CSP i ostala zaglavlja', async () => {
    const r = await request(app).get('/api/health');
    const csp = r.headers['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['strict-transport-security']).toMatch(/max-age=63072000/);
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['cache-control']).toBe('no-store');
  });
  it('prevelik zahtev → 413, neispravan JSON → 400 bez stack trace-a', async () => {
    const big = await request(app).post('/api/auth/login').set('content-type', 'application/json').send('{"email":"' + 'a'.repeat(70_000) + '"}');
    expect(big.status).toBe(413);
    const bad = await request(app).post('/api/auth/login').set('content-type', 'application/json').send('{bad');
    expect(bad.status).toBe(400); expect(JSON.stringify(bad.body)).not.toMatch(/at |stack/);
  });
  it('SQL injection u pretrazi nema efekta', async () => {
    const { agent } = await login(app, A.agent.email);
    const r = await agent.get('/api/tickets').query({ q: "' OR 1=1; DROP TABLE tickets; --" });
    expect(r.status).toBe(200); expect(r.body).toEqual([]);
    expect((await agent.get('/api/tickets')).status).toBe(200);
  });
});

describe('Javni portal', () => {
  it('kupac vidi svoj tiket preko tokena, ali ne i interne beleške', async () => {
    const t = await createTicket(A.slug);
    const { agent, csrf } = await login(app, A.agent.email);
    const id = (await agent.get('/api/tickets')).body.find((x: { number: number }) => x.number === t.number).id;
    const h = { Origin: ORIGIN, 'X-CSRF-Token': csrf };
    await agent.post(`/api/tickets/${id}/messages`).set(h).send({ body: 'TAJNO: kupac je problematičan', internal: true });
    await agent.post(`/api/tickets/${id}/messages`).set(h).send({ body: 'Pogledaćemo i javljamo se.' });
    const pub = await request(app).get(`/api/public/tickets/${t.token}`);
    expect(pub.status).toBe(200);
    expect(JSON.stringify(pub.body)).not.toContain('TAJNO');
    expect(pub.body.messages.map((m: { author_type: string }) => m.author_type)).toEqual(['customer', 'agent']);
    expect(pub.body.id).toBeUndefined();
    expect((await request(app).get('/api/public/tickets/pogresan-token')).status).toBe(404);
  });
  it('honeypot polje odbija botove', async () => {
    const r = await request(app).post(`/api/public/orgs/${A.slug}/tickets`).set('X-Forwarded-For', randomIp()).send({ name: 'Bot', email: 'b@b.rs', subject: 'Spam poruka', body: 'Kupite jeftine stvari ovde odmah', website: 'http://spam' });
    expect(r.status).toBe(400);
  });
});
