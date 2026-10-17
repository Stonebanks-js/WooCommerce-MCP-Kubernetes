import { AUDIT_OUTCOMES, type Server, type User } from '../../types.js';
import type { AuditFilters } from './useAuditFeed.js';

interface Props {
  value: AuditFilters;
  onChange: (next: AuditFilters) => void;
  servers: Server[];
  /** Only admins get the user filter (members only ever see their own rows). */
  users: User[] | null;
}

export function AuditFilterBar({ value, onChange, servers, users }: Props) {
  const set = (patch: Partial<AuditFilters>) => onChange({ ...value, ...patch });
  return (
    <div className="audit-filters">
      <label>
        <span>Outcome</span>
        <select value={value.outcome} onChange={(e) => set({ outcome: e.target.value })}>
          <option value="">Any</option>
          {AUDIT_OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </label>
      <label>
        <span>Source</span>
        <select value={value.source} onChange={(e) => set({ source: e.target.value })}>
          <option value="">Any</option>
          <option value="mcp">mcp</option>
          <option value="chat">chat</option>
        </select>
      </label>
      <label>
        <span>Server</span>
        <select value={value.serverId} onChange={(e) => set({ serverId: e.target.value })}>
          <option value="">Any</option>
          {servers.map((s) => <option key={s.id} value={s.id}>{s.slug}</option>)}
        </select>
      </label>
      {users && (
        <label>
          <span>User</span>
          <select value={value.userId} onChange={(e) => set({ userId: e.target.value })}>
            <option value="">Anyone</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}
