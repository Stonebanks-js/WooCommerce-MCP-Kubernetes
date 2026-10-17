import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UpstreamUrlError, classifyAddress, validateUpstreamUrl, type ResolvedAddress } from './ssrf.ts';

const resolver =
  (table: Record<string, string[]>) =>
  async (host: string): Promise<ResolvedAddress[]> => {
    const ips = table[host];
    if (!ips) throw new Error('ENOTFOUND');
    return ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };

const lookup = resolver({
  'api.example.com': ['93.184.216.34'],
  'meta.evil.example': ['169.254.169.254'],
  'demo-woo-mcp.store-demo.svc.cluster.local': ['10.96.0.12'],
  'internal.corp': ['10.1.2.3'],
  'v6.example': ['2606:4700::1111'],
  'loop.example': ['::1'],
  'mapped.example': ['::ffff:10.0.0.1'],
});
const strict = { allowPrivate: false, allowedSuffixes: ['.svc.cluster.local', '.svc'], lookup };
const dev = { ...strict, allowPrivate: true };

const rejects = (url: string, opts: typeof strict, re: RegExp) => assert.rejects(validateUpstreamUrl(url, opts), (e) => e instanceof UpstreamUrlError && re.test(e.message));

test('classifies addresses', () => {
  assert.equal(classifyAddress('127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('169.254.169.254'), 'link_local');
  assert.equal(classifyAddress('10.0.0.1'), 'private');
  assert.equal(classifyAddress('172.16.5.5'), 'private');
  assert.equal(classifyAddress('192.168.1.1'), 'private');
  assert.equal(classifyAddress('100.64.0.1'), 'private');
  assert.equal(classifyAddress('0.0.0.0'), 'unspecified');
  assert.equal(classifyAddress('224.0.0.1'), 'multicast');
  assert.equal(classifyAddress('8.8.8.8'), 'public');
  assert.equal(classifyAddress('::1'), 'loopback');
  assert.equal(classifyAddress('fe80::1'), 'link_local');
  assert.equal(classifyAddress('fd12::1'), 'private');
  assert.equal(classifyAddress('ff02::1'), 'multicast');
  assert.equal(classifyAddress('::ffff:169.254.169.254'), 'link_local');
  assert.equal(classifyAddress('2606:4700::1111'), 'public');
});

test('rejects non-http schemes, credentials and empty hosts', async () => {
  await rejects('ftp://api.example.com/mcp', strict, /http or https/);
  await rejects('file:///etc/passwd', strict, /http or https/);
  await rejects('http://user:pw@api.example.com/mcp', strict, /credentials/);
  await rejects('not a url', strict, /not valid/);
});

test('localhost is rejected unless private upstreams are allowed', async () => {
  await rejects('http://localhost:8080/mcp', strict, /localhost/);
  await rejects('http://foo.localhost/mcp', strict, /localhost/);
  await rejects('http://127.0.0.1:8080/mcp', strict, /loopback/);
  assert.ok(await validateUpstreamUrl('http://127.0.0.1:8080/mcp', dev));
  assert.ok(await validateUpstreamUrl('http://localhost:8080/mcp', dev));
  assert.ok(await validateUpstreamUrl('http://loop.example/mcp', dev));
});

test('metadata / link-local addresses are never allowed', async () => {
  await rejects('http://169.254.169.254/latest/meta-data', strict, /link-local/);
  await rejects('http://169.254.169.254/latest/meta-data', dev, /link-local/);
  await rejects('http://meta.evil.example/mcp', dev, /link-local/);
  await rejects('http://mapped.example/mcp', strict, /private/);
  await rejects('http://[fe80::1]/mcp', dev, /link-local/);
  await rejects('http://0.0.0.0/mcp', dev, /unspecified/);
});

test('private ranges: rejected by default, allowed with ALLOW_PRIVATE_UPSTREAMS or an internal suffix', async () => {
  await rejects('http://internal.corp/mcp', strict, /private/);
  await rejects('http://10.1.2.3:8080/mcp', strict, /private/);
  assert.ok(await validateUpstreamUrl('http://internal.corp/mcp', dev));
  assert.ok(await validateUpstreamUrl('http://10.1.2.3:8080/mcp', dev));
  assert.ok(await validateUpstreamUrl('http://demo-woo-mcp.store-demo.svc.cluster.local:8080/mcp', strict));
  await rejects('http://demo-woo-mcp.store-demo.svc.cluster.local:8080/mcp', { ...strict, allowedSuffixes: [] }, /private/);
});

test('public addresses pass; unresolvable hosts pass hostname checks (re-checked at connect)', async () => {
  assert.ok(await validateUpstreamUrl('https://api.example.com/mcp', strict));
  assert.ok(await validateUpstreamUrl('https://v6.example/mcp', strict));
  assert.ok(await validateUpstreamUrl('https://does-not-exist.example/mcp', strict));
});
