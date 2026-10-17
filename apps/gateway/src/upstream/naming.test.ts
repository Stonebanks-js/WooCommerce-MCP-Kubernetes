import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_PUBLIC_NAME_LENGTH, SLUG_RE, describeWithSource, publicToolName } from './naming.ts';

test('public name is <slug>__<tool>', () => {
  assert.equal(publicToolName('notes', 'get_current_time'), 'notes__get_current_time');
  assert.equal(publicToolName('utils', 'get_current_time'), 'utils__get_current_time');
});

test('same upstream tool name on two servers never collides', () => {
  assert.notEqual(publicToolName('notes', 'get_current_time'), publicToolName('utils', 'get_current_time'));
});

test('names longer than 64 chars are truncated to 55 + _ + 8 hex and stay unique', () => {
  const slug = 'averyveryverylongslug';
  const toolA = 'this_is_an_extremely_long_tool_name_that_goes_on_and_on_forever_a';
  const toolB = 'this_is_an_extremely_long_tool_name_that_goes_on_and_on_forever_b';
  const a = publicToolName(slug, toolA);
  const b = publicToolName(slug, toolB);
  assert.equal(a.length, MAX_PUBLIC_NAME_LENGTH);
  assert.equal(b.length, MAX_PUBLIC_NAME_LENGTH);
  assert.match(a, /^[a-z0-9_-]{55}_[0-9a-f]{8}$/);
  assert.notEqual(a, b);
  assert.equal(a, publicToolName(slug, toolA), 'deterministic');
});

test('exactly 64 chars is not truncated', () => {
  const slug = 'ab';
  const tool = 'x'.repeat(60);
  const name = publicToolName(slug, tool);
  assert.equal(name, `ab__${tool}`);
  assert.equal(name.length, 64);
});

test('slug regex: 2-20 chars, starts with a letter', () => {
  for (const ok of ['ab', 'woo', 'notes-2', 'a1234567890123456789']) assert.ok(SLUG_RE.test(ok), ok);
  for (const bad of ['a', '1ab', 'Ab', 'a_b', 'a'.repeat(21), '']) assert.ok(!SLUG_RE.test(bad), bad);
});

test('descriptions are prefixed with the server display name', () => {
  assert.equal(describeWithSource('Team notes', 'Lists notes'), '[Team notes] Lists notes');
  assert.equal(describeWithSource('Team notes', undefined), '[Team notes]');
});
