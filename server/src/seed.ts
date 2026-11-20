import pg from 'pg';
import { hashPassword } from './security/password.js';

/** Demo podaci (kao vlasnik šeme, mimo RLS-a). Lozinke su samo za lokalni demo. */
export async function seed(adminUrl: string, opts: { password?: string } = {}) {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    if ((await c.query("SELECT 1 FROM orgs WHERE slug = 'demo'")).rowCount) return;
    const pw = await hashPassword(opts.password ?? 'demo-lozinka-2026');
    const org = (await c.query("INSERT INTO orgs (slug, name) VALUES ('demo', 'Demo Shop d.o.o.') RETURNING id")).rows[0].id;
    const other = (await c.query("INSERT INTO orgs (slug, name) VALUES ('druga-firma', 'Druga firma') RETURNING id")).rows[0].id;
    const users = [
      [org, 'owner@demo.rs', 'Ana Vlasnik', 'owner'],
      [org, 'admin@demo.rs', 'Marko Admin', 'admin'],
      [org, 'agent@demo.rs', 'Jelena Agent', 'agent'],
      [other, 'owner@druga.rs', 'Tuđi Vlasnik', 'owner']
    ];
    for (const [o, e, n, r] of users) await c.query('INSERT INTO users (org_id, email, name, role, password_hash) VALUES ($1,$2,$3,$4,$5)', [o, e, n, r, pw]);
    const kb = [
      ['Kako da resetujem lozinku', 'Na stranici za prijavu kliknite „Zaboravljena lozinka“ i unesite email naloga. Link za reset važi 1 sat. Ako email ne stigne, proverite spam folder.', ['nalog', 'lozinka']],
      ['Rokovi i praćenje dostave', 'Porudžbine šaljemo u roku od 1–2 radna dana. Dostava kurirskom službom traje 1–3 radna dana. Broj za praćenje dobijate emailom kada paket bude predat kuriru.', ['dostava', 'kurir']],
      ['Povraćaj novca i reklamacije', 'Proizvod možete vratiti u roku od 14 dana bez obrazloženja. Novac vraćamo u roku od 14 dana od prijema vraćenog proizvoda, na isti način plaćanja.', ['refund', 'reklamacija', 'naplata']],
      ['Greška 500 pri plaćanju karticom', 'Ako se pri plaćanju prikaže greška 500, sačekajte 5 minuta i pokušajte ponovo. Proverite da li je kartica omogućena za plaćanje na internetu. Ako se greška ponavlja, pošaljite nam vreme pokušaja i poslednje 4 cifre kartice — nikad ceo broj.', ['plaćanje', 'greška', 'kartica']]
    ];
    for (const [t, b, tags] of kb) await c.query('INSERT INTO kb_articles (org_id, title, body, tags) VALUES ($1,$2,$3,$4)', [org, t, b, tags]);
    return { org, other };
  } finally { await c.end(); }
}
