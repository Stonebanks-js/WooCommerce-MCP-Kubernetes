import { NavLink, Outlet } from 'react-router-dom';
import { RoleBadge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { useAuth } from '../auth/AuthContext.js';
import { Wordmark } from './Wordmark.js';
import './layout.css';

interface NavItem { to: string; label: string; adminOnly?: boolean; end?: boolean }

const NAV: NavItem[] = [
  { to: '/', label: 'Servers', end: true },
  { to: '/chat', label: 'Chat' },
  { to: '/audit', label: 'Audit log' },
  { to: '/keys', label: 'API keys' },
  { to: '/team', label: 'Team', adminOnly: true },
];

export function AppShell() {
  const { user, signOut } = useAuth();
  if (!user) return null; // RequireAuth guarantees a user; this keeps the types honest.
  const isAdmin = user.role === 'admin';

  return (
    <div className="shell">
      <aside className="sidebar">
        <Wordmark />
        <nav className="nav" aria-label="Main">
          {NAV.filter((item) => !item.adminOnly || isAdmin).map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `nav-link${isActive ? ' is-active' : ''}`}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-user">
          <div className="sidebar-email" title={user.email}>{user.email}</div>
          <div className="sidebar-user-row">
            <RoleBadge role={user.role} />
            <Button size="sm" variant="ghost" onClick={() => void signOut()}>Sign out</Button>
          </div>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
