/**
 * Date-bound normalisation for `list_orders`.
 *
 * WooCommerce's `after` / `before` filters take ISO 8601 strings. When
 * `dates_are_gmt` is not set (we never set it) they are compared against the
 * order's local `date_created`, i.e. in the store's configured timezone. A
 * plain calendar day therefore maps to that day's local start / end:
 *
 *   after:  2026-10-16  ->  2026-10-16T00:00:00
 *   before: 2026-10-16  ->  2026-10-16T23:59:59
 *
 * Anything that already carries a time component is passed through untouched
 * so callers can be precise (and may add an offset or `Z` if they want UTC).
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/i;

export type DateBound = 'after' | 'before';

export class InvalidDateError extends Error {
  override name = 'InvalidDateError';
}

function isRealCalendarDay(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

/** True when `value` is exactly `YYYY-MM-DD` and a real calendar day. */
export function isDateOnly(value: string): boolean {
  const m = DATE_ONLY.exec(value);
  if (!m) return false;
  return isRealCalendarDay(Number(m[1]), Number(m[2]), Number(m[3]));
}

/**
 * Normalise one bound. `YYYY-MM-DD` becomes the start (after) or end (before)
 * of that day; full ISO 8601 date-times are returned unchanged (trimmed).
 * Throws InvalidDateError for anything else.
 */
export function normalizeDateBound(value: string, bound: DateBound): string {
  const v = value.trim();
  const m = DATE_ONLY.exec(v);
  if (m) {
    if (!isRealCalendarDay(Number(m[1]), Number(m[2]), Number(m[3]))) {
      throw new InvalidDateError(`"${value}" is not a valid calendar date (expected YYYY-MM-DD)`);
    }
    return bound === 'after' ? `${v}T00:00:00` : `${v}T23:59:59`;
  }
  if (ISO_DATE_TIME.test(v) && !Number.isNaN(Date.parse(v))) {
    return v;
  }
  throw new InvalidDateError(
    `"${value}" is not a valid ${bound} date; use YYYY-MM-DD (e.g. "2026-10-16") or a full ISO 8601 date-time`,
  );
}

export const normalizeAfter = (value: string): string => normalizeDateBound(value, 'after');
export const normalizeBefore = (value: string): string => normalizeDateBound(value, 'before');
