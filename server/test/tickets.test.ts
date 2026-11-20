import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { login, makeApp, makeOrg, ORIGIN, randomIp } from './helpers.js';
import type { Llm } from '../src/ai/provider.js';

let O: Awaited<ReturnType<typeof makeOrg>>;
beforeAll(async () => { O = await makeOrg('flow'); });

describe('Tok tiketa', () => {
  it('portal → trijaža → odgovor agenta → SLA i status; kupac odgovara → ponovo otvoren', async () => {
    const { app } = makeApp();
    const created = await request(app).post(`/api/public/orgs/${O.slug}/tickets`).set('X-Forwarded-For', randomIp())
      .send({ name: 'Petar Petrović', email: 'petar@mail.rs', subject: 'HITNO: plaćanje ne radi', body: 'Ne mogu da platim, dobijam grešku 500 već treći put. Ceo tim ne može da radi.' });
    expect(created.status).toBe(201);

    const { agent, csrf } = await login(app, O.agent.email);
    const h = { Origin: ORIGIN, 'X-CSRF-Token': csrf };
    const t = (await agent.get('/api/tickets?status=active')).body.find((x: { number: number }) => x.number === created.body.number);
    expect(t).toMatchObject({ priority: 'urgent', status: 'new' });
    expect(t.sla.firstResponse.state).toBe('ok');

    expect((await agent.patch(`/api/tickets/${t.id}`).set(h).send({ assigneeId: O.agent.id, status: 'open' })).status).toBe(200);
    const reply = await agent.post(`/api/tickets/${t.id}/messages`).set(h).send({ body: 'Pogledali smo, problem je rešen.' });
    expect(reply.status).toBe(201);
    const d = (await agent.get(`/api/tickets/${t.id}`)).body;
    expect(d.status).toBe('pending');
    expect(d.sla.firstResponse.state).toBe('met');
    expect(d.public_token_hash).toBeUndefined();

    expect((await agent.patch(`/api/tickets/${t.id}`).set(h).send({ status: 'closed' })).status).toBe(200);
    expect((await agent.patch(`/api/tickets/${t.id}`).set(h).send({ status: 'new' })).status).toBe(409);

    await request(app).post(`/api/public/tickets/${created.body.token}/messages`).set('X-Forwarded-For', randomIp()).send({ body: 'Opet se dešava!' });
    expect((await agent.get(`/api/tickets/${t.id}`)).body.status).toBe('open');
  });

  it('AI: neispravan izlaz modela → rezervna pravila; nacrt sa izvorima iz baze znanja, bez stranih linkova', async () => {
    const calls: string[] = [];
    const evil: Llm = async ({ system, user }) => {
      calls.push(user);
      if (system.includes('triage classifier')) return '{"category":"technical","priority":"SUPER_URGENT"}';
      return 'Poštovani, novac vraćamo u roku od 14 dana [1]. Prijavite se ovde: https://phishing.example/login';
    };
    const { app } = makeApp({}, evil);
    const { agent, csrf } = await login(app, O.admin.email);
    const h = { Origin: ORIGIN, 'X-CSRF-Token': csrf };
    await agent.post('/api/kb').set(h).send({ title: 'Povraćaj novca', body: 'Novac vraćamo u roku od 14 dana od prijema proizvoda.', tags: ['refund'] });
    const c = await request(app).post(`/api/public/orgs/${O.slug}/tickets`).set('X-Forwarded-For', randomIp())
      .send({ name: 'Mila', email: 'mila@mail.rs', subject: 'Povraćaj novca', body: 'Kada ću dobiti povraćaj novca? Moj telefon je 0641112223.' });
    const id = (await agent.get('/api/tickets')).body.find((x: { number: number }) => x.number === c.body.number).id;
    const tri = (await agent.get(`/api/tickets/${id}`)).body.ai_triage;
    expect(tri.source).toBe('rules');
    expect(tri.reasons).toContain('AI nije dostupan — korišćena pravila');
    const draft = (await agent.post(`/api/tickets/${id}/ai/draft`).set(h)).body;
    expect(draft.source).toBe('llm');
    expect(draft.sources[0].title).toBe('Povraćaj novca');
    expect(draft.draft).not.toContain('phishing.example');
    expect(calls.join('\n')).not.toContain('0641112223');
  });

  it('agent ne može da menja bazu znanja, admin može', async () => {
    const { app } = makeApp();
    const ag = await login(app, O.agent.email);
    expect((await ag.agent.post('/api/kb').set({ Origin: ORIGIN, 'X-CSRF-Token': ag.csrf }).send({ title: 'Test', body: 'x' })).status).toBe(403);
  });

  it('pozivnica: link radi jednom, slaba lozinka odbijena, posle toga prijava radi', async () => {
    const { app } = makeApp();
    const ad = await login(app, O.admin.email);
    const inv = await ad.agent.post('/api/admin/users').set({ Origin: ORIGIN, 'X-CSRF-Token': ad.csrf }).send({ email: `novi-${O.slug}@test.rs`, name: 'Novi Agent', role: 'agent' });
    expect(inv.status).toBe(201);
    const token = inv.body.inviteLink.split('/').pop();
    const ip = randomIp();
    expect((await request(app).post(`/api/auth/invite/${token}`).set('X-Forwarded-For', ip).send({ password: 'kratka' })).status).toBe(400);
    expect((await request(app).post(`/api/auth/invite/${token}`).set('X-Forwarded-For', ip).send({ password: 'dugacka-sigurna-fraza-9' })).status).toBe(200);
    expect((await request(app).post(`/api/auth/invite/${token}`).set('X-Forwarded-For', ip).send({ password: 'jos-jedna-fraza-1234' })).status).toBe(400);
    expect((await login(app, `novi-${O.slug}@test.rs`, 'dugacka-sigurna-fraza-9')).res.status).toBe(200);
  });

  it('promena lozinke odjavljuje ostale uređaje', async () => {
    const X = await makeOrg('pw');
    const { app } = makeApp();
    const other = await login(app, X.agent.email);
    const me = await login(app, X.agent.email);
    const r = await me.agent.post('/api/auth/password').set({ Origin: ORIGIN, 'X-CSRF-Token': me.csrf }).send({ current: 'Tacna-lozinka-2026!', next: 'nova-duga-fraza-za-test' });
    expect(r.status).toBe(200);
    expect((await other.agent.get('/api/auth/me')).status).toBe(401);
    expect((await me.agent.get('/api/auth/me')).status).toBe(200);
  });
});
