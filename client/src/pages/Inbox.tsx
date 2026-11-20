import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { TicketRow } from '../types';
import { fmtDate } from '../format';
import { CatTag, ErrorBox, PriorityTag, SlaTag, StatusTag } from '../ui';

const VIEWS = [['active', 'Aktivni'], ['me', 'Moji'], ['none', 'Nedodeljeni'], ['resolved', 'Rešeni'], ['closed', 'Zatvoreni']] as const;

export function Inbox() {
  const nav = useNavigate();
  const [view, setView] = useState<string>('active');
  const [priority, setPriority] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [stats, setStats] = useState({ open: 0, unassigned: 0, mine: 0, atRisk: 0, breached: 0 });
  const [err, setErr] = useState('');

  useEffect(() => {
    const p = new URLSearchParams();
    if (view === 'me' || view === 'none') { p.set('assignee', view); p.set('status', 'active'); } else p.set('status', view);
    if (priority) p.set('priority', priority);
    if (q.trim()) p.set('q', q.trim());
    const t = setTimeout(() => {
      Promise.all([api.get<TicketRow[]>(`/tickets?${p}`), api.get<typeof stats>('/tickets/stats')])
        .then(([r, s]) => { setRows(r); setStats(s); setErr(''); }).catch(e => setErr(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [view, priority, q]);

  return (
    <>
      <h1>Tiketi</h1>
      <p className="sub">Prioritet i kategoriju predlaže AI trijaža; SLA rokovi se računaju automatski.</p>
      <div className="stats">
        <div className="stat"><b>{stats.open}</b><span>aktivnih</span></div>
        <div className="stat"><b>{stats.unassigned}</b><span>nedodeljenih</span></div>
        <div className="stat"><b>{stats.mine}</b><span>mojih</span></div>
        <div className="stat warn"><b>{stats.atRisk}</b><span>SLA uskoro ističe</span></div>
        <div className="stat bad"><b>{stats.breached}</b><span>SLA probijen</span></div>
      </div>
      <div className="filters">
        {VIEWS.map(([k, l]) => <button key={k} className={`chip${view === k ? ' on' : ''}`} onClick={() => setView(k)}>{l}</button>)}
        <select className="in" value={priority} onChange={e => setPriority(e.target.value)} aria-label="Prioritet">
          <option value="">Svi prioriteti</option><option value="urgent">Hitno</option><option value="high">Visok</option><option value="normal">Normalan</option><option value="low">Nizak</option>
        </select>
        <input className="in grow" placeholder="Pretraga: naslov, kupac, email…" value={q} maxLength={100} onChange={e => setQ(e.target.value)} />
      </div>
      <ErrorBox e={err} />
      <table>
        <thead><tr><th>#</th><th>Naslov</th><th>Prioritet</th><th>Status</th><th>SLA</th><th>Dodeljeno</th><th>Kreiran</th></tr></thead>
        <tbody>
          {rows.map(t => (
            <tr key={t.id} className="click" onClick={() => nav(`/tickets/${t.id}`)}>
              <td className="mono">{t.number}</td>
              <td><b>{t.subject}</b><div className="small muted">{t.customer_name} · <CatTag c={t.category} /></div></td>
              <td><PriorityTag p={t.priority} /></td>
              <td><StatusTag s={t.status} /></td>
              <td><SlaTag s={t.sla.worst} /></td>
              <td className="small">{t.assignee_name ?? <span className="muted">—</span>}</td>
              <td className="small muted">{fmtDate(t.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="empty">Nema tiketa za izabrani prikaz.</div>}
    </>
  );
}
