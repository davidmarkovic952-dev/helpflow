import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes } from 'react-router-dom';
import './styles.css';
import { AuthProvider, useAuth } from './auth';
import { ROLE } from './format';
import { Login } from './pages/Login';
import { Inbox } from './pages/Inbox';
import { TicketPage } from './pages/Ticket';
import { Knowledge } from './pages/Knowledge';
import { Admin } from './pages/Admin';
import { Settings } from './pages/Settings';
import { Invite } from './pages/Invite';
import { Portal, PortalTicket } from './pages/Portal';

function Shell() {
  const { me, mfaRequired, loading, logout } = useAuth();
  if (loading) return <div className="center muted">Učitavanje…</div>;
  if (!me || mfaRequired) return <Navigate to="/login" replace />;
  const admin = me.role !== 'agent';
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">Help<span>Flow</span></div>
        <NavLink className={({ isActive }) => `nav${isActive ? ' on' : ''}`} to="/" end>Tiketi</NavLink>
        <NavLink className={({ isActive }) => `nav${isActive ? ' on' : ''}`} to="/kb">Baza znanja</NavLink>
        {admin && <NavLink className={({ isActive }) => `nav${isActive ? ' on' : ''}`} to="/admin">Administracija</NavLink>}
        <NavLink className={({ isActive }) => `nav${isActive ? ' on' : ''}`} to="/settings">Bezbednost naloga</NavLink>
        <div className="who"><b>{me.name}</b>{ROLE[me.role]}{!me.totpEnabled && <div className="bad small">2FA nije uključen</div>}
          <button className="btn sm" onClick={logout}>Odjava</button></div>
      </aside>
      <main className="main"><Outlet /></main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/invite/:token" element={<Invite />} />
          <Route path="/s/:slug" element={<Portal />} />
          <Route path="/s/:slug/t" element={<PortalTicket />} />
          <Route element={<Shell />}>
            <Route index element={<Inbox />} />
            <Route path="tickets/:id" element={<TicketPage />} />
            <Route path="kb" element={<Knowledge />} />
            <Route path="admin" element={<Admin />} />
            <Route path="settings" element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);
