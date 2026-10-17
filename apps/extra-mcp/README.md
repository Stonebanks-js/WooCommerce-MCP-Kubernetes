# extra-mcp: the `notes` and `utils` upstream MCP servers

Two deliberately small Streamable HTTP MCP servers that the Urumi gateway aggregates next to
`woo-mcp`. They exist to make gateway behaviour visible in the demo:

| Server  | Credential on `/mcp`                 | Why it exists                                                                 |
|---------|--------------------------------------|-------------------------------------------------------------------------------|
| `notes` | `Authorization: Bearer <MCP_AUTH_TOKEN>` | Stateful in-memory notes (state survives across requests, not across restarts) |
| `utils` | `X-Api-Key: <MCP_AUTH_TOKEN>`        | Stateless helpers behind the gateway's "custom header" credential type        |

Both expose `get_current_time`: the **deliberate tool-name collision** that shows the gateway's
`<slug>__<tool>` namespacing. `convert_currency` pairs with the WooCommerce orders tools for the
"orders in another currency" demo prompt, and killing a pod shows the gateway's "unreachable" path.

One package, one Docker image, two servers. `SERVER=notes|utils` picks which one `dist/index.js`
starts; `src/notes.ts` and `src/utils.ts` are the fixed-choice entrypoints for local use.

## Running

```sh
npm ci
MCP_AUTH_TOKEN=dev-notes npm run dev:notes          # http://localhost:8080/mcp, bearer auth
MCP_AUTH_TOKEN=dev-utils PORT=8081 npm run dev:utils # http://localhost:8081/mcp, X-Api-Key auth

npm run build && SERVER=utils MCP_AUTH_TOKEN=dev-utils node dist/index.js   # what the image runs
```

Node >= 22.18 (type stripping runs the `.ts` sources directly in `dev:*` and `test`; the image
compiles with `tsc`).

### Environment

| Variable              | Default | Meaning                                                                                   |
|-----------------------|---------|-------------------------------------------------------------------------------------------|
| `SERVER`              | –       | `notes` or `utils`; required by `dist/index.js` (the Docker entrypoint), ignored elsewhere |
| `MCP_AUTH_TOKEN`      | –       | Required. The static credential clients must present on `/mcp`                            |
| `PORT`                | `8080`  | Listen port (`0` = pick a free one; the `listening` log line reports the bound port)      |
| `ALLOWED_ORIGINS`     | empty   | Comma-separated origins allowed to send an `Origin` header; empty rejects every `Origin`  |
| `LOG_LEVEL`           | `info`  | pino level (`debug` also logs health probes)                                              |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | How long SIGTERM waits for in-flight requests before closing remaining connections        |

### Endpoints

| Route          | Auth | Behaviour                                                                                          |
|----------------|------|----------------------------------------------------------------------------------------------------|
| `POST /mcp`    | yes  | Stateless Streamable HTTP: a fresh `McpServer` + transport per request, no `Mcp-Session-Id`        |
| `GET /mcp`, `DELETE /mcp` | –  | `405` with `Allow: POST` (no server-initiated streams, nothing to delete)                  |
| `GET /healthz` | no   | `200 {"ok":true,"server":"notes"}` (liveness)                                                      |
| `GET /readyz`  | no   | Same while serving; `503 {"ok":false,...}` once SIGTERM has been received (readiness)              |

`POST /mcp` needs `Content-Type: application/json` (else `415`) and
`Accept: application/json, text/event-stream` (else `406`): that is the SDK transport, and every
MCP client sends both. Responses are SSE-framed (`text/event-stream`, one `event: message`).

```sh
curl -s http://localhost:8081/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'X-Api-Key: dev-utils' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"calculate","arguments":{"expression":"2^10"}}}'
```

### Auth and Origin responses (docs/contracts.md §3)

Missing or wrong credential (for `notes` that includes the right token sent as `X-Api-Key`, and
vice versa):

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token", error_description="Missing or invalid credential"
Content-Type: application/json

{"error":"invalid_token","error_description":"Missing or invalid credential"}
```

The challenge is the RFC 6750 form **without** `resource_metadata`, so no OAuth discovery is
advertised: Claude Code shows the `error_description` and does not start an OAuth flow for a server
whose header the user configured. Comparison is constant-time (SHA-256 digests through
`timingSafeEqual`). The credential is checked before the body is read.

If a request to `/mcp` carries an `Origin` header that is not listed in `ALLOWED_ORIGINS`, the
answer is `403 {"error":"forbidden","error_description":"Origin \"...\" is not allowed"}` (MCP spec
MUST, DNS-rebinding protection). It runs before auth and for every method. Non-browser clients,
including the gateway, never send `Origin` and are unaffected.

Malformed JSON answers `400` with a JSON-RPC `-32700` body; bodies over 4 MB answer `413`.

## Tools

Every tool has `title`, `description`, `annotations` (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint: false`) and a zod input schema. Results carry
`content: [{type:'text', text:<compact JSON>}]` plus the same object as `structuredContent`.
Tool-level failures are `isError: true` results with a human-readable message, never JSON-RPC
errors; invalid arguments are reported the same way by the SDK.

### notes

