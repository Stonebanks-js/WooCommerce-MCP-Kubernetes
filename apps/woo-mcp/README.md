# woo-mcp: WooCommerce MCP server

A small, self-written [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
one WooCommerce store's **products and orders** as MCP tools over Streamable HTTP. It is deployed next
to the store (chart `charts/store`, image `urumi/woo-mcp`) and is only reachable by the gateway, which
must present a static bearer token.

```
gateway ──Authorization: Bearer <MCP_AUTH_TOKEN>──► woo-mcp :8080/mcp ──Basic auth (app password)──► WordPress /wp-json/wc/v3
```

* Node 22, TypeScript (ESM, strict), `express@5`, `@modelcontextprotocol/sdk@1.32.1`, `zod@4`, `pino`.
* Stateless Streamable HTTP: a fresh `McpServer` + transport per `POST /mcp`; `GET`/`DELETE /mcp` → `405`.
* `/mcp` is guarded by an `Origin` allow-list (default: none) and a static bearer; see "HTTP endpoints".
* Runs as non-root, listens on `8080`, logs JSON lines to stdout, exposes `/healthz` and `/readyz`.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port (`/healthz`, `/readyz`, `/mcp`). |
| `WOO_BASE_URL` | required | WordPress origin, e.g. `http://demo-wordpress:80` (in-cluster) or `http://store.127.0.0.1.nip.io` (local). Trailing slashes are stripped. |
| `WOO_USERNAME` | required | WordPress user that owns the application password (the `mcp-bot` shop manager created by the setup job). |
| `WOO_APP_PASSWORD` | required | That user's WordPress **application password**. Never logged, never returned by any tool. |
| `MCP_AUTH_TOKEN` | required | Static bearer the gateway must send on `/mcp`. Must equal the platform chart's `secrets.wooMcpToken`. |
| `STORE_NAME` | `WooCommerce store` | Human-readable name used in the server title, instructions and tool descriptions. |
| `STORE_URL` | `WOO_BASE_URL` | Public storefront URL. Product permalinks that WordPress built from an internal origin are rewritten to this origin. |
| `WOO_TIMEOUT_MS` | `15000` | Per-request timeout for WooCommerce REST calls (`AbortSignal.timeout`). |
| `ALLOWED_ORIGINS` | *(none)* | Comma-separated origins (`https://host[:port]`) that may send an `Origin` header to `/mcp`. Requests that carry an `Origin` not in this list get `403`; requests without one (the gateway, curl, SDK clients) are unaffected. Leave empty unless a browser page must call this server directly. |
| `LOG_LEVEL` | `info` | pino level (`fatal`…`trace`, `silent`). |

Configuration is parsed once at startup with zod; a bad environment exits with code 1 and one JSON log
line listing every problem.

## How it talks to the store

woo-mcp uses the WooCommerce REST API (`/wp-json/wc/v3`) with **HTTP Basic auth** using a WordPress
*application password* (`WOO_USERNAME:WOO_APP_PASSWORD`). Why this and not WooCommerce consumer keys:

* Application passwords are a core WordPress feature (5.6+), scoped to one user, revocable in the
  WordPress admin, and accepted on every REST route. WooCommerce's own REST authentication checks the
  capabilities of the authenticated user, so a `shop_manager` can read and write products and orders.
* The store chart's setup job installs a **known** application password (24 alphanumeric characters)
  for the `mcp-bot` user straight into WordPress. The same value lives in the store Secret, so woo-mcp
  reads it from there: no key generation step, nothing to copy between systems, and a Helm upgrade is
  idempotent.
* Consumer keys would require either generating them in the setup job and writing them back into a
  Secret, or the WooCommerce auth-endpoint OAuth dance, both of which add moving parts for no gain
  inside a private cluster network.

The client (`src/woo/client.ts`) adds the `Authorization: Basic …` header, a timeout, and maps every
failure to a readable message:

| What happened | Tool result |
|---|---|
| WooCommerce 4xx/5xx | `isError: true`, text `WooCommerce returned 404 (woocommerce_rest_shop_order_invalid_id): Invalid ID.` |
| Timeout | `isError: true`, text `WooCommerce request timed out after 15000 ms (GET /wp-json/wc/v3/orders/7)` |
| Connection refused / reset | `isError: true`, text `WooCommerce is unreachable (GET /wp-json/wc/v3/products): ECONNREFUSED …` |
| WordPress fatal-error page (HTML 5xx) or proxy error page | `isError: true`, text `WooCommerce returned 500 (http_500): There has been a critical error on this website.` (tags stripped, first 160 chars) |
| 2xx that is not the expected JSON (login page, `null`, object instead of list) | `isError: true`, text `WooCommerce returned a non-JSON body for …` / `… unexpected body for GET /wp-json/wc/v3/orders (expected a JSON array)`; never reported as an empty store |
| Invalid tool input (zod, bad date, bad price) | `isError: true` with the validation message, **no** HTTP call |

Tool-level failures are never JSON-RPC errors and never crash the request (contracts §3).

## Tools

All tools return `content: [{type: "text", text: <compact JSON>}]` plus the same object as
`structuredContent`. Every tool has a `title`, a `description` and `annotations`
(`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).

| Tool | Input | Returns | Annotations |
|---|---|---|---|
| `list_products` | `search?`, `status?` (`any`\|`publish`\|`draft`\|`pending`\|`private`, default `any`), `per_page?` (1–100, default 20), `page?` | `{products: [{id, name, sku, price, regular_price, status, stock_status, permalink, date_created}], total, page, totalPages}` (from `X-WP-Total` / `X-WP-TotalPages`) | read-only, idempotent |
| `get_product` | `id` | full product summary: the fields above plus `type, sale_price, description, short_description, manage_stock, stock_quantity, total_sales, categories, date_modified` | read-only, idempotent |
| `create_product` | `name`, `regular_price` (string or number, plain decimal), `description?`, `short_description?`, `sku?`, `status?` (default `publish`), `manage_stock?`, `stock_quantity?` | the created product summary incl. `id` and `permalink`. Always creates a **simple** product. | write, not idempotent |
| `list_orders` | `status?` (`any` or an order status, default `any`), `after?`, `before?`, `search?`, `per_page?`, `page?` | `{orders: [{id, number, status, total, currency, date_created, customer_name, customer_email, payment_method_title, line_items: [{name, quantity, total}]}], total, page, totalPages}`. `customer_name` is billing first + last name, `Guest` when blank. | read-only, idempotent |
| `get_order` | `id` | `{id, number, status, currency, total, subtotal, shipping_total, total_tax, discount_total, payment_method, payment_method_title, date_created, date_paid, date_completed, customer_id, customer_note, billing: {name, company, email, phone, address_1, address_2, city, state, postcode, country}, shipping: {…same…}, line_items: [{id, name, sku, quantity, price, total}]}` | read-only, idempotent |
| `update_order_status` | `id`, `status` (`pending`\|`processing`\|`on-hold`\|`completed`\|`cancelled`\|`refunded`\|`failed`), `note?` | the updated order summary (as in `list_orders`) plus `note: {id, note, date_created, customer_note} \| null`. The status is validated **before** any HTTP call; `PUT /orders/{id} {status}` then, if `note` is given, `POST /orders/{id}/notes {note, customer_note: false}`. | write, not idempotent |

### Dates in `list_orders`

`after` / `before` accept either a calendar day or a full ISO 8601 date-time:

* `"2026-10-16"` → `after=2026-10-16T00:00:00`, `before=2026-10-16T23:59:59`. WooCommerce interprets
  these in the **store's timezone** (we never send `dates_are_gmt`), so "orders placed today" is simply
  `{"after": "2026-10-16"}`.
* `"2026-10-16T09:30:00"`, `"2026-10-16T09:30:00Z"`, `"2026-10-16T09:30:00+05:30"` are passed through
  unchanged.
* Anything else (`"yesterday"`, `2026-02-30`) is rejected with an explanatory error result and no call
  to WooCommerce.

## HTTP endpoints

| Method & path | Auth | Response |
|---|---|---|
| `GET /healthz` | none | `200 {"status":"ok","service":"woo-mcp","version":"…"}` (liveness: the process is up) |
| `GET /readyz` | none | `200 {"status":"ready",…}` when `GET ${WOO_BASE_URL}/wp-json/` answered 2xx/3xx within the last 10 s (cached probe, one in flight at a time); otherwise `503 {"status":"not-ready","woo":{"ok":false,"error":"…"}}` |
| `POST /mcp` | `Authorization: Bearer <MCP_AUTH_TOKEN>` | MCP Streamable HTTP (stateless, no `Mcp-Session-Id`). Needs `Accept: application/json, text/event-stream` (else `406`) and `Content-Type: application/json` (else `415`) like every SDK transport; malformed JSON → `400` `-32700`, body over 4 MiB → `413`. |
| `GET /mcp`, `DELETE /mcp` | bearer | `405` with `Allow: POST` |
| anything else | | `404 {"error":"not_found"}` |

Every request to `/mcp` goes through two checks before the MCP transport sees it:

1. **Origin** (MCP spec MUST, DNS-rebinding protection): if an `Origin` header is present it must be one
   of `ALLOWED_ORIGINS` (compared as normalised origins, so `https://Chat.Example.com:443` equals
   `https://chat.example.com`); otherwise
   `403 {"error":"invalid_origin","error_description":"Origin \"…\" is not allowed"}`. With the default
   empty list any `Origin` is rejected. The check runs first and needs no secret, so a browser page can
   never learn whether a token was valid.
2. **Bearer**, compared in constant time. A missing or wrong token gets

   ```
   HTTP/1.1 401 Unauthorized
   WWW-Authenticate: Bearer error="invalid_token", error_description="Missing or invalid credential"
   Content-Type: application/json

   {"error":"invalid_token","error_description":"Missing or invalid credential"}
   ```

   RFC 6750 form, deliberately **without** `resource_metadata`, so no OAuth metadata is advertised
   (contracts §3). Claude Code prints the `error_description` on its "Issue:" line when a configured
   header is rejected.

## Running locally against the real store

With the local kind cluster up (`make local-up`), the store is at `http://store.127.0.0.1.nip.io` and the
`mcp-bot` application password is in `deploy/secrets/store.yaml` (`secrets.wooAppPassword`):

```bash
cd apps/woo-mcp
npm ci
WOO_BASE_URL=http://store.127.0.0.1.nip.io \
WOO_USERNAME=mcp-bot \
WOO_APP_PASSWORD=<secrets.wooAppPassword> \
MCP_AUTH_TOKEN=dev-token \
STORE_NAME="Demo Store" \
STORE_URL=http://store.127.0.0.1.nip.io \
PORT=8089 \
npm run dev            # or: npm run build && npm start
```

Smoke test with curl (responses are SSE frames; `tools/list` needs an `initialize` first only for
stateful servers, so you can call it directly here):

```bash
curl -s http://localhost:8089/readyz
curl -s -X POST http://localhost:8089/mcp \
  -H 'Authorization: Bearer dev-token' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl -s -X POST http://localhost:8089/mcp \
  -H 'Authorization: Bearer dev-token' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_orders","arguments":{"after":"2026-10-16"}}}'
```

Any MCP client works the same way; with the TypeScript SDK:

```ts
const transport = new StreamableHTTPClientTransport(new URL('http://localhost:8089/mcp'), {
  requestInit: { headers: { Authorization: 'Bearer dev-token' } },
});
await client.connect(transport);
await client.callTool({ name: 'list_products', arguments: { search: 'mug' } });
```

Inside the cluster the gateway reaches it at `http://demo-woo-mcp.store-demo.svc.cluster.local:8080/mcp`
(seed entry `woo`, see `docs/contracts.md` §8).

## Development

```bash
npm ci
npm run typecheck   # tsc over src/ and test/
npm test            # node --test test/*.test.ts (no network, no store needed)
npm run build       # emits dist/
npm run dev         # node --watch src/index.ts
```

`src/` and `test/` are plain TypeScript run directly by Node (type stripping, Node ≥ 22.18); the
image compiles with `tsc` and runs `dist/index.js`. Relative imports therefore use `.ts` extensions in
source and are rewritten to `.js` on build (`rewriteRelativeImportExtensions`).

### Tests

`npm test` starts an **in-process fake WooCommerce** (`test/helpers/fake-woo.ts`: express, in-memory
products/orders/notes, Basic-auth check, `X-WP-Total` headers, WP-style error bodies, local-time dates)
and the real server on a random port, then drives it with the SDK `Client` +
`StreamableHTTPClientTransport`:

* `tools/list` → six tools with titles, descriptions, annotations and object input schemas;
* `create_product` → `list_products` sees it with a public permalink, request body is `type: "simple"`;
* `list_orders` with `after` / `before` calendar days → correct expansion and filtering;
* `get_order` detail, `update_order_status` (invalid status rejected with no HTTP call; valid one does
  `PUT` + `POST …/notes`);
* WooCommerce 404 / 401 / 503 → `isError` results with the WooCommerce code; HTML fatal-error pages,
  login pages and wrong-shaped JSON → `isError` with a plain-text message; slow store → timeout result;
  stopped store → "unreachable" result and `503 /readyz`;
* wrong or missing bearer → `401` with the RFC 6750 `WWW-Authenticate` challenge and JSON body;
  disallowed `Origin` → `403` (allowed ones pass, checked before the bearer); `GET`/`DELETE /mcp` → `405`;
  missing `Accept` pair → `406`, wrong `Content-Type` → `415`, malformed JSON → `400`;
* unit tests for `dates.ts`, `summaries.ts` and `config.ts`.

## Image

`Dockerfile`: multi-stage `node:22-alpine` (build with `tsc`, runtime with production dependencies
only), `USER node`, `EXPOSE 8080`, `CMD ["node","dist/index.js"]`.

```bash
docker build -t urumi/woo-mcp:dev .
```

## Layout

```
src/index.ts         bootstrap: config → logger → app → listen, graceful shutdown
src/app.ts           express app: access log, /healthz, /readyz, /mcp router, 404/500 handlers
src/config.ts        environment parsed with zod (table above)
src/mcp.ts           Origin check, bearer check (RFC 6750 401), stateless Streamable HTTP wiring, 405s, McpServer factory
src/tools.ts         the six tools (zod input schemas, descriptions, annotations, error mapping)
src/summaries.ts     compact product/order views (contracts §12) and permalink rewriting
src/readiness.ts     cached readiness probe (10 s TTL, single in-flight probe)
src/woo/client.ts    WooCommerce REST client: Basic auth, timeout, WooError mapping
src/woo/dates.ts     YYYY-MM-DD → local day start/end; ISO date-times pass through
src/woo/types.ts     the subset of WooCommerce product/order/note fields we use
src/version.ts       package version for serverInfo / healthz
test/                node:test suites and the fake WooCommerce
```
