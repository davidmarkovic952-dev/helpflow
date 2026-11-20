import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import type { User } from '../types';
import { fmtDate, ROLE } from '../format';
import { ErrorBox } from '../ui';

interface AuditRow { id: number; action: string; target_type: string | null; target_id: string | null; ip: string | null; metadata: Record<string, unknown>; created_at: string; hash: string; actor_name: string | null }

export function Admin() {
  const { me } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [verify, setVerify] = useState<{ ok: boolean; entries: number; brokenAt?: number } | null>(null);
  const [inv, setInv] = useState({ email: '', name: '', role: 'agent' });
  const [link, setLink] = useState('');
  const [err, setErr] = useState('');
  const load = () => Promise.all([api.get<User[]>('/admin/users'), api.get<AuditRow[]>('/admin/audit')]).then(([u, a]) => { setUsers(u); setAudit(a); }).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  const act = (fn: () => Promise<unknown>) => async () => { setErr(''); try { await fn(); await load(); } catch (e) { setErr((e as Error).message); } };
  const invite = act(async () => {
    const r = await api.post<{ inviteLink: string }>('/admin/users', inv);
    setLink(`${location.origin}${r.inviteLink}`); setInv({ email: '', name: '', role: 'agent' });
  });

  return (
    <>
      <h1>Administracija</h1>
      <p className="sub">Korisnici, uloge i revizijska sled sa proverom integriteta.</p>
      <ErrorBox e={err} />
      <div className="card">
        <h2>Pozovi člana tima</h2>
        <div className="grid2">
          <div><label className="l">Ime</label><input className="in" value={inv.name} onChange={e => setInv({ ...inv, name: e.target.value })} /></div>
          <div><label className="l">Email</label><input className="in" type="email" value={inv.email} onChange={e => setInv({ ...inv, email: e.target.value })} /></div>
        </div>
        <div className="row composer">
          <select className="in auto" value={inv.role} onChange={e => setInv({ ...inv, role: e.target.value })} aria-label="Uloga"><option value="agent">Agent</option><option value="admin">Administrator</option></select>
          <button className="btn pri" onClick={invite}>Napravi pozivnicu</button>
        </div>
        {link && <div className="okmsg">Link za postavljanje lozinke (važi 48 h, prikazuje se samo sada):<br /><span className="mono">{link}</span></div>}
      </div>
      <h2 className="composer">Korisnici</h2>
      <table>
        <thead><tr><th>Ime</th><th>Uloga</th><th>2FA</th><th>Status</th><th></th></tr></thead>
        <tbody>{users.map(u => (
          <tr key={u.id}>
            <td><b>{u.name}</b><div className="small muted">{u.email}</div></td>
            <td>{u.id === me?.id ? ROLE[u.role] :
              <select className="in" value={u.role} onChange={e => act(() => api.patch(`/admin/users/${u.id}`, { role: e.target.value }))()} aria-label="Uloga">
                {Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</td>
            <td>{u.totp_enabled ? <span className="ok">✓ uključen</span> : <span className="bad">isključen</span>}</td>
            <td className="small">{u.invite_pending ? 'čeka prihvatanje' : !u.active ? <span className="bad">deaktiviran</span> : u.locked_until && new Date(u.locked_until) > new Date() ? <span className="bad">zaključan</span> : 'aktivan'}</td>
            <td><div className="row">{u.id !== me?.id && <>
              {u.locked_until && new Date(u.locked_until) > new Date() && <button className="btn sm" onClick={act(() => api.post(`/admin/users/${u.id}/unlock`))}>Otključaj</button>}
              <button className="btn sm dan" onClick={act(() => api.patch(`/admin/users/${u.id}`, { active: !u.active }))}>{u.active ? 'Deaktiviraj' : 'Aktiviraj'}</button></>}</div></td>
          </tr>))}</tbody>
      </table>
      <div className="row composer"><h2>Revizijska sled</h2>
        <button className="btn sm right" onClick={act(async () => setVerify(await api.get('/admin/audit/verify')))}>Proveri integritet lanca</button></div>
      {verify && (verify.ok
        ? <div className="okmsg">✓ Lanac je netaknut — {verify.entries} zapisa, svaki heš odgovara prethodnom.</div>
        : <div className="err">✗ Lanac je narušen kod zapisa #{verify.brokenAt}: neko je menjao podatke mimo aplikacije.</div>)}
      <table>
        <thead><tr><th>Vreme</th><th>Ko</th><th>Akcija</th><th>Objekat</th><th>IP</th><th>Heš</th></tr></thead>
        <tbody>{audit.map(a => (
          <tr key={a.id}><td className="small">{fmtDate(a.created_at)}</td><td className="small">{a.actor_name ?? 'sistem/kupac'}</td>
            <td><span className="tag">{a.action}</span></td><td className="small">{a.target_type ? `${a.target_type} #${a.target_id}` : '—'}</td>
            <td className="mono">{a.ip ?? ''}</td><td className="mono muted">{a.hash.slice(0, 10)}…</td></tr>))}</tbody>
      </table>
    </>
  );
}
