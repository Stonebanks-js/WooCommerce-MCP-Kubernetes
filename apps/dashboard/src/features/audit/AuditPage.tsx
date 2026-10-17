import { useState } from 'react';
import { api } from '../../api.js';
import { formatDateTime, formatDuration } from '../../lib/format.js';
import { useAsync } from '../../lib/useAsync.js';
import type { AuditEntry } from '../../types.js';
import { Badge, OutcomeBadge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { ErrorNote } from '../../ui/Field.js';
import { Switch } from '../../ui/Switch.js';
import { Table, type Column } from '../../ui/Table.js';
import { useAuth } from '../auth/AuthContext.js';
import { PageHeader } from '../layout/PageHeader.js';
import { AuditFilterBar } from './AuditFilters.js';
import { EMPTY_FILTERS, useAuditFeed, type AuditFilters } from './useAuditFeed.js';
import './audit.css';

const COLUMNS: Column<AuditEntry>[] = [
  { key: 'ts', header: 'Time', render: (e) => <span className="audit-time mono">{formatDateTime(e.ts)}</span> },
  { key: 'user', header: 'User', render: (e) => <span className="audit-user">{e.userEmail}</span> },
  { key: 'source', header: 'Source', width: '70px', render: (e) => <Badge tone={e.source === 'chat' ? 'info' : 'neutral'} mono>{e.source}</Badge> },
  { key: 'server', header: 'Server', render: (e) => <span className="mono">{e.serverSlug ?? '—'}</span> },
  { key: 'tool', header: 'Tool', render: (e) => <span className="mono" title={e.toolName ? `upstream: ${e.toolName}` : undefined}>{e.publicToolName}</span> },
  { key: 'duration', header: 'Duration', width: '90px', align: 'right', render: (e) => formatDuration(e.durationMs) },
  { key: 'outcome', header: 'Outcome', width: '110px', render: (e) => <OutcomeBadge outcome={e.outcome} /> },
  { key: 'error', header: 'Error', render: (e) => e.errorMessage ? <span className="audit-error" title={e.errorMessage}>{e.errorMessage}</span> : null },
];

export function AuditPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const feed = useAuditFeed(filters, autoRefresh);
  const servers = useAsync(() => api.servers.list(), 'servers');
  const users = useAsync(() => (isAdmin ? api.users.list() : Promise.resolve({ users: [] })), `users:${isAdmin}`);

  const hasFilter = Object.values(filters).some((v) => v !== '');

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle={isAdmin ? 'Every tool call through the MCP endpoint or the chat agent.' : 'Your tool calls through the MCP endpoint or the chat agent.'}
        actions={(
          <>
            <span className="auto-refresh">
              <Switch checked={autoRefresh} onChange={setAutoRefresh} label="Auto-refresh every 5 seconds" />
              Auto-refresh (5 s)
            </span>
            <Button onClick={feed.reload} disabled={feed.loading}>Reload</Button>
          </>
        )}
      />
      <AuditFilterBar
        value={filters}
        onChange={setFilters}
        servers={servers.data?.servers ?? []}
        users={isAdmin ? users.data?.users ?? [] : null}
      />
      <ErrorNote message={feed.error} />
      <Table
        columns={COLUMNS}
        rows={feed.entries}
        rowKey={(e) => e.id}
        loading={feed.loading}
        empty={<EmptyState title="No audit entries" hint={hasFilter ? 'Nothing matches these filters.' : 'Tool calls show up here as soon as a client or the chat agent makes one.'} />}
      />
      <div className="audit-footer">
        {feed.nextBefore !== null ? (
          <Button onClick={() => void feed.loadMore()} loading={feed.loadingMore}>Load more</Button>
        ) : (
          feed.entries.length > 0 && <span className="muted small">End of log · {feed.entries.length} entries loaded</span>
        )}
      </div>
    </>
  );
}
