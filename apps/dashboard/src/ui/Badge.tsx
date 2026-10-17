import type { ReactNode } from 'react';
import type { Role, ServerStatus } from '../types.js';

export type BadgeTone = 'success' | 'danger' | 'neutral' | 'warning' | 'info' | 'accent';

interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  title?: string;
  dot?: boolean;
  mono?: boolean;
}

export function Badge({ tone = 'neutral', children, title, dot = false, mono = false }: BadgeProps) {
  return (
    <span className={`badge badge-${tone}${mono ? ' mono' : ''}`} title={title}>
      {dot && <span className="badge-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

const STATUS: Record<ServerStatus, { tone: BadgeTone; label: string }> = {
  connected: { tone: 'success', label: 'Connected' },
  unreachable: { tone: 'danger', label: 'Unreachable' },
  disabled: { tone: 'neutral', label: 'Disabled' },
};

/** Server status pill; the probe error (if any) is the hover title. */
export function StatusBadge({ status, error }: { status: ServerStatus; error?: string }) {
  const s = STATUS[status];
  return <Badge tone={s.tone} dot title={error}>{s.label}</Badge>;
}

const OUTCOME_TONE: Record<string, BadgeTone> = {
  success: 'success',
  error: 'danger',
  timeout: 'danger',
  unreachable: 'danger',
  denied: 'warning',
  not_found: 'warning',
  rate_limited: 'warning',
};

export function OutcomeBadge({ outcome }: { outcome: string }) {
  return <Badge tone={OUTCOME_TONE[outcome] ?? 'neutral'} mono>{outcome}</Badge>;
}

export function RoleBadge({ role }: { role: Role }) {
  return <Badge tone={role === 'admin' ? 'accent' : 'neutral'}>{role}</Badge>;
}
