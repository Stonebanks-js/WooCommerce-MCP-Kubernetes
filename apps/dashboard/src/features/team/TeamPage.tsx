import { useState } from 'react';
import { api } from '../../api.js';
import { errorMessage } from '../../lib/errors.js';
import { formatDateTime } from '../../lib/format.js';
import { useAsync } from '../../lib/useAsync.js';
import type { Role, User, UserPatch, UserStatus } from '../../types.js';
import { Badge, type BadgeTone } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { useConfirm } from '../../ui/Confirm.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { ErrorNote } from '../../ui/Field.js';
import { Table, type Column } from '../../ui/Table.js';
import { useToast } from '../../ui/Toast.js';
import { useAuth } from '../auth/AuthContext.js';
import { PageHeader } from '../layout/PageHeader.js';
import { InviteModal } from './InviteModal.js';
import { UserKeysPanel } from './UserKeysPanel.js';
import './team.css';

const STATUS_TONE: Record<UserStatus, BadgeTone> = { active: 'success', invited: 'info', disabled: 'neutral' };

export function TeamPage() {
  const { user: me } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, loading, setData } = useAsync(() => api.users.list(), 'users');
  const [inviting, setInviting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const users = data?.users ?? [];

  const replace = (next: User) => setData((d) => (d ? { users: d.users.map((u) => (u.id === next.id ? next : u)) } : d));

  const patch = async (user: User, body: UserPatch, okMessage: string) => {
    setBusyId(user.id);
    try {
      const { user: next } = await api.users.update(user.id, body);
      replace(next);
      toast.push(okMessage, 'success');
    } catch (err) {
      toast.push(errorMessage(err), 'danger');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (user: User) => {
    const ok = await confirm({
      title: 'Delete user',
      message: <>Delete <b>{user.email}</b>? Their API keys stop working immediately. Audit history is kept.</>,
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    setBusyId(user.id);
    try {
      await api.users.remove(user.id);
      setData((d) => (d ? { users: d.users.filter((u) => u.id !== user.id) } : d));
      if (expandedId === user.id) setExpandedId(null);
      toast.push(`${user.email} deleted`, 'success');
    } catch (err) {
      toast.push(errorMessage(err), 'danger');
    } finally {
      setBusyId(null);
    }
  };

  const columns: Column<User>[] = [
    { key: 'email', header: 'Email', render: (u) => <span className="break">{u.email}{u.id === me?.id && <span className="muted"> (you)</span>}</span> },
    { key: 'name', header: 'Name', render: (u) => u.name ? <span className="user-name">{u.name}</span> : <span className="subtle">—</span> },
    { key: 'role', header: 'Role', width: '120px', render: (u) => (
      <select className="role-select" value={u.role} disabled={u.id === me?.id || busyId === u.id} aria-label={`Role of ${u.email}`}
        onChange={(e) => void patch(u, { role: e.target.value as Role }, `${u.email} is now ${e.target.value}`)}>
        <option value="member">member</option>
        <option value="admin">admin</option>
      </select>
    ) },
    { key: 'status', header: 'Status', width: '100px', render: (u) => <Badge tone={STATUS_TONE[u.status]} dot>{u.status}</Badge> },
    { key: 'created', header: 'Created', width: '170px', render: (u) => <span className="cell-nowrap">{formatDateTime(u.createdAt)}</span> },
    { key: 'actions', header: '', width: '220px', render: (u) => {
      const self = u.id === me?.id;
      const busy = busyId === u.id;
      return (
        <div className="cell-actions">
          <Button size="sm" variant="ghost" onClick={() => setExpandedId((id) => (id === u.id ? null : u.id))}>
            {expandedId === u.id ? 'Hide keys' : 'Keys'}
          </Button>
          {u.status !== 'invited' && (
            <Button size="sm" variant="ghost" disabled={self || busy}
              onClick={() => void patch(u, { status: u.status === 'disabled' ? 'active' : 'disabled' }, `${u.email} ${u.status === 'disabled' ? 'enabled' : 'disabled'}`)}>
              {u.status === 'disabled' ? 'Enable' : 'Disable'}
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={self || busy} title={self ? 'You cannot delete yourself' : undefined} onClick={() => void remove(u)}>
            Delete
          </Button>
        </div>
      );
    } },
  ];

  return (
    <>
      <PageHeader
        title="Team"
        subtitle="Who can sign in to the dashboard and call tools through the gateway."
        actions={<Button variant="primary" onClick={() => setInviting(true)}>Invite</Button>}
      />
      <ErrorNote message={error} />
      <Table
        columns={columns}
        rows={users}
        rowKey={(u) => u.id}
        loading={loading}
        expanded={(u) => (u.id === expandedId ? <UserKeysPanel user={u} /> : null)}
        empty={<EmptyState title="No users" hint="Invite a teammate to get started." />}
      />
      {inviting && (
        <InviteModal
          onInvited={(user) => setData((d) => ({ users: [...(d?.users ?? []), user] }))}
          onClose={() => setInviting(false)}
        />
      )}
    </>
  );
}
