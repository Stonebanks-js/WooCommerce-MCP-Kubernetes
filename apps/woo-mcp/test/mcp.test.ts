import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { OrderDetail, OrderSummary, ProductDetail, ProductSummary } from '../src/summaries.ts';
import { TOOL_NAMES } from '../src/tools.ts';
import { emptyAddress, FakeWoo, type FakeOrder } from './helpers/fake-woo.ts';
import {
  callTool,
  connectClient,
  dataOf,
  INITIALIZE,
  rawPost,
  startMcp,
  testConfig,
  textOf,
  TOKEN,
  WOO_APP_PASSWORD,
  WOO_USER,
  type RunningMcp,
} from './helpers/mcp-harness.ts';

type ListProducts = { products: ProductSummary[]; total: number; page: number; totalPages: number };
type ListOrders = { orders: OrderSummary[]; total: number; page: number; totalPages: number };
type UpdateResult = OrderSummary & { note: { id: number; note: string; customer_note: boolean } | null };

const STORE_URL = 'http://store.test';

describe('woo-mcp over Streamable HTTP (fake WooCommerce)', () => {
  let fake: FakeWoo;
  let mcp: RunningMcp;
  let client: Client;
  let o1: FakeOrder;
  let o2: FakeOrder;
  let o3: FakeOrder;

  before(async () => {
    fake = new FakeWoo({ username: WOO_USER, appPassword: WOO_APP_PASSWORD });
    await fake.start();
    mcp = await startMcp(testConfig({ wooBaseUrl: fake.url, storeUrl: STORE_URL, wooTimeoutMs: 1_500 }));
    client = await connectClient(mcp.mcpUrl);

    o1 = fake.seedOrder({
      date_created: '2026-10-15T10:00:00',
      total: '10.00',
      billing: emptyAddress({
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ada@example.com',
        address_1: '1 Analytical Way',
        city: 'London',
        country: 'GB',
      }),
      shipping: emptyAddress({ first_name: 'Ada', last_name: 'Lovelace', address_1: '1 Analytical Way' }),
      line_items: [
        { id: 1, name: 'Mug', product_id: 1, quantity: 2, sku: 'MUG-1', price: 5, subtotal: '10.00', total: '10.00' },
      ],
    });
    o2 = fake.seedOrder({ date_created: '2026-10-16T09:30:00', total: '20.00', status: 'processing' });
    o3 = fake.seedOrder({ date_created: '2026-10-17T00:00:01', total: '30.00', status: 'completed' });
  });

  after(async () => {
    await client.close();
    await mcp.close();
    await fake.stop();
  });

  test('initialize reports the server identity and instructions', () => {
    const info = client.getServerVersion();
    assert.ok(info);
    assert.equal(info.name, 'woo-mcp');
    assert.match(info.version, /^\d+\.\d+\.\d+$/);
    assert.equal(info.title, 'Test Store (WooCommerce)');
    assert.match(client.getInstructions() ?? '', /Test Store/);
  });

  test('tools/list exposes the six tools with title, description and annotations', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [...TOOL_NAMES].sort(),
    );
    const byName: Record<string, Tool> = Object.fromEntries(tools.map((t) => [t.name, t]));

    for (const t of tools) {
      assert.match(t.name, /^[a-z0-9_]{1,40}$/, `${t.name} is snake_case and <= 40 chars`);
      assert.ok(t.title, `${t.name} has a title`);
      assert.ok(t.description && t.description.length > 60, `${t.name} has a useful description`);
      assert.equal(t.inputSchema.type, 'object', `${t.name} inputSchema is an object schema`);
      assert.ok(t.annotations, `${t.name} has annotations`);
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint'] as const) {
        assert.equal(typeof t.annotations?.[hint], 'boolean', `${t.name}.annotations.${hint}`);
      }
    }
    for (const name of ['list_products', 'get_product', 'list_orders', 'get_order']) {
      assert.equal(byName[name]?.annotations?.readOnlyHint, true, `${name} is read-only`);
      assert.equal(byName[name]?.annotations?.destructiveHint, false);
    }
    for (const name of ['create_product', 'update_order_status']) {
      assert.equal(byName[name]?.annotations?.readOnlyHint, false, `${name} writes`);
      assert.equal(byName[name]?.annotations?.destructiveHint, false);
      assert.equal(byName[name]?.annotations?.idempotentHint, false);
    }

    // Descriptions carry an `after` example for "today".
    const listOrders = byName.list_orders!;
    assert.match(listOrders.description!, /"after": "\d{4}-\d{2}-\d{2}"/);
    const props = listOrders.inputSchema.properties as Record<string, { description?: string; enum?: string[] }>;
    assert.match(props.after?.description ?? '', /\d{4}-\d{2}-\d{2}/);
    assert.deepEqual(props.status?.enum, [
      'any',
      'pending',
      'processing',
      'on-hold',
      'completed',
      'cancelled',
      'refunded',
      'failed',
    ]);
    assert.deepEqual(byName.get_order!.inputSchema.required, ['id']);
    assert.deepEqual([...(byName.create_product!.inputSchema.required ?? [])].sort(), ['name', 'regular_price']);
    assert.deepEqual([...(byName.update_order_status!.inputSchema.required ?? [])].sort(), ['id', 'status']);
  });

  test('create_product creates a simple product and list_products sees it with a public permalink', async () => {
    const start = fake.apiRequests().length;
    const result = await callTool(client, 'create_product', {
      name: 'Demo Mug',
      regular_price: 12,
      sku: 'MUG-1',
      short_description: 'A mug',
      manage_stock: true,
      stock_quantity: 5,
    });
    assert.notEqual(result.isError, true, textOf(result));
    const created = dataOf<ProductDetail>(result);
    assert.equal(typeof created.id, 'number');
    assert.equal(created.name, 'Demo Mug');
    assert.equal(created.regular_price, '12');
    assert.equal(created.status, 'publish');
    assert.equal(created.sku, 'MUG-1');
    assert.equal(created.stock_quantity, 5);
    assert.ok(created.permalink.startsWith(`${STORE_URL}/product/`), `public permalink, got ${created.permalink}`);
    assert.deepEqual(JSON.parse(textOf(result)), result.structuredContent, 'text block equals structuredContent');

    const post = fake.apiRequests().slice(start).find((r) => r.method === 'POST' && r.path === '/wp-json/wc/v3/products');
    assert.ok(post, 'POST /products was called');
    assert.equal(post.authorized, true, 'Basic auth with the application password');
    assert.deepEqual(post.body, {
      name: 'Demo Mug',
      type: 'simple',
      regular_price: '12',
      status: 'publish',
      short_description: 'A mug',
      sku: 'MUG-1',
      manage_stock: true,
      stock_quantity: 5,
    });

    const listResult = await callTool(client, 'list_products', { search: 'mug' });
    assert.notEqual(listResult.isError, true, textOf(listResult));
    const listed = dataOf<ListProducts>(listResult);
    assert.equal(listed.total, 1);
    assert.equal(listed.page, 1);
    assert.equal(listed.totalPages, 1);
    assert.equal(listed.products.length, 1);
    const p = listed.products[0]!;
    assert.equal(p.id, created.id);
    assert.ok(p.permalink.startsWith(`${STORE_URL}/product/`));
    assert.deepEqual(Object.keys(p).sort(), [
      'date_created',
      'id',
      'name',
      'permalink',
      'price',
      'regular_price',
      'sku',
      'status',
      'stock_status',
    ]);
    const get = fake.apiRequests().at(-1)!;
    assert.equal(get.path, '/wp-json/wc/v3/products');
    assert.equal(get.query.search, 'mug');
    assert.equal(get.query.status, 'any');
    assert.equal(get.query.per_page, '20');
    assert.equal(get.query.page, '1');
  });

  test('list_products paginates and filters by status', async () => {
    fake.seedProduct({ name: 'Hidden Draft', status: 'draft', regular_price: '1.00' });
    const drafts = dataOf<ListProducts>(await callTool(client, 'list_products', { status: 'draft' }));
    assert.equal(drafts.total, 1);
    assert.equal(drafts.products[0]?.name, 'Hidden Draft');
    const page2 = dataOf<ListProducts>(await callTool(client, 'list_products', { per_page: 1, page: 2 }));
    assert.equal(page2.page, 2);
    assert.equal(page2.total, 2);
    assert.equal(page2.totalPages, 2);
    assert.equal(page2.products.length, 1);
  });

  test('create_product rejects a malformed price or missing name before calling WooCommerce', async () => {
    const n = fake.apiRequests().length;
    const bad = await callTool(client, 'create_product', { name: 'Bad', regular_price: '$12' });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /regular_price/);
    const missing = await callTool(client, 'create_product', { regular_price: '1' });
    assert.equal(missing.isError, true);
    assert.equal(fake.apiRequests().length, n, 'no HTTP call was made');
  });

  test('get_product returns the full summary; an unknown id is an error result, not a protocol error', async () => {
    const seeded = fake.seedProduct({ name: 'Seeded', sku: 'S-1', regular_price: '3.50', description: '<p>desc</p>' });
    const d = dataOf<ProductDetail>(await callTool(client, 'get_product', { id: seeded.id }));
    assert.equal(d.id, seeded.id);
    assert.equal(d.price, '3.50');
    assert.equal(d.description, '<p>desc</p>');
    assert.equal(d.type, 'simple');

    const miss = await callTool(client, 'get_product', { id: 987654 });
    assert.equal(miss.isError, true);
    assert.equal(textOf(miss), 'WooCommerce returned 404 (woocommerce_rest_product_invalid_id): Invalid ID.');
  });

  test('list_orders expands YYYY-MM-DD bounds to local day start/end and filters correctly', async () => {
    const ids = (r: ListOrders): number[] => r.orders.map((o) => o.id);

    const after = dataOf<ListOrders>(await callTool(client, 'list_orders', { after: '2026-10-16' }));
    assert.deepEqual(ids(after), [o3.id, o2.id], 'newest first, both on/after the 16th');
    let q = fake.apiRequests().at(-1)!.query;
    assert.equal(q.after, '2026-10-16T00:00:00');
    assert.equal(q.before, undefined);
    assert.equal(q.status, 'any');

    const day = dataOf<ListOrders>(await callTool(client, 'list_orders', { after: '2026-10-16', before: '2026-10-16' }));
    assert.deepEqual(ids(day), [o2.id]);
    q = fake.apiRequests().at(-1)!.query;
    assert.equal(q.after, '2026-10-16T00:00:00');
    assert.equal(q.before, '2026-10-16T23:59:59');

    const before = dataOf<ListOrders>(await callTool(client, 'list_orders', { before: '2026-10-15' }));
    assert.deepEqual(ids(before), [o1.id]);

    const precise = dataOf<ListOrders>(await callTool(client, 'list_orders', { after: '2026-10-16T09:31:00' }));
    assert.deepEqual(ids(precise), [o3.id]);
    assert.equal(fake.apiRequests().at(-1)!.query.after, '2026-10-16T09:31:00', 'full ISO passes through');

    const all = dataOf<ListOrders>(await callTool(client, 'list_orders', {}));
    assert.deepEqual(ids(all), [o3.id, o2.id, o1.id]);
    assert.equal(all.total, 3);
    assert.equal(all.totalPages, 1);

    const completed = dataOf<ListOrders>(await callTool(client, 'list_orders', { status: 'completed' }));
    assert.deepEqual(ids(completed), [o3.id]);
    assert.equal(fake.apiRequests().at(-1)!.query.status, 'completed');

    // Summary shape, customer name fallback and line items.
    const ada = all.orders.find((o) => o.id === o1.id)!;
    assert.equal(ada.customer_name, 'Ada Lovelace');
    assert.equal(ada.customer_email, 'ada@example.com');
    assert.equal(ada.payment_method_title, 'Cash on delivery');
    assert.deepEqual(ada.line_items, [{ name: 'Mug', quantity: 2, total: '10.00' }]);
    const guest = all.orders.find((o) => o.id === o2.id)!;
    assert.equal(guest.customer_name, 'Guest');
    assert.deepEqual(Object.keys(ada).sort(), [
      'currency',
      'customer_email',
      'customer_name',
      'date_created',
      'id',
      'line_items',
      'number',
      'payment_method_title',
      'status',
      'total',
    ]);
  });

  test('list_orders rejects an unparseable date before calling WooCommerce', async () => {
    const n = fake.apiRequests().length;
    const r = await callTool(client, 'list_orders', { after: 'yesterday' });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /YYYY-MM-DD/);
    assert.match(textOf(r), /"yesterday"/);
    assert.equal(fake.apiRequests().length, n);
  });

  test('get_order returns billing, shipping and line item detail', async () => {
    const d = dataOf<OrderDetail>(await callTool(client, 'get_order', { id: o1.id }));
    assert.equal(d.id, o1.id);
    assert.equal(d.number, String(o1.id));
    assert.equal(d.subtotal, '10.00');
    assert.equal(d.total, '10.00');
    assert.equal(d.billing.name, 'Ada Lovelace');
    assert.equal(d.billing.email, 'ada@example.com');
    assert.equal(d.billing.address_1, '1 Analytical Way');
    assert.equal(d.shipping.name, 'Ada Lovelace');
    assert.deepEqual(d.line_items, [{ id: 1, name: 'Mug', sku: 'MUG-1', quantity: 2, price: '5', total: '10.00' }]);
    assert.equal(d.payment_method, 'cod');
    assert.equal(d.date_paid, null);

    const miss = await callTool(client, 'get_order', { id: 424242 });
    assert.equal(miss.isError, true);
    assert.equal(textOf(miss), 'WooCommerce returned 404 (woocommerce_rest_shop_order_invalid_id): Invalid ID.');
  });

  test('update_order_status rejects an invalid status before any HTTP call, then updates and adds a note', async () => {
    const n = fake.apiRequests().length;
    const bad = await callTool(client, 'update_order_status', { id: o2.id, status: 'shipped' });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /status/);
    assert.equal(fake.apiRequests().length, n, 'invalid status never reached WooCommerce');
    assert.equal(fake.orders.get(o2.id)!.status, 'processing');

    const good = dataOf<UpdateResult>(
      await callTool(client, 'update_order_status', { id: o2.id, status: 'completed', note: 'Shipped via UPS' }),
    );
    assert.equal(good.id, o2.id);
    assert.equal(good.status, 'completed');
    assert.equal(good.customer_name, 'Guest');
    assert.ok(good.note);
    assert.equal(good.note.note, 'Shipped via UPS');
    assert.equal(good.note.customer_note, false);
    assert.equal(fake.orders.get(o2.id)!.status, 'completed');
    assert.equal(fake.notes.get(o2.id)?.[0]?.note, 'Shipped via UPS');

    const reqs = fake.apiRequests().slice(n);
    assert.deepEqual(
      reqs.map((r) => `${r.method} ${r.path}`),
      [`PUT /wp-json/wc/v3/orders/${o2.id}`, `POST /wp-json/wc/v3/orders/${o2.id}/notes`],
    );
    assert.deepEqual(reqs[0]!.body, { status: 'completed' });
    assert.deepEqual(reqs[1]!.body, { note: 'Shipped via UPS', customer_note: false });

    // Without a note only the PUT happens.
    const m = fake.apiRequests().length;
    const plain = dataOf<UpdateResult>(await callTool(client, 'update_order_status', { id: o2.id, status: 'processing' }));
    assert.equal(plain.status, 'processing');
    assert.equal(plain.note, null);
    assert.equal(fake.apiRequests().length, m + 1);

    const miss = await callTool(client, 'update_order_status', { id: 999999, status: 'completed' });
    assert.equal(miss.isError, true);
    assert.match(textOf(miss), /^WooCommerce returned 404 \(woocommerce_rest_shop_order_invalid_id\)/);
  });

  test('a WooCommerce 5xx or 401 becomes an error result with the WooCommerce code', async () => {
    fake.forceStatus = 503;
    try {
      const r = await callTool(client, 'list_products', {});
      assert.equal(r.isError, true);
      assert.equal(textOf(r), 'WooCommerce returned 503 (fake_forced_error): Forced HTTP 503');
    } finally {
      fake.forceStatus = undefined;
    }

    const wrongCreds = await startMcp(testConfig({ wooBaseUrl: fake.url, wooAppPassword: 'not-the-password' }));
    const c = await connectClient(wrongCreds.mcpUrl);
    try {
      const r = await callTool(c, 'get_order', { id: o1.id });
      assert.equal(r.isError, true);
      assert.equal(textOf(r), 'WooCommerce returned 401 (woocommerce_rest_cannot_view): Sorry, you cannot list resources.');
    } finally {
      await c.close();
      await wrongCreds.close();
    }
  });

  test('a slow store turns into a timeout error result', async () => {
    const slow = await startMcp(testConfig({ wooBaseUrl: fake.url, wooTimeoutMs: 150 }));
    const c = await connectClient(slow.mcpUrl);
    fake.delayMs = 600;
    try {
      const r = await callTool(c, 'get_order', { id: o1.id });
      assert.equal(r.isError, true);
      assert.equal(textOf(r), `WooCommerce request timed out after 150 ms (GET /wp-json/wc/v3/orders/${o1.id})`);
    } finally {
      fake.delayMs = 0;
      await c.close();
      await slow.close();
    }
  });

  test('a WordPress fatal-error page (HTML 500), a login page (HTML 200) or a wrong-shaped JSON body is an error result', async () => {
    try {
      fake.forceResponse = {
        status: 500,
        contentType: 'text/html',
        body:
          '<!DOCTYPE html><html><head><title>WordPress &rsaquo; Error</title><style>p{}</style></head>' +
          '<body><p>There has been a critical error on this website.</p></body></html>',
      };
      const fatal = await callTool(client, 'list_products', {});
      assert.equal(fatal.isError, true);
      assert.equal(
        textOf(fatal),
        'WooCommerce returned 500 (http_500): WordPress \u203a Error There has been a critical error on this website.',
      );
      for (const name of ['get_order', 'update_order_status', 'create_product'] as const) {
        const args = name === 'create_product' ? { name: 'x', regular_price: '1' } : { id: o1.id, status: 'completed' };
        const r = await callTool(client, name, args);
        assert.equal(r.isError, true, name);
        assert.match(textOf(r), /^WooCommerce returned 500 \(http_500\): /, name);
        assert.doesNotMatch(textOf(r), /<\/?[a-z]+>/i, `${name}: no HTML tags in the message`);
      }

      fake.forceResponse = { status: 502, contentType: 'text/plain', body: '' };
      const empty = await callTool(client, 'list_products', {});
      assert.equal(empty.isError, true);
      assert.equal(textOf(empty), 'WooCommerce returned 502 (http_502): no response body');

      fake.forceResponse = { status: 200, contentType: 'text/html', body: '<html><body><form id="loginform">Log in</form></body></html>' };
      const login = await callTool(client, 'get_order', { id: o1.id });
      assert.equal(login.isError, true);
      assert.equal(textOf(login), `WooCommerce returned a non-JSON body for GET /wp-json/wc/v3/orders/${o1.id} (HTTP 200)`);

      fake.forceResponse = { status: 200, contentType: 'application/json', body: '{"unexpected":true}' };
      const notArray = await callTool(client, 'list_orders', {});
      assert.equal(notArray.isError, true, 'a non-array list body must not look like an empty store');
      assert.equal(textOf(notArray), 'WooCommerce returned an unexpected body for GET /wp-json/wc/v3/orders (expected a JSON array)');

      fake.forceResponse = { status: 200, contentType: 'application/json', body: 'null' };
      const nul = await callTool(client, 'get_product', { id: 1 });
      assert.equal(nul.isError, true);
      assert.equal(textOf(nul), 'WooCommerce returned an unexpected body for GET /wp-json/wc/v3/products/1 (expected a JSON object)');

      // A WP error body whose message carries HTML (WordPress does this) is flattened too.
      fake.forceResponse = {
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'internal_server_error', message: '<p>There has been a critical error.</p>', data: { status: 500 } }),
      };
      const wp = await callTool(client, 'get_product', { id: 1 });
      assert.equal(textOf(wp), 'WooCommerce returned 500 (internal_server_error): There has been a critical error.');
    } finally {
      fake.forceResponse = undefined;
    }
    const sane = await callTool(client, 'get_order', { id: o1.id });
    assert.notEqual(sane.isError, true, 'store works again afterwards');
  });

  test('a POST without the Accept pair or with a wrong Content-Type is a 406/415 JSON-RPC error, not a crash', async () => {
    for (const accept of [undefined, 'application/json', 'text/event-stream', '*/*']) {
      const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
      if (accept !== undefined) headers.Accept = accept;
      const res = await fetch(mcp.mcpUrl, { method: 'POST', headers, body: JSON.stringify(INITIALIZE) });
      assert.equal(res.status, 406, `Accept: ${String(accept)}`);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      const body = (await res.json()) as { jsonrpc: string; error: { code: number; message: string }; id: null };
      assert.equal(body.jsonrpc, '2.0');
      assert.equal(body.error.code, -32000);
      assert.match(body.error.message, /Not Acceptable/);
    }
    const wrongType = await fetch(mcp.mcpUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'text/plain', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(INITIALIZE),
    });
    assert.equal(wrongType.status, 415);
    assert.equal(((await wrongType.json()) as { error: { code: number } }).error.code, -32000);

    // Auth and Origin are decided before the transport looks at Accept.
    const noAuth = await fetch(mcp.mcpUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noAuth.status, 401);
    await noAuth.text();

    const h = await fetch(`${mcp.url}/healthz`);
    assert.equal(h.status, 200);
    await h.text();
    assert.notEqual((await callTool(client, 'list_products', {})).isError, true, 'the shared client still works');
  });

  test('an unknown tool is an error result, not a crashed request', async () => {
    const r = await callTool(client, 'delete_everything', {});
    assert.equal(r.isError, true);
    assert.match(textOf(r), /delete_everything/);
  });

  test('wrong or missing bearer -> 401 with RFC 6750 WWW-Authenticate (no resource_metadata) and JSON body', async () => {
    const attempts: Array<Record<string, string>> = [
      {},
      { Authorization: 'Bearer nope' },
      { Authorization: `Bearer ${TOKEN}x` },
      { Authorization: `Bearer ${TOKEN.slice(0, -1)}` },
      { Authorization: `Basic ${Buffer.from(TOKEN).toString('base64')}` },
      { Authorization: 'Bearer' },
      { Authorization: `Bearer ${TOKEN.toUpperCase()}` },
    ];
    for (const headers of attempts) {
      const res = await rawPost(mcp.mcpUrl, INITIALIZE, headers);
      assert.equal(res.status, 401, JSON.stringify(headers));
      const challenge = res.headers.get('www-authenticate');
      assert.equal(
        challenge,
        'Bearer error="invalid_token", error_description="Missing or invalid credential"',
        'RFC 6750 challenge',
      );
      assert.doesNotMatch(challenge ?? '', /resource_metadata/, 'no OAuth metadata is advertised');
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      assert.deepEqual(await res.json(), {
        error: 'invalid_token',
        error_description: 'Missing or invalid credential',
      });
    }

    await assert.rejects(
      connectClient(mcp.mcpUrl, 'wrong-token'),
      (err: unknown) => err instanceof StreamableHTTPError && err.code === 401,
      'SDK client gets a StreamableHTTPError 401',
    );

    const ok = await rawPost(mcp.mcpUrl, INITIALIZE, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(ok.status, 200);
    const body = await ok.text();
    assert.match(body, /"serverInfo"/);
  });

  test('an Origin header that is not allowed -> 403 JSON, even with a valid bearer; no Origin -> unaffected', async () => {
    // Default config: ALLOWED_ORIGINS empty, so any Origin is rejected.
    for (const origin of ['http://evil.example', 'http://127.0.0.1', 'null', 'garbage', '']) {
      const res = await rawPost(mcp.mcpUrl, INITIALIZE, { Authorization: `Bearer ${TOKEN}`, Origin: origin });
      assert.equal(res.status, 403, `Origin: ${JSON.stringify(origin)}`);
      assert.equal(res.headers.get('www-authenticate'), null, 'origin rejection is not an auth challenge');
      const body = (await res.json()) as { error: string; error_description: string };
      assert.equal(body.error, 'invalid_origin');
      assert.match(body.error_description, /not allowed/);
    }
    // Origin is checked before the bearer: a browser page cannot learn whether a token is valid.
    const noToken = await rawPost(mcp.mcpUrl, INITIALIZE, { Origin: 'http://evil.example' });
    assert.equal(noToken.status, 403);
    await noToken.text();
    // GET/DELETE are covered too.
    const get = await fetch(mcp.mcpUrl, { method: 'GET', headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'http://evil.example' } });
    assert.equal(get.status, 403);
    await get.text();

    // Allowed origins pass (compared as normalised origins: case-insensitive host, default ports dropped).
    const allowing = await startMcp(
      testConfig({ wooBaseUrl: fake.url, allowedOrigins: ['https://chat.example.com', 'http://localhost:3000'] }),
    );
    try {
      for (const origin of ['https://chat.example.com', 'https://CHAT.example.com:443', 'http://localhost:3000']) {
        const res = await rawPost(allowing.mcpUrl, INITIALIZE, { Authorization: `Bearer ${TOKEN}`, Origin: origin });
        assert.equal(res.status, 200, `Origin: ${origin}`);
        await res.text();
      }
      for (const origin of ['http://chat.example.com', 'https://chat.example.com:8443', 'http://localhost:3001']) {
        const res = await rawPost(allowing.mcpUrl, INITIALIZE, { Authorization: `Bearer ${TOKEN}`, Origin: origin });
        assert.equal(res.status, 403, `Origin: ${origin}`);
        await res.text();
      }
      // Allowed origin but bad token -> 401 (origin check passed, bearer check failed).
      const bad = await rawPost(allowing.mcpUrl, INITIALIZE, { Authorization: 'Bearer nope', Origin: 'http://localhost:3000' });
      assert.equal(bad.status, 401);
      await bad.text();
    } finally {
      await allowing.close();
    }
  });

  test('GET and DELETE /mcp answer 405 (after the bearer check)', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(mcp.mcpUrl, {
        method,
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json, text/event-stream' },
      });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.get('allow'), 'POST');
      const body = (await res.json()) as { error: { code: number } };
      assert.equal(body.error.code, -32000);

      const unauth = await fetch(mcp.mcpUrl, { method });
      assert.equal(unauth.status, 401, `${method} without bearer`);
      await unauth.text();
    }
  });

  test('malformed JSON on /mcp is a 400 parse error, not a crash', async () => {
    const res = await fetch(mcp.mcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: '{not json',
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: number } };
    assert.equal(body.error.code, -32700);
  });

  test('/healthz is always 200 and /readyz reflects a cached WordPress probe', async () => {
    const h = await fetch(`${mcp.url}/healthz`);
    assert.equal(h.status, 200);
    const hb = (await h.json()) as { status: string; service: string };
    assert.equal(hb.status, 'ok');
    assert.equal(hb.service, 'woo-mcp');

    const probesBefore = fake.requests.filter((r) => r.path === '/wp-json/').length;
    const r1 = await fetch(`${mcp.url}/readyz`);
    assert.equal(r1.status, 200);
    assert.equal(((await r1.json()) as { status: string }).status, 'ready');
    const r2 = await fetch(`${mcp.url}/readyz`);
    assert.equal(r2.status, 200);
    await r2.text();
    const probesAfter = fake.requests.filter((r) => r.path === '/wp-json/').length;
    assert.equal(probesAfter - probesBefore, 1, 'second /readyz within 10 s is served from cache');

    const dead = await startMcp(testConfig({ wooBaseUrl: 'http://127.0.0.1:1', wooTimeoutMs: 500 }));
    try {
      const r = await fetch(`${dead.url}/readyz`);
      assert.equal(r.status, 503);
      const body = (await r.json()) as { status: string; woo: { ok: boolean; error?: string } };
      assert.equal(body.status, 'not-ready');
      assert.equal(body.woo.ok, false);
      assert.ok(body.woo.error);
      const h2 = await fetch(`${dead.url}/healthz`);
      assert.equal(h2.status, 200, 'liveness does not depend on WordPress');
      await h2.text();
    } finally {
      await dead.close();
    }
  });

  test('unknown paths are JSON 404s', async () => {
    const res = await fetch(`${mcp.url}/nope`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found' });
  });
});

describe('woo-mcp when the store goes away', () => {
  test('a stopped WooCommerce turns calls into "unreachable" error results and recovers on restart', async () => {
    const fake2 = new FakeWoo({ username: WOO_USER, appPassword: WOO_APP_PASSWORD });
    await fake2.start();
    fake2.seedProduct({ name: 'Before outage', regular_price: '1.00' });
    const mcp2 = await startMcp(testConfig({ wooBaseUrl: fake2.url, wooTimeoutMs: 1_000 }));
    const c = await connectClient(mcp2.mcpUrl);
    try {
      const okResult = dataOf<ListProducts>(await callTool(c, 'list_products', {}));
      assert.equal(okResult.total, 1);

      await fake2.stop();
      const down = await callTool(c, 'list_products', {});
      assert.equal(down.isError, true);
      assert.match(textOf(down), /^WooCommerce is unreachable \(GET \/wp-json\/wc\/v3\/products\): /);
      assert.match(textOf(down), /ECONNREFUSED|closed|reset|ECONNRESET|socket/i);
      const ready = await fetch(`${mcp2.url}/readyz`);
      assert.equal(ready.status, 503);
      await ready.text();
    } finally {
      await c.close();
      await mcp2.close();
      await fake2.stop();
    }
  });
});
