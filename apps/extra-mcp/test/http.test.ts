import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { notesServer } from '../src/servers/notes.ts';
import { selectDefinition } from '../src/servers/registry.ts';
import { utilsServer } from '../src/servers/utils.ts';
import {
  INITIALIZE_BODY,
  apiKey,
  bearer,
  rawPost,
  readJson,
  startTestServer,
  type RunningServer,
} from './helpers.ts';

describe('shared HTTP behaviour', () => {
  let notes: RunningServer;
  let utils: RunningServer;

  before(async () => {
    notes = await startTestServer(notesServer);
    utils = await startTestServer(utilsServer);
  });

  after(async () => {
    await notes.close();
    await utils.close();
  });

  test('healthz and readyz answer 200 {"ok":true,"server":...} without credentials', async () => {
    for (const [server, name] of [
      [notes, 'notes'],
      [utils, 'utils'],
    ] as Array<[RunningServer, string]>) {
      for (const path of ['/healthz', '/readyz']) {
        const res = await fetch(`${server.url}${path}`);
        assert.equal(res.status, 200, `${name} ${path}`);
        assert.deepEqual(await res.json(), { ok: true, server: name });
      }
    }
  });

  test('readyz flips to 503 once shutdown begins while healthz stays 200', async () => {
    const server = await startTestServer(utilsServer);
    try {
      server.extra.beginShutdown();
      const ready = await fetch(`${server.url}/readyz`);
      assert.equal(ready.status, 503);
      assert.equal((await readJson(ready)).ok, false);
      const live = await fetch(`${server.url}/healthz`);
      assert.equal(live.status, 200);
    } finally {
      await server.close();
    }
  });

  test('GET and DELETE /mcp answer 405 with Allow: POST', async () => {
    for (const method of ['GET', 'DELETE', 'PUT']) {
      const res = await fetch(notes.mcpUrl, {
        method,
        headers: { ...bearer(notes.token), Accept: 'application/json, text/event-stream' },
      });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.get('allow'), 'POST');
      const body = await readJson(res);
      assert.equal(body.jsonrpc, '2.0');
      assert.equal(body.error.code, -32000);
    }
    const anonymous = await fetch(utils.mcpUrl, { method: 'GET' });
    assert.equal(anonymous.status, 405);
  });

  test('POST /mcp initialize works over raw HTTP (stateless, SSE framed)', async () => {
    const res = await rawPost(utils.mcpUrl, INITIALIZE_BODY, apiKey(utils.token));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('mcp-session-id'), null, 'stateless: no session id');
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const body = await res.text();
    assert.ok(body.includes('"serverInfo"'), body);
    assert.ok(body.includes('"urumi-utils-mcp"'), body);
    assert.ok(body.includes('"tools"'), 'advertises the tools capability');
  });

  test('POST /mcp with malformed JSON answers a JSON-RPC parse error', async () => {
    const res = await rawPost(notes.mcpUrl, '{"jsonrpc": "2.0", "method": ', bearer(notes.token));
    assert.equal(res.status, 400);
    const body = await readJson(res);
    assert.equal(body.error.code, -32700);
    assert.equal(body.id, null);
  });

  test('POST /mcp with a missing credential is rejected before the body is parsed', async () => {
    const res = await rawPost(notes.mcpUrl, 'not json at all');
    assert.equal(res.status, 401);
    assert.equal((await readJson(res)).error, 'invalid_token');
  });

  test('POST /mcp without the dual Accept header answers 406 from the transport', async () => {
    const res = await fetch(utils.mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...apiKey(utils.token) },
      body: INITIALIZE_BODY,
    });
    assert.equal(res.status, 406);
    const body = await readJson(res);
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.error.code, -32000);
  });

  test('POST /mcp with a non-JSON content type answers 415', async () => {
    const res = await fetch(utils.mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Accept: 'application/json, text/event-stream',
        ...apiKey(utils.token),
      },
      body: INITIALIZE_BODY,
    });
    assert.equal(res.status, 415);
    await res.text();
  });

  test('unknown paths answer a JSON 404 and no x-powered-by header', async () => {
    const res = await fetch(`${notes.url}/nope`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found' });
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});

describe('SERVER selection (src/index.ts)', () => {
  test('resolves notes and utils, ignoring case and whitespace', () => {
    assert.equal(selectDefinition('notes').name, 'notes');
    assert.equal(selectDefinition(' UTILS '), utilsServer);
    assert.equal(selectDefinition('notes'), notesServer);
  });

  test('rejects anything else with a helpful message', () => {
    assert.throws(() => selectDefinition(undefined), /SERVER must be one of notes, utils \(got nothing\)/);
    assert.throws(() => selectDefinition('woo'), /got "woo"/);
    assert.throws(() => selectDefinition(''), /SERVER must be one of/);
  });
});
