import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateApiKey, hashApiKey, hashesEqual, parseApiKey } from './apikeys.ts';
import { hashPassword, verifyPassword } from './password.ts';
import { decryptSecret, encryptSecret, parseEncryptionKey } from './secretbox.ts';

test('password hash uses the documented scrypt format and verifies', async () => {
  const h = await hashPassword('correct horse');
  assert.match(h, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(Buffer.from(h.split('$')[4] ?? '', 'base64').length, 16, '16-byte salt');
  assert.equal(Buffer.from(h.split('$')[5] ?? '', 'base64').length, 64, '64-byte key');
  assert.ok(await verifyPassword('correct horse', h));
  assert.ok(!(await verifyPassword('wrong', h)));
  assert.ok(!(await verifyPassword('correct horse', null)));
  assert.ok(!(await verifyPassword('correct horse', 'garbage')));
  assert.notEqual(await hashPassword('correct horse'), h, 'fresh salt each time');
});

test('api keys: gw_ + 8 alnum + _ + 32 base64url; only the sha256 is stored', () => {
  const k = generateApiKey();
  assert.match(k.plaintext, /^gw_[a-z0-9]{8}_[A-Za-z0-9_-]{32}$/);
  assert.equal(k.prefix, k.plaintext.slice(0, 11));
  assert.equal(k.hash, hashApiKey(k.plaintext));
  assert.match(k.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(parseApiKey(k.plaintext), { prefix: k.prefix });
  assert.equal(parseApiKey('gw_short'), null);
  assert.equal(parseApiKey(`${k.plaintext}x`), null);
  assert.ok(hashesEqual(k.hash, hashApiKey(k.plaintext)));
  assert.ok(!hashesEqual(k.hash, hashApiKey(`${k.plaintext}x`)));
  assert.ok(!hashesEqual(k.hash, 'ab'));
});

test('secretbox round trip, format, and tamper detection', () => {
  const key = parseEncryptionKey(Buffer.alloc(32, 7).toString('base64'));
  const enc = encryptSecret('s3cret-token', key);
  assert.match(enc, /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*:[A-Za-z0-9+/=]+$/);
  assert.equal(decryptSecret(enc, key), 's3cret-token');
  assert.notEqual(encryptSecret('s3cret-token', key), enc, 'random iv');

  const parts = enc.split(':');
  const ct = Buffer.from(parts[2] ?? '', 'base64');
  if (ct.length > 0) ct[0] = (ct[0] ?? 0) ^ 0xff;
  parts[2] = ct.toString('base64');
  assert.throws(() => decryptSecret(parts.join(':'), key));
  const other = parseEncryptionKey(Buffer.alloc(32, 8).toString('base64'));
  assert.throws(() => decryptSecret(enc, other));
  assert.throws(() => decryptSecret('v0:a:b:c', key));
  assert.throws(() => parseEncryptionKey(Buffer.alloc(16, 1).toString('base64')));
});
