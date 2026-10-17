import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { errorMessage } from '../../lib/errors.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { useAsync } from '../../lib/useAsync.js';
import type { Server } from '../../types.js';
import { StatusBadge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { useConfirm } from '../../ui/Confirm.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { ErrorNote } from '../../ui/Field.js';
import { Switch } from '../../ui/Switch.js';
import { Table, type Column } from '../../ui/Table.js';
import { useToast } from '../../ui/Toast.js';
import { useAuth } from '../auth/AuthContext.js';
import { PageHeader } from '../layout/PageHeader.js';
import { ServerFormModal } from './ServerFormModal.js';
import { describeStatus } from './status.js';
import './servers.css';

type Editing = { kind: 'new' } | { kind: 'edit'; server: Server } | null;

export function ServersPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, loading, reload, setData } = useAsync(() => api.servers.list(), 'servers');
  const [editing, setEditing] = useState<Editing>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const servers = data?.servers ?? [];

  const replace = (next: Server) =>
    setData((d) => (d ? { servers: d.servers.map((s) => (s.id === next.id ? next : s)) } : d));

  const withBusy = async (server: Server, action: () => Promise<void>) => {
    setBusyId(server.id);
    try {
      await action();
    } catch (err) {
      toast.push(errorMessage(err), 'danger');
    } finally {
      setBusyId(null);
    }
  };

  const setEnabled = (server: Server, enabled: boolean) => withBusy(server, async () => {
    const { server: next } = await api.servers.update(server.id, { enabled });
    replace(next);
    toast.push(`${next.name} ${enabled ? 'enabled' : 'disabled'} (${describeStatus(next)})`, next.status === 'unreachable' ? 'danger' : 'success');
  });

  const refresh = (server: Server) => withBusy(server, async () => {
    const { server: next } = await api.servers.refresh(server.id);
    replace(next);
    toast.push(`${next.name}: ${describeStatus(next)}`, next.status === 'unreachable' ? 'danger' : 'success');
  });

  const remove = async (server: Server) => {
    const ok = await confirm({
      title: 'Remove server',
      message: <>Remove <b>{server.name}</b> (<span className="mono">{server.slug}</span>)? Its tools disappear from the gateway immediately. Audit history is kept.</>,
      confirmLabel: 'Remove', danger: true,
    });
    if (!ok) return;
    await withBusy(server, async () => {
      await api.servers.remove(server.id);
      setData((d) => (d ? { servers: d.servers.filter((s) => s.id !== server.id) } : d));
      toast.push(`${server.name} removed`, 'success');
    });
  };

  const columns: Column<Server>[] = [
    { key: 'name', header: 'Server', render: (s) => (
      <>
        <Link to={`/servers/${s.id}`} className="cell-title">{s.name}</Link>
        <div className="server-slug">{s.slug}{s.managedBy !== 'admin' && <span className="subtle"> · {s.managedBy}</span>}</div>
      </>
    ) },
    { key: 'status', header: 'Status', render: (s) => (
      <>
        <StatusBadge status={s.status} error={s.statusError} />
        {s.statusError && <div className="status-error" title={s.statusError}>{s.statusError}</div>}
      </>
    ) },
    { key: 'enabled', header: 'Enabled', width: '90px', render: (s) => (
      isAdmin
        ? <Switch checked={s.enabled} label={`${s.name} enabled`} busy={busyId === s.id} onChange={(next) => void setEnabled(s, next)} />
        : <span>{s.enabled ? 'Yes' : 'No'}</span>
    ) },
    { key: 'tools', header: 'Tools', width: '70px', align: 'right', render: (s) => <span className="tools-count">{s.tools.length}</span> },
    { key: 'checked', header: 'Last check', width: '130px', render: (s) => (
      <span className="cell-nowrap muted" title={formatDateTime(s.statusCheckedAt)}>{formatRelative(s.statusCheckedAt)}</span>
    ) },
  ];
  if (isAdmin) {
    columns.push({ key: 'actions', header: '', width: '280px', render: (s) => (
      <div className="cell-actions">
        <Button size="sm" variant="ghost" disabled={busyId === s.id} onClick={() => void refresh(s)}>Refresh</Button>
        <Button size="sm" variant="ghost" disabled={busyId === s.id} onClick={() => setEditing({ kind: 'edit', server: s })}>Edit</Button>
        <Button size="sm" variant="ghost" disabled={busyId === s.id} onClick={() => void setEnabled(s, !s.enabled)}>{s.enabled ? 'Disable' : 'Enable'}</Button>
        <Button size="sm" variant="ghost" disabled={busyId === s.id} onClick={() => void remove(s)}>Remove</Button>
      </div>
    ) });
  }

  return (
    <>
      <PageHeader
        title="Servers"
        subtitle={isAdmin ? 'Upstream MCP servers the gateway aggregates.' : 'Upstream MCP servers whose tools you can use.'}
        actions={(
          <>
            <Button onClick={reload} disabled={loading}>Reload</Button>
            {isAdmin && <Button variant="primary" onClick={() => setEditing({ kind: 'new' })}>Add server</Button>}
          </>
        )}
      />
      <ErrorNote message={error} />
      <Table
        columns={columns}
        rows={servers}
        rowKey={(s) => s.id}
        loading={loading}
        empty={<EmptyState title="No servers yet" hint={isAdmin ? 'Add an upstream MCP server to start aggregating tools.' : 'An administrator has not connected any MCP servers yet.'} />}
      />
      {editing && (
        <ServerFormModal
          key={editing.kind === 'edit' ? editing.server.id : 'new'}
          server={editing.kind === 'edit' ? editing.server : null}
          onClose={() => setEditing(null)}
          onSaved={(saved, created) => {
            if (created) setData((d) => ({ servers: [...(d?.servers ?? []), saved] }));
            else replace(saved);
          }}
        />
      )}
    </>
  );
}
