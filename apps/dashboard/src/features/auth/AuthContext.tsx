import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, setUnauthorizedHandler } from '../../api.js';
import type { User } from '../../types.js';

interface AuthState {
  user: User | null;
  /** True until GET /api/auth/me has answered once. */
  loading: boolean;
  setUser: (user: User | null) => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location);
  useEffect(() => { locationRef.current = location; });

  useEffect(() => {
    let cancelled = false;
    api.auth.me()
      .then(({ user: me }) => { if (!cancelled) setUser(me); })
      .catch(() => { /* not signed in (401) or gateway down: the login page handles both */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // A 401 anywhere means the session expired: drop the user and go to /login, remembering the page.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      const loc = locationRef.current;
      if (loc.pathname !== '/login') {
        navigate('/login', { replace: true, state: { from: loc.pathname + loc.search } });
      }
    });
    return () => setUnauthorizedHandler(null);
  }, [navigate]);

  const signOut = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      // The cookie is gone either way; fall through to the login page.
    }
    setUser(null);
    navigate('/login', { replace: true });
  }, [navigate]);

  const value = useMemo<AuthState>(() => ({ user, loading, setUser, signOut }), [user, loading, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Where to go after signing in: the page a 401 or the route guard bounced the user from. */
export function useReturnPath(): string {
  const location = useLocation();
  const state = location.state as { from?: unknown } | null;
  const from = typeof state?.from === 'string' ? state.from : '/';
  return from.startsWith('/') && !from.startsWith('//') ? from : '/';
}
