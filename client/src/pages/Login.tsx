import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { api, setCsrf } from '../api';
import { useAuth } from '../auth';
import { ErrorBox } from '../ui';

export function Login() {
  const { me, mfaRequired, refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (me && !mfaRequired) return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      if (mfaRequired) await api.post('/auth/mfa', { code });
      else { const r = await api.post<{ csrfToken: string }>('/auth/login', { email, password }); setCsrf(r.csrfToken); }
      await refresh();
    } catch (x) { setErr((x as Error).message); }
    setBusy(false);
  }

  return (
    <div className="center">
      <form className="card authbox" onSubmit={submit}>
        <div className="brand">Help<span>Flow</span></div>
        {mfaRequired ? <>
          <h1>Dvofaktorska provera</h1>
          <p className="sub">Unesi 6-cifreni kod iz aplikacije za autentifikaciju, ili jedan od kodova za oporavak.</p>
          <ErrorBox e={err} />
          <label className="l" htmlFor="code">Kod</label>
          <input id="code" className="in" autoComplete="one-time-code" inputMode="text" value={code} onChange={e => setCode(e.target.value)} autoFocus required />
        </> : <>
          <h1>Prijava</h1>
          <p className="sub">Sistem za korisničku podršku sa AI trijažom.</p>
          <ErrorBox e={err} />
          <label className="l" htmlFor="email">Email</label>
          <input id="email" className="in" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required />
          <label className="l" htmlFor="pw">Lozinka</label>
          <input id="pw" className="in" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />
        </>}
        <div className="row composer"><button className="btn pri grow" disabled={busy}>{busy ? 'Proveravam…' : 'Nastavi'}</button></div>
      </form>
    </div>
  );
}
