import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { fmtDate, STATUS } from '../format';
import { ErrorBox } from '../ui';

/** Javni portal: token tiketa se drži u # delu URL-a — ne šalje se serveru u logovima ni u Referer zaglavlju. */
export function Portal() {
  const { slug } = useParams();
  const nav = useNavigate();
  const [org, setOrg] = useState('');
  const [f, setF] = useState({ name: '', email: '', subject: '', body: '', website: '' });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { api.get<{ name: string }>(`/public/orgs/${slug}`).then(r => setOrg(r.name)).catch(() => setErr('Organizacija ne postoji')); }, [slug]);
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const payload = f.website ? f : { name: f.name, email: f.email, subject: f.subject, body: f.body };
      const r = await api.post<{ number: number; token: string }>(`/public/orgs/${slug}/tickets`, payload);
      nav(`/s/${slug}/t#${r.token}`);
    } catch (x) { setErr((x as Error).message); }
    setBusy(false);
  }
  return (
    <div className="center"><form className="portal card" onSubmit={submit}>
      <h1>{org || '…'} — podrška</h1>
      <p className="sub">Opišite problem; odgovor stiže na ovoj stranici. Ne šaljite lozinke ni pune brojeve kartica.</p>
      <ErrorBox e={err} />
      <div className="grid2">
        <div><label className="l">Ime</label><input className="in" value={f.name} maxLength={120} onChange={e => setF({ ...f, name: e.target.value })} required /></div>
        <div><label className="l">Email</label><input className="in" type="email" value={f.email} maxLength={254} onChange={e => setF({ ...f, email: e.target.value })} required /></div>
      </div>
      <label className="l">Naslov</label><input className="in" value={f.subject} minLength={3} maxLength={200} onChange={e => setF({ ...f, subject: e.target.value })} required />
      <label className="l">Poruka</label><textarea className="in" value={f.body} minLength={10} maxLength={10000} onChange={e => setF({ ...f, body: e.target.value })} required />
      <div className="hp" aria-hidden="true"><label>Website<input tabIndex={-1} autoComplete="off" value={f.website} onChange={e => setF({ ...f, website: e.target.value })} /></label></div>
      <div className="row composer"><button className="btn pri" disabled={busy}>{busy ? 'Šaljem…' : 'Pošalji'}</button></div>
    </form></div>
  );
}

interface PubTicket { number: number; subject: string; status: string; created_at: string; org: string; messages: { author_type: string; body: string; created_at: string; agent: string | null }[] }

export function PortalTicket() {
  const { slug } = useParams();
  const { hash } = useLocation();
  const token = hash.slice(1);
  const [t, setT] = useState<PubTicket | null>(null);
  const [body, setBody] = useState(''); const [err, setErr] = useState('');
  const load = () => api.get<PubTicket>(`/public/tickets/${encodeURIComponent(token)}`).then(setT).catch(e => setErr(e.message));
  useEffect(() => { if (token) load(); }, [token]);
  async function reply() { try { await api.post(`/public/tickets/${encodeURIComponent(token)}/messages`, { body }); setBody(''); load(); } catch (e) { setErr((e as Error).message); } }
  return (
    <div className="center"><div className="portal">
      <ErrorBox e={err} />
      {t && <div className="card spaced">
        <h1>#{t.number} {t.subject}</h1>
        <p className="sub">{t.org} · status: <b>{STATUS[t.status]}</b></p>
        <div className="okmsg small">Sačuvajte link ove stranice — preko njega pratite odgovor. Link je tajan, ne delite ga.</div>
        <div className="thread">{t.messages.map((m, i) => (
          <article key={i} className={`msg ${m.author_type}`}><div className="meta">{m.author_type === 'agent' ? `${m.agent ?? 'Podrška'} (podrška)` : 'Vi'} · {fmtDate(m.created_at)}</div><div className="body">{m.body}</div></article>))}</div>
        <textarea className="in" value={body} maxLength={10000} onChange={e => setBody(e.target.value)} placeholder="Dodajte odgovor…" aria-label="Odgovor" />
        <div className="row"><button className="btn pri" onClick={reply} disabled={!body.trim()}>Pošalji</button><Link className="right small" to={`/s/${slug}`}>Novi zahtev</Link></div>
      </div>}
    </div></div>
  );
}
