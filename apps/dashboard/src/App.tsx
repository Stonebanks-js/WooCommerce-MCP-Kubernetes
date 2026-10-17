import { Link, Route, Routes } from 'react-router-dom';
import { AuditPage } from './features/audit/AuditPage.js';
import { InvitePage } from './features/auth/InvitePage.js';
import { LoginPage } from './features/auth/LoginPage.js';
import { RequireAuth } from './features/auth/RequireAuth.js';
import { ChatPage } from './features/chat/ChatPage.js';
import { KeysPage } from './features/keys/KeysPage.js';
import { AppShell } from './features/layout/AppShell.js';
import { ServerDetailPage } from './features/servers/ServerDetailPage.js';
import { ServersPage } from './features/servers/ServersPage.js';
import { TeamPage } from './features/team/TeamPage.js';

function NotFound() {
  return (
    <div className="stack" style={{ padding: 'var(--s4)' }}>
      <h1 className="page-title">Page not found</h1>
      <p className="muted">Nothing lives at this address. <Link to="/">Back to servers</Link></p>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invite/:token" element={<InvitePage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<ServersPage />} />
          <Route path="servers/:id" element={<ServerDetailPage />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="keys" element={<KeysPage />} />
          <Route element={<RequireAuth adminOnly />}>
            <Route path="team" element={<TeamPage />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}
