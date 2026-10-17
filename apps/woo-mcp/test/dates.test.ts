import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  InvalidDateError,
  isDateOnly,
  normalizeAfter,
  normalizeBefore,
  normalizeDateBound,
} from '../src/woo/dates.ts';

describe('dates.normalizeDateBound', () => {
  test('expands YYYY-MM-DD to the start of the day for after', () => {
    assert.equal(normalizeDateBound('2026-10-16', 'after'), '2026-10-16T00:00:00');
    assert.equal(normalizeAfter('2026-01-01'), '2026-01-01T00:00:00');
  });

  test('expands YYYY-MM-DD to the end of the day for before', () => {
    assert.equal(normalizeDateBound('2026-10-16', 'before'), '2026-10-16T23:59:59');
    assert.equal(normalizeBefore('2024-02-29'), '2024-02-29T23:59:59');
  });

  test('passes full ISO 8601 date-times through unchanged', () => {
    for (const v of [
      '2026-10-16T12:30:00',
      '2026-10-16T12:30:00Z',
      '2026-10-16T12:30:00+05:30',
      '2026-10-16T12:30:00.123Z',
      '2026-10-16T12:30',
      '2026-10-16 12:30:00',
    ]) {
      assert.equal(normalizeDateBound(v, 'after'), v, v);
      assert.equal(normalizeDateBound(v, 'before'), v, v);
    }
  });

  test('trims surrounding whitespace', () => {
    assert.equal(normalizeDateBound('  2026-10-16 ', 'after'), '2026-10-16T00:00:00');
    assert.equal(normalizeDateBound(' 2026-10-16T01:02:03Z ', 'before'), '2026-10-16T01:02:03Z');
  });

  test('rejects impossible calendar days', () => {
    for (const v of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31', '2025-02-29']) {
      assert.throws(() => normalizeDateBound(v, 'after'), InvalidDateError, v);
    }
  });

  test('rejects anything that is not a date', () => {
    for (const v of ['', 'yesterday', 'today', '16/10/2026', '2026-10', '20261016', '2026-10-16T25:00:00', 'T00:00:00']) {
      assert.throws(() => normalizeDateBound(v, 'before'), InvalidDateError, JSON.stringify(v));
    }
  });

  test('error message tells the caller the accepted formats', () => {
    assert.throws(() => normalizeDateBound('tomorrow', 'after'), (err: unknown) => {
      assert.ok(err instanceof InvalidDateError);
      assert.match(err.message, /YYYY-MM-DD/);
      assert.match(err.message, /ISO 8601/);
      assert.match(err.message, /"tomorrow"/);
      return true;
    });
  });
});

describe('dates.isDateOnly', () => {
  test('accepts real calendar days only', () => {
    assert.equal(isDateOnly('2026-10-16'), true);
    assert.equal(isDateOnly('2024-02-29'), true);
    assert.equal(isDateOnly('2023-02-29'), false);
    assert.equal(isDateOnly('2026-10-16T00:00:00'), false);
    assert.equal(isDateOnly('2026-1-6'), false);
  });
});