| Tool               | Input                                                    | Output                                                             | Hints (ro / destructive / idempotent) |
|--------------------|----------------------------------------------------------|--------------------------------------------------------------------|----------------------------------------|
| `create_note`      | `title` (1-200), `body` (0-20000), `tags?: string[]`     | the note `{id, title, body, tags, created_at}`                     | no / no / no                           |
| `list_notes`       | `tag?`, `search?` (case-insensitive over title + body)   | `{notes: [{id, title, tags, created_at, excerpt}], total}`, newest first | yes / no / yes                   |
| `get_note`         | `id`                                                     | the note, or `isError` "Note not found: <id>"                      | yes / no / yes                         |
| `delete_note`      | `id`                                                     | `{deleted: true, id}`, or `isError` "Note not found: <id>"         | no / **yes** / yes                     |
| `get_current_time` | –                                                        | `{iso, unix, timezone: "UTC", server: "notes"}`                    | yes / no / yes                         |

Ids are `n_` + 6 random `[a-z0-9]`; timestamps are ISO 8601 UTC. Tags are trimmed, blanks dropped
and de-duplicated case-insensitively. The store is a `Map` that lives for the process lifetime.

### utils

| Tool               | Input                                       | Output                                                                                   | Hints (ro / destructive / idempotent) |
|--------------------|---------------------------------------------|------------------------------------------------------------------------------------------|----------------------------------------|
| `get_current_time` | `timezone?` (IANA name, default `UTC`)      | `{iso, unix, timezone, local, utc_offset, server: "utils"}`; unknown zone → `isError`     | yes / no / yes                         |
| `calculate`        | `expression` (<= 1000 chars)                | `{expression, result}`; bad syntax, `/0`, `%0`, non-finite result → `isError`            | yes / no / yes                         |
| `convert_currency` | `amount` (>= 0), `from`, `to`               | `{amount, from, to, rate, converted, rates_as_of: "static table"}`; unknown code → `isError` | yes / no / yes                      |
| `generate_uuid`    | –                                           | `{uuid}` (RFC 4122 v4 from `crypto.randomUUID`)                                          | yes / no / yes                         |

`calculate` is a hand-written recursive-descent parser over `+ - * / % ^ ( )`, unary minus and
decimal literals (`3.5`, `.5`, `1e3`); no `eval`, no `Function`, no identifiers. `^` is
right-associative and binds tighter than unary minus (`-2^2 = -4`); `%` is JavaScript remainder.

`convert_currency` uses a fixed table (units per 1 USD), repeated in the tool description so the
model knows the numbers are not live:

| USD | EUR  | GBP  | INR  | JPY | AUD  | CAD  | SGD  |
|-----|------|------|------|-----|------|------|------|
| 1   | 0.92 | 0.79 | 83.5 | 150 | 1.52 | 1.36 | 1.34 |

`rate` is rounded to 6 decimals and `converted` to 2. The `timezone` field echoes the name the
caller passed (ICU may canonicalise `Asia/Kolkata` to `Asia/Calcutta` depending on the Node
version, which would make the output unstable).

## Layout

```
src/index.ts          Docker entrypoint: SERVER=notes|utils -> startServer(definition)
src/notes.ts          fixed entrypoint for the notes server (npm run start:notes / dev:notes)
src/utils.ts          fixed entrypoint for the utils server (npm run start:utils / dev:utils)
src/server.ts         shared Express + Streamable HTTP wiring: Origin check, auth guard
                      ({kind:'bearer'} | {kind:'header', name}), per-request McpServer, 405s,
                      JSON-RPC error bodies, startServer() with env parsing and SIGTERM handling
src/health.ts         /healthz and /readyz
src/tools.ts          defineTool(): naming rule, annotations, ok()/fail() result helpers
src/logger.ts         pino factory
src/version.ts        version reported in `initialize`
src/servers/notes.ts  the notes ServerDefinition and its five tools
src/servers/utils.ts  the utils ServerDefinition and its four tools
src/servers/registry.ts  SERVER env -> definition
src/lib/notes-store.ts   in-memory Map store, ids, excerpts, tag normalisation
src/lib/calculator.ts    the safe expression evaluator
src/lib/currency.ts      the static rate table
test/                 node:test suites (see below)
```

## Tests

```sh
npm run typecheck   # tsc --noEmit (strict, erasableSyntaxOnly so Node can run the sources as-is)
npm test            # node --test test/**/*.test.ts
```

The suite starts both servers on random ports in-process and drives them with the SDK `Client`:
tool listing (names, titles, annotations, schemas), every tool including the error paths (bad
timezone, bad expression, unknown currency, missing note), the `get_current_time` collision (both
list it, `server` differs), auth (notes rejects a missing bearer and the token sent as `X-Api-Key`;
utils rejects a bearer and accepts `X-Api-Key`; the exact 401 shape; Origin → 403), the shared HTTP
behaviour (health, 405, 406, 415, malformed JSON → `-32700`, readiness during shutdown) and the
calculator table (`2+3*4`=14, `(2+3)*4`=20, `2^10`=1024, `7%3`=1, `-3+5`=2, `1/0`, `2+`, `abc`).

## Docker

Multi-stage `node:22-alpine`, production dependencies only, `USER node`, `EXPOSE 8080`,
`CMD ["node","dist/index.js"]`. One image serves either role:

```sh
docker build -t urumi/extra-mcp .
docker run -e SERVER=notes -e MCP_AUTH_TOKEN=dev-notes -p 8080:8080 urumi/extra-mcp
docker run -e SERVER=utils -e MCP_AUTH_TOKEN=dev-utils -p 8081:8080 urumi/extra-mcp
```

On SIGTERM the server stops listening, flips `/readyz` to 503, finishes in-flight requests
(sweeping idle keep-alive connections every 250 ms so pooled client connections do not hold the
process open), force-closes anything left after `SHUTDOWN_TIMEOUT_MS`, and exits 0.
