import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, setUnauthorizedHandler } from './api.js';

type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];
const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>();

function respond(status: number, body: unknown, contentType = 'application/json'): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': contentType } });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});

describe('api error mapping', () => {
  it('turns a JSON {error,message} body into an ApiError with that message and code', async () => {
    fetchMock.mockResolvedValueOnce(respond(403, { error: 'forbidden', message: 'Admins only' }));
    const err = await api.users.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.message).toBe('Admins only');
    expect(apiErr.code).toBe('forbidden');
    expect(apiErr.status).toBe(403);
  });

  it('falls back to the HTTP status when the body is not the contract error shape', async () => {
    fetchMock.mockResolvedValueOnce(respond(502, '<html>Bad gateway</html>', 'text/html'));
    const err = await api.servers.list().then(() => null, (e: unknown) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err?.status).toBe(502);
    expect(err?.code).toBe('http_502');
    expect(err?.message).toContain('Bad gateway');
  });

  it('maps a network failure to a readable ApiError', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const err = await api.keys.list().then(() => null, (e: unknown) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err?.status).toBe(0);
    expect(err?.code).toBe('network_error');
  });

  it('invokes the unauthorized handler on a 401 from a session route, but not for login', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    fetchMock.mockResolvedValueOnce(respond(401, { error: 'unauthorized', message: 'Session expired' }));
    await expect(api.servers.list()).rejects.toMatchObject({ status: 401, message: 'Session expired' });
    expect(handler).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(respond(401, { error: 'invalid_credentials', message: 'Wrong password' }));
    await expect(api.auth.login('a@b.c', 'nope')).rejects.toMatchObject({ message: 'Wrong password' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('sends JSON with credentials and parses the success body', async () => {
    fetchMock.mockResolvedValueOnce(respond(201, { key: { id: 'k1', prefix: 'gw_abc' }, plaintext: 'gw_abc_secret' }));
    const result = await api.keys.create('laptop');
    expect(result.plaintext).toBe('gw_abc_secret');
    const [url, init] = fetchMock.mock.calls[0] as FetchArgs;
    expect(url).toBe('/api/keys');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
    expect(init?.body).toBe(JSON.stringify({ name: 'laptop' }));
  });

  it('serialises audit filters into the query string and drops empty ones', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { entries: [], nextBefore: null }));
    await api.audit.list({ limit: 50, before: 1040, outcome: 'error', source: undefined, serverId: '' });
    const [url] = fetchMock.mock.calls[0] as FetchArgs;
    expect(url).toBe('/api/audit?limit=50&before=1040&outcome=error');
  });
});
