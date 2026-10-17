import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { notesServer } from '../src/servers/notes.ts';
import { utilsServer } from '../src/servers/utils.ts';
import { apiKey, bearer, call, connectClient, listTools, startTestServer, type RunningServer } from './helpers.ts';

/**
 * The gateway namespaces tools as `<slug>__<name>`; both servers expose `get_current_time` on
 * purpose so the demo can show `notes__get_current_time` and `utils__get_current_time` side by side.
 */
describe('deliberate get_current_time collision', () => {
  let notes: RunningServer;
  let utils: RunningServer;
  let notesClient: Client;
  let utilsClient: Client;

  before(async () => {
    notes = await startTestServer(notesServer);
    utils = await startTestServer(utilsServer);
    notesClient = await connectClient(notes.mcpUrl, bearer(notes.token));
    utilsClient = await connectClient(utils.mcpUrl, apiKey(utils.token));
  });

  after(async () => {
    await notesClient.close();
    await utilsClient.close();
    await notes.close();
    await utils.close();
  });

  test('both servers list get_current_time with different input schemas', async () => {
    const fromNotes = (await listTools(notesClient)).find((t) => t.name === 'get_current_time');
    const fromUtils = (await listTools(utilsClient)).find((t) => t.name === 'get_current_time');
    assert.ok(fromNotes, 'notes lists get_current_time');
    assert.ok(fromUtils, 'utils lists get_current_time');
    assert.deepEqual(Object.keys(fromNotes.inputSchema.properties ?? {}), []);
    assert.deepEqual(Object.keys(fromUtils.inputSchema.properties ?? {}), ['timezone']);
    assert.notEqual(fromNotes.title, fromUtils.title);
  });

  test('the server field tells the results apart', async () => {
    const [a, b] = await Promise.all([
      call(notesClient, 'get_current_time'),
      call(utilsClient, 'get_current_time'),
    ]);
    assert.equal(a.isError, false);
    assert.equal(b.isError, false);
    assert.equal(a.data.server, 'notes');
    assert.equal(b.data.server, 'utils');
    assert.equal(a.data.timezone, 'UTC');
    assert.equal(b.data.timezone, 'UTC');
    assert.ok(Math.abs(Number(a.data.unix) - Number(b.data.unix)) <= 2, 'clocks agree');
    assert.ok(!('local' in a.data), 'notes has no local field');
    assert.ok('local' in b.data, 'utils adds a local field');
  });

  test('the two servers do not share credentials', async () => {
    assert.notEqual(notes.token, utils.token);
    await assert.rejects(connectClient(notes.mcpUrl, bearer(utils.token)));
    await assert.rejects(connectClient(utils.mcpUrl, apiKey(notes.token)));
  });
});
