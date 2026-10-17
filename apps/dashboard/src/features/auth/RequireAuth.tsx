import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Loading } from '../../ui/Loading.js';
import { useAuth } from './AuthContext.js';

/** Route guard: waits for the session check, then redirects anonymous (and, if asked, non-admin) users. */
export function RequireAuth({ adminOnly = false }: { adminOnly?: boolean }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="screen-center"><Loading label="Checking session…" /></div>;
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (adminOnly && user.role !== 'admin') {
    return <Navigate to="/" replace />;
  }
  return <Outlet />;
}
