import assert from 'node:assert/strict';
import { test } from 'node:test';
import { globToRegExp, isToolAllowed, parsePolicy } from './policy.ts';

test('glob: * is the only wildcard, everything else literal', () => {
  assert.ok(globToRegExp('get_*').test('get_order'));
  assert.ok(!globToRegExp('get_*').test('list_orders'));
  assert.ok(globToRegExp('*').test('anything'));
  assert.ok(globToRegExp('*_order_*').test('update_order_status'));
  assert.ok(!globToRegExp('get.order').test('getXorder'), 'dot is literal');
  assert.ok(globToRegExp('get.order').test('get.order'));
  assert.ok(!globToRegExp('get_order').test('get_order_notes'), 'whole string match');
});

test('mode all allows everything', () => {
  assert.ok(isToolAllowed({ mode: 'all' }, 'delete_everything'));
});

test('allowlist only allows matching tools', () => {
  const p = { mode: 'allowlist' as const, patterns: ['list_*', 'get_*'] };
  assert.ok(isToolAllowed(p, 'list_orders'));
  assert.ok(isToolAllowed(p, 'get_order'));
  assert.ok(!isToolAllowed(p, 'update_order_status'));
  assert.ok(!isToolAllowed({ mode: 'allowlist', patterns: [] }, 'anything'));
});

test('denylist hides matching tools', () => {
  const p = { mode: 'denylist' as const, patterns: ['update_*', 'create_product'] };
  assert.ok(!isToolAllowed(p, 'update_order_status'));
  assert.ok(!isToolAllowed(p, 'create_product'));
  assert.ok(isToolAllowed(p, 'list_products'));
});

test('parsePolicy degrades invalid jsonb to {mode:all}', () => {
  assert.deepEqual(parsePolicy(null), { mode: 'all' });
  assert.deepEqual(parsePolicy({ mode: 'weird' }), { mode: 'all' });
  assert.deepEqual(parsePolicy({ mode: 'denylist', patterns: ['x'] }), { mode: 'denylist', patterns: ['x'] });
});
