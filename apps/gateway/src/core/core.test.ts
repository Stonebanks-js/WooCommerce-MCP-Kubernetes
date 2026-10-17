import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchTools } from '../chat/toolSearch.ts';
import type { PublicTool } from './gatewayCore.ts';
import { argsPreview } from './audit.ts';
import { RateLimiter } from './ratelimit.ts';
import { normalizeTool } from '../upstream/registry.ts';

test('rate limiter: token bucket per key, refills over time', () => {
  let now = 0;
  const rl = new RateLimiter(60, () => now);
  for (let i = 0; i < 60; i++) assert.ok(rl.take('a'), `call ${i}`);
  assert.ok(!rl.take('a'), '61st call is rejected');
  assert.ok(rl.take('b'), 'other key unaffected');
  now = 2000; // 2 s → 2 tokens
  assert.ok(rl.take('a'));
  assert.ok(rl.take('a'));
  assert.ok(!rl.take('a'));
});

test('args preview is JSON truncated to 2000 chars', () => {
  assert.equal(argsPreview({ a: 1 }), '{"a":1}');
  assert.equal(argsPreview('x'.repeat(5000))?.length, 2000);
  assert.equal(argsPreview(undefined), undefined);
});

test('normalizeTool makes schemas acceptable to SDK clients', () => {
  const t = normalizeTool({ name: 'x', inputSchema: {} as never });
  assert.equal(t.inputSchema.type, 'object');
  const u = normalizeTool({ name: 'y', inputSchema: { type: 'object', properties: { a: true, b: { type: 'string' } } } as never });
  assert.deepEqual(u.inputSchema.properties, { a: {}, b: { type: 'string' } });
});

test('tool search ranks name hits above description hits', () => {
  const mk = (publicName: string, description: string): PublicTool => ({
    publicName,
    serverSlug: publicName.split('__')[0] ?? '',
    serverName: 's',
    name: publicName.split('__')[1] ?? '',
    description,
    inputSchema: { type: 'object' },
  });
  const tools = [mk('woo__list_orders', 'Lists orders'), mk('woo__get_product', 'Fetch one product including order of fields'), mk('notes__create_note', 'Create a note')];
  const r = searchTools(tools, 'orders');
  assert.equal(r[0]?.publicName, 'woo__list_orders');
  assert.ok(!r.some((t) => t.publicName === 'notes__create_note'));
  assert.equal(searchTools(tools, '').length, 3);
});
