import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { RATES_PER_USD, SUPPORTED_CURRENCIES, convertCurrency, describeRates } from '../src/lib/currency.ts';
import { formatInTimezone, utilsServer } from '../src/servers/utils.ts';
import { TOOL_NAME_RE } from '../src/tools.ts';
import { apiKey, call, connectClient, listTools, startTestServer, type RunningServer } from './helpers.ts';

const EXPECTED_TOOLS = ['get_current_time', 'calculate', 'convert_currency', 'generate_uuid'];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('utils server', () => {
  let server: RunningServer;
  let client: Client;

  before(async () => {
    server = await startTestServer(utilsServer);
    client = await connectClient(server.mcpUrl, apiKey(server.token));
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
      assert.equal(a.readOnlyHint, true, `${tool.name} is read-only`);
      assert.equal(a.destructiveHint, false, `${tool.name} is not destructive`);
      assert.equal(typeof a.idempotentHint, 'boolean', `${tool.name} idempotentHint`);
    }
    const convert = tools.find((t) => t.name === 'convert_currency');
    assert.ok(convert?.description?.includes(describeRates()), 'rates are documented in the description');
    for (const code of SUPPORTED_CURRENCIES) assert.ok(convert?.description?.includes(code));
    const time = tools.find((t) => t.name === 'get_current_time');
    assert.ok(time && 'timezone' in (time.inputSchema.properties ?? {}), 'utils get_current_time takes a timezone');
  });

  test('get_current_time defaults to UTC and reports server=utils', async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await call(client, 'get_current_time');
    assert.equal(res.isError, false);
    assert.deepEqual(JSON.parse(res.text), res.data);
    assert.equal(res.data.timezone, 'UTC');
    assert.equal(res.data.server, 'utils');
    assert.equal(res.data.utc_offset, '+00:00');
    assert.match(String(res.data.local), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /);
    const unix = Number(res.data.unix);
    assert.ok(unix >= before && unix <= before + 5);
  });

  test('get_current_time honours an IANA timezone', async () => {
    const res = await call(client, 'get_current_time', { timezone: 'Asia/Kolkata' });
    assert.equal(res.isError, false);
    assert.equal(res.data.timezone, 'Asia/Kolkata');
    assert.equal(res.data.utc_offset, '+05:30');
    assert.match(String(res.data.local), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /);
    const lower = await call(client, 'get_current_time', { timezone: 'utc' });
    assert.equal(lower.data.timezone, 'UTC');
  });

  test('get_current_time rejects an unknown timezone as a tool-level error', async () => {
    const res = await call(client, 'get_current_time', { timezone: 'Mars/Olympus_Mons' });
    assert.equal(res.isError, true);
    assert.match(res.text, /Unknown timezone "Mars\/Olympus_Mons"/);
    assert.equal(res.raw.structuredContent, undefined);
  });

  test('calculate evaluates the brief table', async () => {
    const table: Array<[string, number]> = [
      ['2+3*4', 14],
      ['(2+3)*4', 20],
      ['2^10', 1024],
      ['7%3', 1],
      ['-3+5', 2],
    ];
    for (const [expression, expected] of table) {
      const res = await call(client, 'calculate', { expression });
      assert.equal(res.isError, false, `${expression}: ${res.text}`);
      assert.deepEqual(res.data, { expression, result: expected });
      assert.deepEqual(JSON.parse(res.text), res.data);
    }
  });

  test('calculate reports bad expressions as tool-level errors', async () => {
    for (const [expression, pattern] of [
      ['1/0', /Division by zero/],
      ['2+', /Unexpected end/],
      ['abc', /Unexpected character/],
    ] as Array<[string, RegExp]>) {
      const res = await call(client, 'calculate', { expression });
      assert.equal(res.isError, true, `${expression} should fail`);
      assert.match(res.text, pattern);
      assert.ok(res.text.includes(expression));
    }
    const empty = await call(client, 'calculate', { expression: '' });
    assert.equal(empty.isError, true, 'empty expression fails schema validation');
  });

  test('convert_currency uses the static table, case-insensitively', async () => {
    const res = await call(client, 'convert_currency', { amount: 100, from: 'usd', to: 'inr' });
    assert.equal(res.isError, false);
    assert.deepEqual(res.data, {
      amount: 100,
      from: 'USD',
      to: 'INR',
      rate: 83.5,
      converted: 8350,
      rates_as_of: 'static table',
    });
    assert.deepEqual(JSON.parse(res.text), res.data);

    const cross = await call(client, 'convert_currency', { amount: 10, from: 'EUR', to: 'GBP' });
    assert.equal(cross.data.rate, 0.858696);
    assert.equal(cross.data.converted, 8.59);

    const same = await call(client, 'convert_currency', { amount: 42.5, from: 'JPY', to: 'JPY' });
    assert.equal(same.data.rate, 1);
    assert.equal(same.data.converted, 42.5);
  });

  test('convert_currency rejects unknown codes and negative amounts', async () => {
    const unknown = await call(client, 'convert_currency', { amount: 1, from: 'USD', to: 'XYZ' });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /Unknown currency code "XYZ"/);
    assert.ok(unknown.text.includes('USD, EUR, GBP, INR, JPY, AUD, CAD, SGD'));

    const negative = await call(client, 'convert_currency', { amount: -1, from: 'USD', to: 'EUR' });
    assert.equal(negative.isError, true, 'negative amounts fail schema validation');
  });

  test('generate_uuid returns fresh v4 UUIDs', async () => {
    const a = await call(client, 'generate_uuid');
    const b = await call(client, 'generate_uuid');
    assert.equal(a.isError, false);
    assert.match(String(a.data.uuid), UUID_V4);
    assert.match(String(b.data.uuid), UUID_V4);
    assert.notEqual(a.data.uuid, b.data.uuid);
    assert.deepEqual(Object.keys(a.data), ['uuid']);
  });

  test('unknown tool names are tool-level errors too', async () => {
    const res = await call(client, 'no_such_tool');
    assert.equal(res.isError, true);
    assert.match(res.text, /no_such_tool/);
  });
});

