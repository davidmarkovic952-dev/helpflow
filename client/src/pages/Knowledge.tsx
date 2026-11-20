import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import type { Article } from '../types';
import { ErrorBox } from '../ui';

const EMPTY = { title: '', body: '', tags: '' };

export function Knowledge() {
  const { me } = useAuth();
  const canEdit = me?.role !== 'agent';
  const [list, setList] = useState<Article[]>([]);
  const [form, setForm] = useState(EMPTY);
  const [editId, setEditId] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const load = () => api.get<Article[]>('/kb').then(setList).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  async function save() {
    setErr('');
    const payload = { title: form.title, body: form.body, tags: form.tags.split(',').map(s => s.trim()).filter(Boolean), published: true };
    try { editId ? await api.put(`/kb/${editId}`, payload) : await api.post('/kb', payload); setForm(EMPTY); setEditId(null); load(); }
    catch (e) { setErr((e as Error).message); }
  }
  async function remove(id: number) { if (confirm('Obrisati članak?')) { await api.del(`/kb/${id}`); load(); } }

  return (
    <>
      <h1>Baza znanja</h1>
      <p className="sub">AI nacrti odgovora koriste isključivo ove članke kao izvor — bez izmišljanja pravila, cena i linkova.</p>
      <ErrorBox e={err} />
      {canEdit && <div className="card" >
        <h2>{editId ? 'Izmena članka' : 'Novi članak'}</h2>
        <label className="l">Naslov</label><input className="in" value={form.title} maxLength={200} onChange={e => setForm({ ...form, title: e.target.value })} />
        <label className="l">Sadržaj</label><textarea className="in" value={form.body} maxLength={50000} onChange={e => setForm({ ...form, body: e.target.value })} />
        <label className="l">Oznake (zarezom)</label><input className="in" value={form.tags} onChange={e => setForm({ ...form, tags: e.target.value })} />
        <div className="row composer"><button className="btn pri" onClick={save}>Sačuvaj</button>{editId && <button className="btn" onClick={() => { setEditId(null); setForm(EMPTY); }}>Odustani</button>}</div>
      </div>}
      <div className="card composer">
        {list.map(a => (
          <div key={a.id} className="kbitem">
            <div className="row"><b>{a.title}</b>{a.tags.map(t => <span key={t} className="tag">{t}</span>)}
              {canEdit && <span className="right row"><button className="btn sm" onClick={() => { setEditId(a.id); setForm({ title: a.title, body: a.body, tags: a.tags.join(', ') }); }}>Izmeni</button><button className="btn sm dan" onClick={() => remove(a.id)}>Obriši</button></span>}</div>
            <p>{a.body}</p>
          </div>
        ))}
        {!list.length && <div className="empty">Nema članaka.</div>}
      </div>
    </>
  );
}
