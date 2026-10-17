import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  hint: string;
  action?: ReactNode;
}

export function EmptyState({ title, hint, action }: EmptyStateProps) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      <div className="empty-hint">{hint}</div>
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
