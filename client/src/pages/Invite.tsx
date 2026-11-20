import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { ErrorBox } from '../ui';

export function Invite() {
  const { token } = useParams();
  const [pw, setPw] = useState(''); const [pw2, setPw2] = useState('');
  const [err, setErr] = useState(''); const [done, setDone] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr('');
    if (pw !== pw2) return setErr('Lozinke se ne poklapaju');
    try { await api.post(`/auth/invite/${token}`, { password: pw }); setDone(true); } catch (x) { setErr((x as Error).message); }
  }
  return (
    <div className="center"><form className="card authbox" onSubmit={submit}>
      <div className="brand">Help<span>Flow</span></div>
      {done ? <><div className="okmsg">Lozinka je postavljena.</div><Link to="/login">Prijavi se →</Link></> : <>
        <h1>Postavi lozinku</h1><p className="sub">Najmanje 12 znakova. Preporuka: fraza od 3–4 nasumične reči.</p>
        <ErrorBox e={err} />
        <label className="l">Lozinka</label><input className="in" type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} required />
        <label className="l">Ponovi lozinku</label><input className="in" type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} required />
        <div className="row composer"><button className="btn pri grow">Sačuvaj</button></div>
      </>}
    </form></div>
  );
}
