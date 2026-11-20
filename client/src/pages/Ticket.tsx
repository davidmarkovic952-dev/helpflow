import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { TicketDetail, Triage } from '../types';
import { CATEGORY, fmtDate, PRIORITY, rel, STATUS } from '../format';
import { CatTag, ErrorBox, PriorityTag, SlaTag, StatusTag } from '../ui';

export function TicketPage() {
  const { id } = useParams();
  const [t, setT] = useState<TicketDetail | null>(null);
  const [agents, setAgents] = useState<{ id: number; name: string }[]>([]);
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [draftInfo, setDraftInfo] = useState<{ source: string; sources: { id: number; title: string }[] } | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try { setT(await api.get<TicketDetail>(`/tickets/${id}`)); } catch (e) { setErr((e as Error).message); }
  }, [id]);
  useEffect(() => { load(); api.get<{ id: number; name: string }[]>('/tickets/agents').then(setAgents).catch(() => {}); }, [load]);

  async function update(patch: Record<string, unknown>) {
    setErr('');
    try { await api.patch(`/tickets/${id}`, patch); await load(); } catch (e) { setErr((e as Error).message); }
  }
  async function send() {
    if (!body.trim()) return;
    setBusy('send'); setErr('');
    try { await api.post(`/tickets/${id}/messages`, { body, internal }); setBody(''); setDraftInfo(null); await load(); }
    catch (e) { setErr((e as Error).message); }
    setBusy('');
  }
  async function draft() {
    setBusy('draft'); setErr('');
    try {
      const r = await api.post<{ draft: string; source: string; sources: { id: number; title: string }[] }>(`/tickets/${id}/ai/draft`);
      setBody(r.draft); setInternal(false); setDraftInfo(r);
    } catch (e) { setErr((e as Error).message); }
    setBusy('');
  }
  async function retriage() {
    setBusy('triage');
    try { await api.post<Triage>(`/tickets/${id}/ai/triage`); await load(); } catch (e) { setErr((e as Error).message); }
    setBusy('');
  }

  if (!t) return <>{err ? <ErrorBox e={err} /> : <p className="muted">Učitavanje…</p>}</>;
  const tri = t.ai_triage;
  return (
    <>
      <p className="small"><Link to="/">← Svi tiketi</Link></p>
      <h1>#{t.number} {t.subject}</h1>
      <div className="row sub"><StatusTag s={t.status} /><PriorityTag p={t.priority} /><CatTag c={t.category} /><SlaTag s={t.sla.worst} />
        <span className="muted">{t.customer_name} &lt;{t.customer_email}&gt; · {fmtDate(t.created_at)}</span></div>
      <ErrorBox e={err} />
      <div className="detail">
        <section>
          <div className="thread">
            {t.messages.map(m => (
              <article key={m.id} className={`msg ${m.internal ? 'internal' : m.author_type}`}>
                <div className="meta">{m.internal ? '🔒 Interna beleška · ' : ''}{m.author_type === 'customer' ? t.customer_name : m.author_name ?? 'Sistem'} · {fmtDate(m.created_at)}</div>
                <div className="body">{m.body}</div>
              </article>
            ))}
          </div>
          <div className="card composer">
            <textarea className="in" value={body} maxLength={20000} onChange={e => setBody(e.target.value)} placeholder={internal ? 'Interna beleška (kupac je ne vidi)…' : 'Odgovor kupcu…'} aria-label="Poruka" />
            {draftInfo && <p className="small muted">Nacrt: {draftInfo.source === 'llm' ? 'AI' : 'šablon'}{draftInfo.sources.length ? ` · izvori: ${draftInfo.sources.map((s, i) => `[${i + 1}] ${s.title}`).join(', ')}` : ' · nema relevantnih članaka'} — pregledaj pre slanja.</p>}
            <div className="row">
              <label className="row small"><input type="checkbox" checked={internal} onChange={e => setInternal(e.target.checked)} /> Interna beleška</label>
              <button className="btn" onClick={draft} disabled={!!busy}>{busy === 'draft' ? 'Pišem…' : '✦ AI nacrt odgovora'}</button>
              <button className="btn pri right" onClick={send} disabled={!!busy || !body.trim()}>{internal ? 'Sačuvaj belešku' : 'Pošalji odgovor'}</button>
            </div>
          </div>
        </section>
        <aside className="spaced">
          <div className="card panel">
            <h2>Detalji</h2>
            <div className="kv"><span>Status</span>
              <select className="in" value={t.status} onChange={e => update({ status: e.target.value })} aria-label="Status">
                {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <div className="kv"><span>Prioritet</span>
              <select className="in" value={t.priority} onChange={e => update({ priority: e.target.value })} aria-label="Prioritet">
                {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <div className="kv"><span>Kategorija</span>
              <select className="in" value={t.category} onChange={e => update({ category: e.target.value })} aria-label="Kategorija">
                {Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <div className="kv"><span>Dodeljeno</span>
              <select className="in" value={t.assignee_id ?? ''} onChange={e => update({ assigneeId: e.target.value ? Number(e.target.value) : null })} aria-label="Agent">
                <option value="">— niko —</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
          </div>
          <div className="card panel">
            <h2>SLA</h2>
            <div className="kv"><span>Prvi odgovor</span><span><SlaTag s={t.sla.firstResponse.state} /> <span className="small muted">{rel(t.sla.firstResponse.due)}</span></span></div>
            <div className="kv"><span>Rešavanje</span><span><SlaTag s={t.sla.resolution.state} /> <span className="small muted">{rel(t.sla.resolution.due)}</span></span></div>
          </div>
          <div className="card ai">
            <h2>AI trijaža</h2>
            {tri ? <>
              <p className="small">{tri.summary}</p>
              <div className="row"><PriorityTag p={tri.priority} /><CatTag c={tri.category} /><span className="tag">{tri.sentiment}</span><span className="tag">{tri.source === 'llm' ? 'LLM' : 'pravila'}</span></div>
              {tri.reasons.length > 0 && <ul className="reasons">{tri.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
            </> : <p className="small muted">Nema trijaže.</p>}
            <p className="small muted">AI samo predlaže — odluke i slanje su uvek na agentu.</p>
            <button className="btn sm" onClick={retriage} disabled={!!busy}>{busy === 'triage' ? '…' : 'Ponovi trijažu'}</button>
          </div>
        </aside>
      </div>
    </>
  );
}
