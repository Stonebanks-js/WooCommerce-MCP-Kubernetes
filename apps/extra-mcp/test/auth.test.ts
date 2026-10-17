import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { notesServer } from '../src/servers/notes.ts';
import { utilsServer } from '../src/servers/utils.ts';
import { UNAUTHORIZED_DESCRIPTION, parseAllowedOrigins, safeEqual } from '../src/server.ts';
import {
  INITIALIZE_BODY,
  apiKey,
  bearer,
  connectClient,
  listTools,
  rawPost,
  readJson,
  startTestServer,
  type RunningServer,
} from './helpers.ts';

async function expect401(mcpUrl: string, headers: Record<string, string>): Promise<void> {
  await assert.rejects(
    connectClient(mcpUrl, headers),
    (err: unknown) => {
      assert.ok(err instanceof StreamableHTTPError, `expected StreamableHTTPError, got ${String(err)}`);
      assert.equal(err.code, 401);
      // The SDK surfaces the body in the message; Claude Code prints error_description.
      assert.match(err.message, /invalid_token/);
      return true;
    },
  );
}

/** docs/contracts.md §3: RFC 6750 challenge without resource_metadata + JSON body. */
export async function expectUnauthorizedShape(res: Response): Promise<void> {
  assert.equal(res.status, 401);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  assert.equal(
    res.headers.get('www-authenticate'),
    `Bearer error="invalid_token", error_description="${UNAUTHORIZED_DESCRIPTION}"`,
  );
  assert.ok(!(res.headers.get('www-authenticate') ?? '').includes('resource_metadata'));
  assert.deepEqual(await res.json(), { error: 'invalid_token', error_description: UNAUTHORIZED_DESCRIPTION });
}

describe('auth: notes requires a bearer token', () => {
  let server: RunningServer;

  before(async () => {
    server = await startTestServer(notesServer);
  });

  after(async () => {
    await server.close();
  });

  test('accepts the correct bearer (scheme is case-insensitive)', async () => {
    const client = await connectClient(server.mcpUrl, bearer(server.token));
    assert.ok((await listTools(client)).length > 0);
    await client.close();

    const lower = await connectClient(server.mcpUrl, { Authorization: `bearer ${server.token}` });
    assert.ok((await listTools(lower)).length > 0);
    await lower.close();
  });

  test('rejects a missing credential', async () => {
    await expect401(server.mcpUrl, {});
  });

  test('rejects the right token sent as X-Api-Key', async () => {
    await expect401(server.mcpUrl, apiKey(server.token));
  });

  test('rejects a wrong bearer, a token with extra characters, and a non-bearer scheme', async () => {
    await expect401(server.mcpUrl, bearer(`${server.token}x`));
    await expect401(server.mcpUrl, bearer(server.token.slice(0, -1)));
    await expect401(server.mcpUrl, { Authorization: `Basic ${server.token}` });
    await expect401(server.mcpUrl, { Authorization: 'Bearer' });
  });

  test('401 carries the RFC 6750 challenge (no resource_metadata) and a JSON body', async () => {
    const res = await rawPost(server.mcpUrl, INITIALIZE_BODY);
    await expectUnauthorizedShape(res);
  });

  test('a wrong bearer gets the same 401 shape as a missing one', async () => {
    const res = await rawPost(server.mcpUrl, INITIALIZE_BODY, bearer('nope'));
    await expectUnauthorizedShape(res);
  });
});

describe('auth: Origin header (DNS-rebinding protection)', () => {
  let server: RunningServer;
  let strict: RunningServer;

  before(async () => {
    server = await startTestServer(notesServer, undefined, ['https://app.example.com', 'http://localhost:5173/']);
    strict = await startTestServer(utilsServer); // default: no origins allowed
  });

  after(async () => {
    await server.close();
    await strict.close();
  });

  test('no Origin header: unaffected', async () => {
    const client = await connectClient(server.mcpUrl, bearer(server.token));
    assert.ok((await listTools(client)).length > 0);
    await client.close();
  });

  test('allowed Origin (case-insensitive, trailing slash ignored) passes through to auth', async () => {
    for (const origin of ['https://app.example.com', 'HTTPS://APP.EXAMPLE.COM/', 'http://localhost:5173']) {
      const ok = await rawPost(server.mcpUrl, INITIALIZE_BODY, { ...bearer(server.token), Origin: origin });
      assert.equal(ok.status, 200, origin);
      await ok.text();
    }
    const unauthorized = await rawPost(server.mcpUrl, INITIALIZE_BODY, { Origin: 'https://app.example.com' });
    assert.equal(unauthorized.status, 401, 'origin ok but credential missing');
    await unauthorized.text();
  });

  test('disallowed Origin answers 403 JSON even with a valid credential, before auth and for any method', async () => {
    const res = await rawPost(server.mcpUrl, INITIALIZE_BODY, { ...bearer(server.token), Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const body = await readJson(res);
    assert.equal(body.error, 'forbidden');
    assert.match(String(body.error_description), /evil\.example/);

    const noCred = await rawPost(server.mcpUrl, INITIALIZE_BODY, { Origin: 'https://evil.example' });
    assert.equal(noCred.status, 403, 'origin is checked before the credential');
    await noCred.text();

    const get = await fetch(server.mcpUrl, { method: 'GET', headers: { Origin: 'https://evil.example' } });
    assert.equal(get.status, 403, 'GET with a bad Origin is 403, not 405');
    await get.text();
  });

  test('default configuration rejects every Origin, including null', async () => {
    for (const origin of ['http://localhost:8080', 'null']) {
      const res = await rawPost(strict.mcpUrl, INITIALIZE_BODY, { ...apiKey(strict.token), Origin: origin });
      assert.equal(res.status, 403, origin);
      await res.text();
    }
  });

  test('parseAllowedOrigins splits, trims, lower-cases and drops blanks', () => {
    assert.deepEqual(parseAllowedOrigins(undefined), []);
    assert.deepEqual(parseAllowedOrigins(''), []);
    assert.deepEqual(parseAllowedOrigins(' https://A.example/ ,, http://b:81'), ['https://a.example', 'http://b:81']);
  });
});

describe('auth: utils requires X-Api-Key', () => {
  let server: RunningServer;

  before(async () => {
    server = await startTestServer(utilsServer);
  });

  after(async () => {
    await server.close();
  });

  test('accepts X-Api-Key (header name is case-insensitive)', async () => {
    const client = await connectClient(server.mcpUrl, apiKey(server.token));
    assert.ok((await listTools(client)).length > 0);
    await client.close();

    const lower = await connectClient(server.mcpUrl, { 'x-api-key': server.token });
    assert.ok((await listTools(lower)).length > 0);
    await lower.close();
  });

  test('rejects the right token sent as a bearer', async () => {
    await expect401(server.mcpUrl, bearer(server.token));
  });

  test('rejects a missing, empty or wrong X-Api-Key', async () => {
    await expect401(server.mcpUrl, {});
    await expect401(server.mcpUrl, { 'X-Api-Key': '' });
    await expect401(server.mcpUrl, apiKey(`${server.token}x`));
  });

  test('401 shape is the same as on notes (challenge header + JSON body)', async () => {
    const res = await rawPost(server.mcpUrl, INITIALIZE_BODY, bearer(server.token));
    await expectUnauthorizedShape(res);
  });
});

describe('safeEqual', () => {
  test('compares strings of different lengths without throwing', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('', 'a'), false);
    assert.equal(safeEqual('', ''), true);
  });
});