describe('currency table', () => {
  test('every supported code converts to and from USD', () => {
    for (const code of SUPPORTED_CURRENCIES) {
      const toCode = convertCurrency(1, 'USD', code);
      assert.equal(toCode.rate, RATES_PER_USD[code]);
      const back = convertCurrency(toCode.converted, code, 'USD');
      assert.ok(Math.abs(back.converted - 1) < 0.02, `${code} round-trips within rounding`);
    }
  });

  test('rejects NaN and infinite amounts', () => {
    assert.throws(() => convertCurrency(Number.NaN, 'USD', 'EUR'), /finite/);
    assert.throws(() => convertCurrency(Number.POSITIVE_INFINITY, 'USD', 'EUR'), /finite/);
  });
});

describe('formatInTimezone', () => {
  test('returns undefined for unknown zones and formats known ones', () => {
    assert.equal(formatInTimezone(new Date(), 'Nowhere/Land'), undefined);
    const fixed = new Date('2026-10-16T12:34:56Z');
    const utc = formatInTimezone(fixed, 'UTC');
    assert.ok(utc);
    assert.equal(utc.local.slice(0, 19), '2026-10-16 12:34:56');
    assert.equal(utc.utc_offset, '+00:00');
    const ny = formatInTimezone(fixed, 'America/New_York');
    assert.ok(ny);
    assert.equal(ny.local.slice(0, 19), '2026-10-16 08:34:56');
    assert.equal(ny.utc_offset, '-04:00');
    const kolkata = formatInTimezone(fixed, 'Asia/Kolkata');
    assert.ok(kolkata);
    assert.equal(kolkata.local.slice(0, 19), '2026-10-16 18:04:56');
    assert.equal(kolkata.utc_offset, '+05:30');
  });
});
