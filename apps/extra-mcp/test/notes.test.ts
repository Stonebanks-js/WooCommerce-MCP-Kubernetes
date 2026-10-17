import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { makeExcerpt, normaliseTags } from '../src/lib/notes-store.ts';
import { notesServer } from '../src/servers/notes.ts';
import { TOOL_NAME_RE } from '../src/tools.ts';
import { bearer, call, connectClient, listTools, startTestServer, type RunningServer } from './helpers.ts';

const NOTE_ID = /^n_[a-z0-9]{6}$/;
const EXPECTED_TOOLS = ['create_note', 'list_notes', 'get_note', 'delete_note', 'get_current_time'];

describe('notes server', () => {
  let server: RunningServer;
  let client: Client;

  before(async () => {
    server = await startTestServer(notesServer);
    client = await connectClient(server.mcpUrl, bearer(server.token));
  });

  after(async () => {
    await client.close();
    await server.close();
  });

  test('lists exactly the contracted tools with title, description and annotations', async () => {
    const tools = await listTools(client);
    assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
    for (const tool of tools) {
      assert.match(tool.name, TOOL_NAME_RE);
      assert.ok(tool.title && tool.title.length > 0, `${tool.name} has a title`);
      assert.ok(tool.description && tool.description.length > 0, `${tool.name} has a description`);
      assert.equal(tool.inputSchema.type, 'object');
      const a = tool.annotations ?? {};
      assert.equal(typeof a.readOnlyHint, 'boolean', `${tool.name} readOnlyHint`);
      assert.equal(typeof a.destructiveHint, 'boolean', `${tool.name} destructiveHint`);
      assert.equal(typeof a.idempotentHint, 'boolean', `${tool.name} idempotentHint`);
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.equal(byName.delete_note?.annotations?.destructiveHint, true);
    assert.equal(byName.create_note?.annotations?.readOnlyHint, false);
    assert.equal(byName.list_notes?.annotations?.readOnlyHint, true);
    assert.equal(byName.get_note?.annotations?.readOnlyHint, true);
    assert.deepEqual(byName.get_current_time?.inputSchema.properties ?? {}, {});
  });

  test('create_note returns the stored note and structuredContent mirrors the text', async () => {
    const res = await call(client, 'create_note', {
      title: 'Standup',
      body: 'Discussed the Q4 launch.',
      tags: ['meeting', 'q4'],
    });
    assert.equal(res.isError, false);
    assert.deepEqual(JSON.parse(res.text), res.data);
    assert.match(String(res.data.id), NOTE_ID);
    assert.equal(res.data.title, 'Standup');
    assert.equal(res.data.body, 'Discussed the Q4 launch.');
    assert.deepEqual(res.data.tags, ['meeting', 'q4']);
    assert.ok(!Number.isNaN(Date.parse(String(res.data.created_at))), 'created_at is ISO');
  });

  test('create_note normalises tags and accepts an empty body', async () => {
    const res = await call(client, 'create_note', {
      title: 'Tags',
      body: '',
      tags: ['Work', ' work ', '', 'q4'],
    });
    assert.equal(res.isError, false);
    assert.deepEqual(res.data.tags, ['Work', 'q4']);
    assert.equal(res.data.body, '');
  });

  test('create_note rejects invalid input as a tool-level error', async () => {
    const res = await call(client, 'create_note', { body: 'no title' });
    assert.equal(res.isError, true);
    assert.match(res.text, /title/i);
    const tooLong = await call(client, 'create_note', { title: 'x'.repeat(201), body: '' });
    assert.equal(tooLong.isError, true);
  });

  test('list_notes returns newest first with excerpts, and filters by tag and search', async () => {
    const longBody = `${'lorem ipsum '.repeat(30)}END`;
    const older = await call(client, 'create_note', { title: 'Older', body: longBody, tags: ['Filter'] });
    const newer = await call(client, 'create_note', { title: 'Newer', body: 'Fresh note', tags: ['filter'] });

    const all = await call(client, 'list_notes');
    assert.equal(all.isError, false);
    const notes = all.data.notes as Array<Record<string, unknown>>;
    assert.equal(all.data.total, notes.length);
    assert.ok(notes.length >= 2);
    assert.equal(notes[0]?.id, newer.data.id, 'newest first');
    const olderSummary = notes.find((n) => n.id === older.data.id);
    assert.ok(olderSummary);
    assert.deepEqual(Object.keys(olderSummary).sort(), ['created_at', 'excerpt', 'id', 'tags', 'title']);
    assert.ok(String(olderSummary.excerpt).endsWith('...'));
    assert.ok(String(olderSummary.excerpt).length <= 123);

    const byTag = await call(client, 'list_notes', { tag: 'FILTER' });
    assert.equal(byTag.data.total, 2, 'tag filter is case-insensitive');

    const bySearch = await call(client, 'list_notes', { search: 'fresh NOTE' });
    assert.equal(bySearch.data.total, 1);
    assert.equal((bySearch.data.notes as Array<Record<string, unknown>>)[0]?.id, newer.data.id);

    const byTitle = await call(client, 'list_notes', { search: 'older' });
    assert.equal(byTitle.data.total, 1, 'search covers the title too');

    const both = await call(client, 'list_notes', { tag: 'filter', search: 'END' });
    assert.equal(both.data.total, 1);

    const none = await call(client, 'list_notes', { search: 'definitely-not-there' });
    assert.equal(none.data.total, 0);
    assert.deepEqual(none.data.notes, []);
  });

  test('get_note returns the full note; unknown id is a tool-level error', async () => {
    const created = await call(client, 'create_note', { title: 'Full', body: 'Body text', tags: [] });
    const got = await call(client, 'get_note', { id: created.data.id });
    assert.equal(got.isError, false);
    assert.deepEqual(got.data, created.data);

    const missing = await call(client, 'get_note', { id: 'n_000000' });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /Note not found/);
    assert.equal(missing.raw.structuredContent, undefined);
  });

  test('delete_note removes the note and reports unknown ids', async () => {
    const created = await call(client, 'create_note', { title: 'Doomed', body: 'bye' });
    const id = String(created.data.id);
    const deleted = await call(client, 'delete_note', { id });
    assert.equal(deleted.isError, false);
    assert.deepEqual(deleted.data, { deleted: true, id });

    const again = await call(client, 'delete_note', { id });
    assert.equal(again.isError, true);
    assert.match(again.text, /Note not found/);

    const gone = await call(client, 'get_note', { id });
    assert.equal(gone.isError, true);
  });

  test('get_current_time reports UTC and server=notes', async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await call(client, 'get_current_time');
    assert.equal(res.isError, false);
    assert.equal(res.data.timezone, 'UTC');
    assert.equal(res.data.server, 'notes');
    assert.match(String(res.data.iso), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const unix = Number(res.data.unix);
    assert.ok(unix >= before && unix <= before + 5, 'unix is now, in seconds');
    assert.equal(Math.floor(Date.parse(String(res.data.iso)) / 1000), unix);
  });

  test('state persists across requests (each POST builds a fresh McpServer)', async () => {
    const created = await call(client, 'create_note', { title: 'Persist', body: 'still here' });
    const second = await connectClient(server.mcpUrl, bearer(server.token));
    try {
      const got = await call(second, 'get_note', { id: created.data.id });
      assert.equal(got.isError, false);
      assert.equal(got.data.title, 'Persist');
    } finally {
      await second.close();
    }
  });
});

describe('notes store helpers', () => {
  test('normaliseTags trims, drops empties and de-duplicates case-insensitively', () => {
    assert.deepEqual(normaliseTags(['A', 'a', ' b ', '', 'B', 'c']), ['A', ' b '.trim(), 'c']);
    assert.deepEqual(normaliseTags(undefined), []);
  });

  test('makeExcerpt collapses whitespace and truncates to 120 chars', () => {
    assert.equal(makeExcerpt('  a   b\n\nc '), 'a b c');
    const long = 'x'.repeat(300);
    const excerpt = makeExcerpt(long);
    assert.equal(excerpt.length, 123);
    assert.ok(excerpt.endsWith('...'));
  });
});
