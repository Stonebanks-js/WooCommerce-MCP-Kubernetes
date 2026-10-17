# apps/gateway — Urumi MCP Gateway

Node 22 + TypeScript (ESM) service that sits in front of any number of upstream MCP servers and exposes:

* `POST /mcp` — one stateless Streamable HTTP MCP endpoint (SDK 1.32.x, spec 2025-11-25) authenticated with gateway API keys
  (`Authorization: Bearer gw_…` or `X-Api-Key`). Tools are aggregated as `<slug>__<tool>`.
* `/api/*` — the REST API the dashboard uses (cookie sessions, users, invites, keys, servers, audit, chat). See `docs/contracts.md` §9.
* `POST /api/chat` — a tool-using chat agent (Anthropic, any OpenAI-compatible endpoint, or a deterministic mock) streamed as SSE (§11).
* `GET /healthz`, `GET /readyz` on the main port; Prometheus `GET /metrics` on a separate port (`METRICS_PORT`, default 9090).

## Run locally

### Against Postgres

```bash
cd apps/gateway
npm ci
export DATABASE_URL=postgres://gateway:gateway@localhost:5432/gateway
export GATEWAY_ENCRYPTION_KEY=$(openssl rand -base64 32)
export SESSION_SECRET=$(openssl rand -hex 32)
export PUBLIC_URL=http://localhost:8080
export ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=admin12345
export ALLOW_PRIVATE_UPSTREAMS=true          # upstreams on localhost / RFC1918 are fine for local dev
npm run dev                                  # node --watch src/index.ts (Node 22.18+/26: TypeScript runs natively)
```

Migrations (`migrations/NNN_*.sql`) and the seed (admin, optional demo member, `SEED_SERVERS_JSON`) run on every start.
The full environment variable table is in `docs/contracts.md` §7; `.env` is read automatically by `npm run dev` if present.

### Without Postgres (PGlite in-process)

```bash
npm run dev:pglite
```

Boots the gateway on an in-memory PGlite database with `LLM_PROVIDER=mock`, `ALLOW_PRIVATE_UPSTREAMS=true`,
`CORS_ORIGIN=http://localhost:5173` (Vite dashboard) and seeded users **admin@example.com / admin12345** and
**member@example.com / member12345**. Any `SEED_SERVERS_JSON`, `LLM_*`, `PORT` etc. from the environment are honoured.
Data is lost when the process exits.

### Build / image

```bash
npm run build          # tsc → dist/
npm start              # node dist/index.js
docker build -t urumi/gateway:dev .
```

The Dockerfile is a two-stage `node:22-alpine` build (`npm ci` → `tsc` → `npm prune --omit=dev`), runs as `USER node`,
exposes `8080` and `9090`.

## Tests

```bash
npm run typecheck      # tsc for src and tests
npm test               # node --test src/**/*.test.ts  (no network, no Docker)
```

* Unit: tool naming (collision-free, 64-char truncation), member policy globs, scrypt passwords, API-key format/hash,
  AES-GCM secret box incl. tamper detection, SSRF decisions, rate limiter, tool search ranking.
* Integration (`src/test/gateway.integration.test.ts`): PGlite + three in-process fake upstreams built with the SDK's
  `McpServer` (bearer, `X-Api-Key`, and no auth). Exercises the whole admin → invite → member → API key → MCP client flow,
  timeouts, an upstream going down, policy changes, disabling a server, key revocation, the 401/403/404 shapes, the mock chat
  loop and the Prometheus output. The suite runs in roughly 10–20 s.

## How a tool call travels

1. The MCP client POSTs `tools/call` to `/mcp`. The Express handler validates the `Origin` header (if any), authenticates the API key
   (prefix lookup + constant-time hash compare; revoked keys and disabled users are rejected with an RFC 6750 `401`), then builds a
   fresh low-level SDK `Server` + stateless `StreamableHTTPServerTransport` for this one request.
2. The `tools/call` handler calls `GatewayCore.callTool(user, publicName, args, {source:'mcp', apiKeyId})` — the only code path
   that executes tools; the chat agent calls the same function with `source:'chat'`.
3. The core resolves `publicName` through the registry's exact `publicName → (serverId, upstreamName)` map (never by string
   splitting), checks that the server is enabled and that the member policy allows the tool, and takes a token from the per-key
   (or per-user) bucket. Rejections become JSON-RPC errors (`-32602` unknown/denied, `-32000` rate limited).
