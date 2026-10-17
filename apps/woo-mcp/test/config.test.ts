import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ConfigError, loadConfig, parseAllowedOrigins } from '../src/config.ts';

const base = {
  WOO_BASE_URL: 'http://demo-wordpress:80/',
  WOO_USERNAME: 'mcp-bot',
  WOO_APP_PASSWORD: 'abcdEFGHijklMNOPqrstUVWX',
  MCP_AUTH_TOKEN: 'secret',
};

describe('config.loadConfig', () => {
  test('applies defaults and strips trailing slashes', () => {
    const c = loadConfig({ ...base });
    assert.equal(c.port, 8080);
    assert.equal(c.wooBaseUrl, 'http://demo-wordpress:80');
    assert.equal(c.storeUrl, 'http://demo-wordpress:80');
    assert.equal(c.storeName, 'WooCommerce store');
    assert.equal(c.wooTimeoutMs, 15_000);
    assert.equal(c.logLevel, 'info');
  });

  test('reads every documented variable', () => {
    const c = loadConfig({
      ...base,
      PORT: '9001',
      STORE_NAME: 'Demo Store',
      STORE_URL: 'http://store.127.0.0.1.nip.io/',
      WOO_TIMEOUT_MS: '2500',
      LOG_LEVEL: 'debug',
    });
    assert.equal(c.port, 9001);
    assert.equal(c.storeName, 'Demo Store');
    assert.equal(c.storeUrl, 'http://store.127.0.0.1.nip.io');
    assert.equal(c.wooTimeoutMs, 2500);
    assert.equal(c.logLevel, 'debug');
  });

  test('treats empty optional strings as unset', () => {
    const c = loadConfig({ ...base, STORE_NAME: '', STORE_URL: '  ', ALLOWED_ORIGINS: ' ' });
    assert.equal(c.storeName, 'WooCommerce store');
    assert.equal(c.storeUrl, 'http://demo-wordpress:80');
    assert.deepEqual(c.allowedOrigins, []);
  });

  test('ALLOWED_ORIGINS defaults to none and is parsed into normalised origins', () => {
    assert.deepEqual(loadConfig({ ...base }).allowedOrigins, []);
    const c = loadConfig({
      ...base,
      ALLOWED_ORIGINS: 'https://Chat.Example.com:443/some/path, http://localhost:3000 ,,http://localhost:3000/',
    });
    assert.deepEqual(c.allowedOrigins, ['https://chat.example.com', 'http://localhost:3000']);
    assert.deepEqual(parseAllowedOrigins(undefined), []);
    assert.deepEqual(parseAllowedOrigins('http://a:8080'), ['http://a:8080']);
    assert.throws(
      () => loadConfig({ ...base, ALLOWED_ORIGINS: 'https://ok.example, not-an-origin, ftp://x' }),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /ALLOWED_ORIGINS/);
        assert.match(err.message, /"not-an-origin"/);
        assert.match(err.message, /"ftp:\/\/x"/);
        return true;
      },
    );
  });

  test('lists every missing or invalid variable in one error', () => {
    assert.throws(
      () => loadConfig({ WOO_BASE_URL: 'ftp://x', PORT: 'abc' }),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /WOO_BASE_URL/);
        assert.match(err.message, /WOO_USERNAME/);
        assert.match(err.message, /WOO_APP_PASSWORD/);
        assert.match(err.message, /MCP_AUTH_TOKEN/);
        assert.match(err.message, /PORT/);
        return true;
      },
    );
  });
});
