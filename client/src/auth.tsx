import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setCsrf } from './api';
import type { Me } from './types';

interface AuthState { me: Me | null; mfaRequired: boolean; loading: boolean; refresh: () => Promise<void>; logout: () => Promise<void> }
const Ctx = createContext<AuthState>(null!);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [mfaRequired, setMfa] = useState(false);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ user: Me; mfaRequired: boolean; csrfToken: string }>('/auth/me');
      setCsrf(r.csrfToken); setMe(r.user); setMfa(r.mfaRequired);
    } catch { setMe(null); setMfa(false); setCsrf(''); }
    setLoading(false);
  }, []);
  const logout = useCallback(async () => { try { await api.post('/auth/logout'); } finally { setCsrf(''); setMe(null); setMfa(false); } }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return <Ctx.Provider value={{ me, mfaRequired, loading, refresh, logout }}>{children}</Ctx.Provider>;
}
