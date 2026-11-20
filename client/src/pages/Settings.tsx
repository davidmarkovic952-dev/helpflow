import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../api';
import { useAuth } from '../auth';
import { fmtDate } from '../format';
import { ErrorBox } from '../ui';

interface Sess { id: number; ip: string | null; user_agent: string | null; created_at: string; last_seen_at: string; current: boolean }

export function Settings() {
  const { me, refresh } = useAuth();
  const [qr, setQr] = useState(''); const [secret, setSecret] = useState(''); const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [dis, setDis] = useState({ password: '', code: '' });
  const [sessions, setSessions] = useState<Sess[]>([]);
  const [msg, setMsg] = useState(''); const [err, setErr] = useState('');
  const loadS = () => api.get<Sess[]>('/auth/sessions').then(setSessions).catch(() => {});
  useEffect(() => { loadS(); }, []);
  const run = (fn: () => Promise<void>) => async () => { setErr(''); setMsg(''); try { await fn(); } catch (e) { setErr((e as Error).message); } };

  return (
    <>
      <h1>Bezbednost naloga</h1>
      <p className="sub">{me?.email}</p>
      <ErrorBox e={err} />{msg && <div className="okmsg">{msg}</div>}
      <div className="detail">
        <div className="spaced">
          <div className="card">
            <h2>Dvofaktorska autentikacija (TOTP)</h2>
            {me?.totpEnabled ? <>
              <p className="ok">✓ Uključena. Pri prijavi se traži kod iz aplikacije.</p>
              {codes.length > 0 && <><p><b>Kodovi za oporavak</b> — sačuvaj ih sada, neće biti ponovo prikazani. Svaki važi jednom.</p><div className="codes">{codes.map(c => <code key={c}>{c}</code>)}</div></>}
              <div className="grid2"><div><label className="l">Lozinka</label><input className="in" type="password" value={dis.password} onChange={e => setDis({ ...dis, password: e.target.value })} /></div>
                <div><label className="l">Kod</label><input className="in" value={dis.code} onChange={e => setDis({ ...dis, code: e.target.value })} /></div></div>
              <div className="row composer"><button className="btn dan" onClick={run(async () => { await api.post('/auth/totp/disable', dis); setCodes([]); await refresh(); setMsg('2FA je isključena.'); })}>Isključi 2FA</button></div>
            </> : !secret ? <>
              <p className="small muted">Google Authenticator, 1Password, Authy… Štiti nalog i ako lozinka procuri.</p>
              <button className="btn pri" onClick={run(async () => { const r = await api.post<{ secret: string; uri: string }>('/auth/totp/setup'); setSecret(r.secret); setQr(await QRCode.toDataURL(r.uri, { margin: 1, width: 180 })); })}>Podesi 2FA</button>
            </> : <>
              <p className="small">Skeniraj QR kod ili unesi ključ ručno, pa potvrdi kodom.</p>
              <img className="qr" src={qr} alt="QR kod za 2FA" />
              <p className="mono">{secret}</p>
              <label className="l">Kod iz aplikacije</label><input className="in" value={code} inputMode="numeric" maxLength={6} onChange={e => setCode(e.target.value)} />
              <div className="row composer"><button className="btn pri" onClick={run(async () => { const r = await api.post<{ recoveryCodes: string[] }>('/auth/totp/enable', { code }); setCodes(r.recoveryCodes); setSecret(''); await refresh(); loadS(); })}>Uključi</button></div>
            </>}
          </div>
          <div className="card">
            <h2>Promena lozinke</h2>
            <p className="small muted">Najmanje 12 znakova; dugačka fraza je bolja od komplikovane kratke lozinke. Ostali uređaji se odjavljuju.</p>
            <label className="l">Trenutna</label><input className="in" type="password" autoComplete="current-password" value={pw.current} onChange={e => setPw({ ...pw, current: e.target.value })} />
            <label className="l">Nova</label><input className="in" type="password" autoComplete="new-password" value={pw.next} onChange={e => setPw({ ...pw, next: e.target.value })} />
            <div className="row composer"><button className="btn pri" onClick={run(async () => { await api.post('/auth/password', pw); setPw({ current: '', next: '' }); setMsg('Lozinka je promenjena; ostale sesije su odjavljene.'); loadS(); })}>Promeni</button></div>
          </div>
        </div>
        <div className="card">
          <h2>Aktivne sesije</h2>
          {sessions.map(s => (
            <div key={s.id} className="kbitem small">
              <b>{s.current ? 'Ovaj uređaj' : (s.user_agent || 'Nepoznat uređaj').slice(0, 60)}</b>
              <div className="muted">IP {s.ip ?? '?'} · prijava {fmtDate(s.created_at)} · aktivnost {fmtDate(s.last_seen_at)}</div>
              {!s.current && <button className="btn sm dan" onClick={run(async () => { await api.del(`/auth/sessions/${s.id}`); loadS(); })}>Odjavi</button>}
            </div>))}
          <div className="row composer"><button className="btn" onClick={run(async () => { await api.post('/auth/logout-all'); loadS(); setMsg('Svi ostali uređaji su odjavljeni.'); })}>Odjavi sve ostale uređaje</button></div>
        </div>
      </div>
    </>
  );
}
