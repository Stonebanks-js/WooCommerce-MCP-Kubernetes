import { Fragment, type ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  width?: string;
  align?: 'left' | 'right';
}

interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  /** Rendered in a single full-width cell when there are no rows. */
  empty: ReactNode;
  loading?: boolean;
  /** Optional detail row rendered under a row (return null for none). */
  expanded?: (row: T) => ReactNode;
}

export function Table<T>({ columns, rows, rowKey, empty, loading = false, expanded }: TableProps<T>) {
  const cellClass = (c: Column<T>) => (c.align === 'right' ? 'num' : undefined);
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={c.width ? { width: c.width } : undefined} className={cellClass(c)}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="table-empty">
                {loading ? <span className="muted">Loading…</span> : empty}
              </td>
            </tr>
          )}
          {rows.map((row) => {
            const detail = expanded ? expanded(row) : null;
            return (
              <Fragment key={rowKey(row)}>
                <tr>
                  {columns.map((c) => <td key={c.key} className={cellClass(c)}>{c.render(row)}</td>)}
                </tr>
                {detail !== null && detail !== undefined && (
                  <tr className="table-detail">
                    <td colSpan={columns.length}>{detail}</td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
