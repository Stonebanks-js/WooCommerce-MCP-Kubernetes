import type { ReactNode } from 'react';

interface FieldProps {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  /** Lay the control to the right of the label (checkbox / switch rows). */
  inline?: boolean;
}

export function Field({ label, htmlFor, hint, error, children, inline = false }: FieldProps) {
  return (
    <div className={`field${inline ? ' field-inline' : ''}${error ? ' has-error' : ''}`}>
      <label className="field-label" htmlFor={htmlFor}>{label}</label>
      <div className="field-control">{children}</div>
      {hint && !error && <div className="field-hint">{hint}</div>}
      {error && <div className="field-error" role="alert">{error}</div>}
    </div>
  );
}

/** Inline error banner used by forms and pages. */
export function ErrorNote({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return <div className="error-note" role="alert">{message}</div>;
}