4. `UpstreamRegistry.callTool` hands the call to the server's `UpstreamConnection`: a lazily connected SDK `Client` over
   `StreamableHTTPClientTransport` carrying the decrypted credential. The call runs with the server's `timeout_ms`; a hard
   `AbortSignal` additionally cuts the socket. Transport failures drop the client (next call reconnects) and mark the server
   `unreachable`; SDK timeouts become `isError` "timed out"; upstream `isError`/tool-level JSON-RPC errors are forwarded as
   `isError`; successes are forwarded unchanged.
5. Exactly one `audit_log` row is written per call (also for every rejection), `gateway_tool_calls_total` and the duration
   histogram are updated, and the result is returned to the client as the SDK's SSE-framed JSON-RPC response.

## Decisions

* **Stateless `/mcp` only.** New `Server` + transport per POST; `GET`/`DELETE` are 405. No `Mcp-Session-Id`, so the gateway can be
  scaled horizontally without sticky sessions.
* **401 shape.** `WWW-Authenticate: Bearer error="invalid_token", error_description="<why>"` without `resource_metadata`, plus the
  JSON body, as in contracts §3/§10 (UPDATE). The OAuth discovery paths and `/register|/authorize|/token` answer `404` JSON.
  Keys are never read from the query string.
* **Origin check** (403) is applied to `/mcp` only. Allowed origins are `PUBLIC_URL`'s, `CORS_ORIGIN` and `MCP_ALLOWED_ORIGINS`
  (default `http://localhost:6274,http://127.0.0.1:6274`, the MCP Inspector web UI, which calls servers straight from the
  browser). `/mcp` is bearer-authenticated, so the check is spec hygiene rather than a credential guard. `/api` relies on the
  `SameSite=Lax` cookie; with `CORS_ORIGIN` set, a minimal CORS layer allows the Vite dev origin with credentials.
* **Tools of disabled servers stay in the routing map** so that calling one yields `Server <slug> is disabled` (audit `denied`)
  instead of `Unknown tool`; they are never listed. Unreachable servers keep their cached `tools_json` so `tools/list` is stable.
* **Schema normalisation.** Upstream `inputSchema` is forwarded verbatim except that `type:'object'` is guaranteed and non-object
  `properties` values are replaced with `{}` — SDK clients reject anything else.
* **Invite link** is `${PUBLIC_URL}/invite/<token>` (dashboard route). Tokens are 32 random bytes, sha256 stored,
  7-day expiry, single use.
* **Self-protection.** An admin cannot delete themselves (400) nor change their own role/status (400). Disabling a user deletes
  their sessions; their API keys stop working immediately (user status is checked on every `/mcp` request).
* **`api_keys.last_used_at`** is written at most once per minute per key (in-memory throttle), fire-and-forget.
* **Rate limit** is an in-memory token bucket per API key id (`key:<id>`) or per user for chat (`user:<id>`); with several
  replicas the effective limit is `replicas × RATE_LIMIT_PER_MINUTE`.
* **Secrets** are AES-256-GCM encrypted at rest (`v1:<iv>:<ct>:<tag>`), decrypted only when building the upstream request
  headers, never serialised (`hasCredential` is the only hint). `PATCH` with `authSecret` omitted keeps the secret, `""` clears
  it, and switching `authType` to `none` clears it too.
* **Chat providers.** `anthropic` uses `client.beta.messages.create` with `betas:['server-side-fallback-2026-07-01']`,
  `fallbacks:'default'` and optional `output_config.effort` (the installed SDK 0.135 types accept all three); responses are not
  token-streamed — each iteration's text is emitted as one `text` event, which §11 allows. `tool_use.input` is used as an object,
  never string-matched. `openai_compatible` posts to `${LLM_BASE_URL}/chat/completions` with the function-calling format.
  `mock` is deterministic (`call <publicName> <json>` → one tool call). `none` → `/api/chat` is 503 `chat_disabled`.
* **Tool-search mode.** Above `CHAT_TOOL_SEARCH_THRESHOLD` visible tools the model only sees `search_tools` and `call_tool`;
  `call_tool` executes through the same core path so the audit row names the real tool. `search_tools` itself is not audited.
* **Health loop** re-reads `mcp_servers` and probes every enabled server every `HEALTH_INTERVAL_MS`; admin mutations in this
  process reload + probe synchronously before responding.
* **Logging** is pino JSON on stdout; request logs never include headers, and `authorization`, `x-api-key`, `cookie`,
  `authSecret`, `password` and `plaintext` fields are redacted defensively.
