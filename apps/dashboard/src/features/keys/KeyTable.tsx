import { formatDateTime, formatRelative } from '../../lib/format.js';
import type { ApiKey } from '../../types.js';
import { Badge } from '../../ui/Badge.js';
import { Button } from '../../ui/Button.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { Table, type Column } from '../../ui/Table.js';

interface Props {
  keys: ApiKey[];
  loading: boolean;
  busyId: string | null;
  onRevoke: (key: ApiKey) => void;
  emptyHint: string;
}

export function KeyTable({ keys, loading, busyId, onRevoke, emptyHint }: Props) {
  const columns: Column<ApiKey>[] = [
    { key: 'prefix', header: 'Prefix', width: '140px', render: (k) => <span className="mono">{k.prefix}…</span> },
    { key: 'name', header: 'Name', render: (k) => k.name || <span className="muted">Unnamed</span> },
    { key: 'created', header: 'Created', width: '170px', render: (k) => <span className="cell-nowrap">{formatDateTime(k.createdAt)}</span> },
    { key: 'used', header: 'Last used', width: '130px', render: (k) => (
      <span className="cell-nowrap muted" title={formatDateTime(k.lastUsedAt)}>{formatRelative(k.lastUsedAt)}</span>
    ) },
    { key: 'status', header: 'Status', width: '100px', render: (k) => (
      k.revokedAt
        ? <Badge tone="neutral" title={`Revoked ${formatDateTime(k.revokedAt)}`}>Revoked</Badge>
        : <Badge tone="success" dot>Active</Badge>
    ) },
    { key: 'actions', header: '', width: '90px', render: (k) => (
      <div className="cell-actions">
        {!k.revokedAt && <Button size="sm" variant="ghost" disabled={busyId === k.id} onClick={() => onRevoke(k)}>Revoke</Button>}
      </div>
    ) },
  ];
  return (
    <Table
      columns={columns}
      rows={keys}
      rowKey={(k) => k.id}
      loading={loading}
      empty={<EmptyState title="No API keys" hint={emptyHint} />}
    />
  );
}
