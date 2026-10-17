import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { errorMessage } from '../../lib/errors.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { useAsync } from '../../lib/useAsync.js';
import type { Server, ServerTool } from '../../types.js';
import { Badge, StatusBadge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { ErrorNote } from '../../ui/Field.js';
import { Loading } from '../../ui/Loading.js';
import { Table, type Column } from '../../ui/Table.js';
import { useToast } from '../../ui/Toast.js';
import { useAuth } from '../auth/AuthContext.js';
import { PageHeader } from '../layout/PageHeader.js';
import { describeStatus } from './status.js';
import './servers.css';

function hintChips(annotations: Record<string, unknown> | undefined) {
  if (!annotations) return null;
  const chips: Array<{ label: string; cls: string }> = [];
  if (annotations.readOnlyHint === true) chips.push({ label: 'read-only', cls: 'chip chip-ok' });
  if (annotations.destructiveHint === true) chips.push({ label: 'destructive', cls: 'chip chip-danger' });
  if (annotations.idempotentHint === true) chips.push({ label: 'idempotent', cls: 'chip' });
  if (chips.length === 0) return null;
  return <span className="chips">{chips.map((c) => <span key={c.label} className={c.cls}>{c.label}</span>)}</span>;
}

function PolicySummary({ server }: { server: Server }) {
  const p = server.memberToolPolicy;
  if (p.mode === 'all') return <span>All tools</span>;
  return (
    <span className="row">
      <span>{p.mode === 'allowlist' ? 'Allowlist' : 'Denylist'}</span>
      <span className="chips">{p.patterns.map((pat) => <span key={pat} className="chip policy-patterns">{pat}</span>)}</span>
    </span>
  );
}

export function ServerDetailPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const toast = useToast();
  const { data, error, loading, setData } = useAsync(() => api.servers.get(id), `server:${id}`);
  const [refreshing, setRefreshing] = useState(false);
  const server = data?.server ?? null;

  const refresh = async () => {
    setRefreshing(true);
    try {
      const { server: next } = await api.servers.refresh(id);
      setData({ server: next });
      toast.push(`${next.name}: ${describeStatus(next)}`, next.status === 'unreachable' ? 'danger' : 'success');
    } catch (err) {
      toast.push(errorMessage(err), 'danger');
    } finally {
      setRefreshing(false);
    }
  };

  const columns: Column<ServerTool>[] = [
    { key: 'public', header: 'Public name', render: (t) => <span className="mono">{t.publicName}</span> },
    { key: 'upstream', header: 'Upstream name', render: (t) => <span className="mono muted">{t.name}</span> },
    { key: 'desc', header: 'Title / description', render: (t) => (
      <>
        {t.title && <div className="tool-title">{t.title}</div>}
        {t.description && <div className="tool-desc">{t.description}</div>}
      </>
    ) },
    { key: 'hints', header: 'Hints', width: '160px', render: (t) => hintChips(t.annotations) },
  ];
  if (isAdmin) {
    columns.splice(3, 0, { key: 'members', header: 'Members', width: '90px', render: (t) => (
      <Badge tone={t.allowedForMembers ? 'success' : 'neutral'}>{t.allowedForMembers ? 'yes' : 'no'}</Badge>
    ) });
  }

  if (loading && !server) return <Loading label="Loading server…" />;
  if (!server) {
    return (
      <>
        <PageHeader title="Server" actions={<Link to="/">Back to servers</Link>} />
        <ErrorNote message={error ?? 'Server not found.'} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={<span className="row">{server.name} <span className="server-slug">{server.slug}</span></span>}
        subtitle={<Link to="/">← All servers</Link>}
        actions={isAdmin && <Button onClick={() => void refresh()} loading={refreshing}>Refresh</Button>}
      />
      <ErrorNote message={error} />
      <div className="detail-grid">
        <div className="card">
          <div className="card-title">Status</div>
          <dl className="kv">
            <dt>State</dt><dd><StatusBadge status={server.status} error={server.statusError} /></dd>
            {server.statusError && <><dt>Error</dt><dd className="status-error" style={{ maxWidth: 'none' }}>{server.statusError}</dd></>}
            <dt>Last check</dt><dd title={formatDateTime(server.statusCheckedAt)}>{formatRelative(server.statusCheckedAt)}</dd>
            <dt>Tools updated</dt><dd title={formatDateTime(server.toolsUpdatedAt)}>{formatRelative(server.toolsUpdatedAt)}</dd>
            <dt>Enabled</dt><dd>{server.enabled ? 'Yes' : 'No'}</dd>
          </dl>
        </div>
        <div className="card">
          <div className="card-title">Configuration</div>
          <dl className="kv">
            {isAdmin && <><dt>URL</dt><dd className="mono">{server.url ?? '—'}</dd></>}
            {isAdmin && (
              <>
                <dt>Auth</dt>
                <dd>
                  {server.authType === 'none' ? 'None' : server.authType === 'bearer' ? 'Bearer token' : `Header ${server.authHeaderName ?? ''}`}
                  {server.authType !== 'none' && <span className="muted"> · {server.hasCredential ? 'credential stored' : 'no credential'}</span>}
                </dd>
                <dt>Timeout</dt><dd>{server.timeoutMs} ms</dd>
              </>
            )}
            <dt>Member policy</dt><dd><PolicySummary server={server} /></dd>
            <dt>Managed by</dt><dd>{server.managedBy}</dd>
            <dt>Created</dt><dd>{formatDateTime(server.createdAt)}</dd>
            <dt>Updated</dt><dd>{formatDateTime(server.updatedAt)}</dd>
          </dl>
        </div>
      </div>
      <div className="section">
        <div className="section-title">Tools <span className="muted">({server.tools.length})</span></div>
        <Table
          columns={columns}
          rows={server.tools}
          rowKey={(t) => t.publicName}
          empty={<EmptyState title="No tools" hint={server.status === 'connected' ? 'The upstream server lists no tools.' : 'Tools appear once the gateway can reach this server.'} />}
        />
      </div>
    </>
  );
}
