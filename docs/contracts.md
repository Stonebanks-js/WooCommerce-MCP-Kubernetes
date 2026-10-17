# Contracts: the single source of truth for every component

This file fixes the interfaces between the components so they can be built in parallel.
If an implementation needs to deviate, update this file first.

## 1. Repository layout

```
.
├── README.md
├── Makefile                      # local-up / local-down / build / test / lint targets
├── docs/
│   ├── contracts.md              # this file
│   ├── system-design.md          # architecture + tradeoffs (deliverable)
│   ├── threat-model.md           # (deliverable)
│   ├── demo-script.md            # definition-of-done walkthrough, step by step
│   └── standouts.md              # which bonus / stand-out items exist and where
├── apps/
│   ├── gateway/                  # Node 22 + TypeScript: REST API, MCP endpoint, chat agent
│   ├── dashboard/                # React 19 + Vite + TypeScript, served by nginx-unprivileged
│   ├── woo-mcp/                  # WooCommerce MCP server (self-written)
│   └── extra-mcp/                # two extra upstream MCP servers: "notes" and "utils"
├── charts/
│   ├── store/                    # WordPress + MariaDB + woo-mcp + setup job (+ netpol/quota)
│   │   ├── values.yaml
│   │   ├── values-local.yaml
│   │   └── values-prod.yaml
│   └── platform/                 # Postgres + gateway + dashboard + extra MCP servers
│       ├── values.yaml
│       ├── values-local.yaml
│       └── values-prod.yaml
└── deploy/
    ├── kind/kind-config.yaml
    ├── scripts/                  # local-up.sh, local-down.sh, build-images.sh, gen-secrets.sh, k3s-*.sh
    └── secrets/                  # generated, git-ignored values files with secrets
```

Each app under `apps/` is an independent npm package (its own `package.json`, lockfile,
`tsconfig.json`, `Dockerfile`, `.dockerignore`, `npm test`). No npm workspaces, no shared packages.
All TypeScript is ESM (`"type": "module"`, `module: NodeNext`, `moduleResolution: NodeNext`,
`target: ES2022`, `strict: true`). Node 22 in images, Node 26 may be used for local runs.

Images (local tag `dev`): `urumi/gateway`, `urumi/dashboard`, `urumi/woo-mcp`, `urumi/extra-mcp`.
All containers run as non-root, listen on `8080`, expose `GET /healthz` (liveness) and `GET /readyz`
(readiness) unauthenticated, and log JSON lines to stdout (pino).

## 2. Namespaces, hosts, in-cluster addresses

| Thing | Local (kind) | Production (k3s) |
|---|---|---|
| Platform namespace | `mcp-platform` | `mcp-platform` |
| First store namespace | `store-demo` | `store-demo` |
| Storefront host | `store.127.0.0.1.nip.io` | `store.example.com` |
| Dashboard + gateway host | `gateway.127.0.0.1.nip.io` | `gateway.example.com` |
| Ingress class | `traefik` (installed by `make kind-up` via the Traefik Helm chart; ingress-nginx is retired since March 2026) | `traefik` (bundled with k3s) |
| Ingress controller namespace (for NetworkPolicies) | `traefik` | `kube-system` |
| NetworkPolicy enforcement | kind's default CNI (kindnet, kube-network-policies) | k3s embedded kube-router controller |
| Storage class | `standard` (kind default) | `local-path` |
| TLS | none | optional cert-manager |

In-cluster service names (release name is part of the chart's fullname):

| Service | Address |
|---|---|
| WordPress (store chart, release `demo`) | `http://demo-wordpress.store-demo.svc.cluster.local:80` |
| MariaDB | `demo-mariadb.store-demo.svc.cluster.local:3306` |
| WooCommerce MCP server | `http://demo-woo-mcp.store-demo.svc.cluster.local:8080/mcp` |
| Gateway (platform chart, release `platform`) | `http://platform-gateway.mcp-platform.svc.cluster.local:8080` |
| Dashboard | `http://platform-dashboard.mcp-platform.svc.cluster.local:8080` |
| Postgres | `platform-postgres.mcp-platform.svc.cluster.local:5432` |
| Notes MCP | `http://platform-mcp-notes.mcp-platform.svc.cluster.local:8080/mcp` |
| Utils MCP | `http://platform-mcp-utils.mcp-platform.svc.cluster.local:8080/mcp` |

Ingress on the gateway host routes `/api` and `/mcp` (Prefix) to the gateway Service and `/` to the
dashboard Service. Nothing else is exposed. `/metrics` is served on a separate container port
(`9090`) that no Ingress references.

Pod labels used by NetworkPolicies: every workload carries
`app.kubernetes.io/name: <component>` (`gateway`, `dashboard`, `postgres`, `mcp-notes`, `mcp-utils`,
`wordpress`, `mariadb`, `woo-mcp`) and `app.kubernetes.io/instance: <release>`. Namespaces carry
`kubernetes.io/metadata.name` (set automatically). The store chart's NetworkPolicy allows ingress
to `woo-mcp` only from pods labelled `app.kubernetes.io/name=gateway` in the namespace named by
`.Values.gateway.namespace` (default `mcp-platform`).

## 3. Streamable HTTP conventions (all MCP servers in this repo)

* Endpoint path is `/mcp`. Stateless mode (no `Mcp-Session-Id`): a fresh SDK `Server` + transport
  per POST; `GET /mcp` and `DELETE /mcp` return `405 Method Not Allowed`.
* Upstream servers written here require a static credential on `/mcp`:
  * `woo-mcp` and `mcp-notes`: `Authorization: Bearer <MCP_AUTH_TOKEN>`
  * `mcp-utils`: header `X-Api-Key: <MCP_AUTH_TOKEN>` (so the gateway's "custom header" credential
    type is exercised too)
  * Missing/invalid credential: `401` with header
    `WWW-Authenticate: Bearer error="invalid_token", error_description="Missing or invalid credential"`
    (RFC 6750 form, deliberately **without** `resource_metadata`, so no OAuth metadata is advertised)
    and JSON body `{"error":"invalid_token","error_description":"Missing or invalid credential"}`.
  * If an `Origin` header is present it must equal an allowed origin (configurable; by default none
    for upstream servers, `PUBLIC_URL`'s origin for the gateway); otherwise `403` (MCP spec MUST).
* Tool names are `snake_case`, `[a-z0-9_]`, max 40 chars. Every tool has `title`, `description`
  and `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`).
* Tool results: `content: [{type:'text', text}]` where `text` is compact JSON for data-returning
  tools, plus `structuredContent` with the same object. Tool-level failures (e.g. WooCommerce
  returned 404) are returned as `isError: true` with a human-readable `text`, never as JSON-RPC errors.

## 4. Gateway tool naming and routing

Public tool name = `<slug>__<upstream_tool_name>` (two underscores).

* `slug` is admin-chosen per server: `^[a-z][a-z0-9-]{1,19}$` (2–20 chars), unique.
* The upstream tool name is used verbatim. If `slug + 2 + name` exceeds 64 characters the public
  name is truncated to 55 chars plus `_` plus the first 8 hex chars of `sha256(slug + '/' + name)`;
  the gateway keeps an exact `publicName -> (serverId, upstreamName)` map so routing never guesses.
* Two servers exposing the same upstream tool name therefore never collide (`notes__get_current_time`
  vs `utils__get_current_time`).
* Public descriptions are prefixed with `[<server display name>] ` so the model knows the source.
* Upstream `inputSchema` is forwarded verbatim; `annotations` and `title` are forwarded.

Disabled servers contribute no tools. Unreachable servers contribute their last cached tool list
(so `tools/list` is stable) but calls to them fail fast with `outcome = unreachable`.

## 5. Gateway data model (Postgres)

```sql
create table users (
  id uuid primary key,
  email text not null unique,          -- stored lower-case
  name text not null default '',
  role text not null check (role in ('admin','member')),
  status text not null check (status in ('invited','active','disabled')),
  password_hash text,                  -- scrypt string, null while invited
  invite_token_hash text,              -- sha256 hex of the one-time invite token
  invite_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table sessions (                -- dashboard cookie sessions
  id uuid primary key,                 -- the cookie value (random uuid v4)
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table api_keys (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  name text not null default '',
  prefix text not null,                -- "gw_" + 8 chars, shown in the UI
  key_hash text not null unique,       -- sha256 hex of the full key
  created_by uuid references users(id),
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index on api_keys(prefix);

create table mcp_servers (
  id uuid primary key,
  slug text not null unique,
  name text not null,
  url text not null,
  enabled boolean not null default true,
  auth_type text not null check (auth_type in ('none','bearer','header')),
  auth_header_name text,               -- for auth_type = header
  auth_secret_enc text,                -- AES-256-GCM, format v1:<iv b64>:<ct b64>:<tag b64>
  timeout_ms integer not null default 30000,
  member_tool_policy jsonb not null default '{"mode":"all"}',
  status text not null default 'unreachable' check (status in ('connected','unreachable','disabled')),
  status_error text,
  status_checked_at timestamptz,
  tools_json jsonb not null default '[]',  -- cached upstream tools/list (raw MCP Tool objects)
  tools_updated_at timestamptz,
  managed_by text not null default 'admin' check (managed_by in ('admin','seed','provisioner')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table audit_log (
  id bigserial primary key,
  ts timestamptz not null default now(),
  user_id uuid,
  user_email text not null,
  api_key_id uuid,
  source text not null check (source in ('mcp','chat')),
  server_id uuid,
  server_slug text,
  tool_name text,                      -- upstream name
  public_tool_name text not null,
  duration_ms integer not null,
  outcome text not null check (outcome in ('success','error','timeout','unreachable','denied','not_found','rate_limited')),
  error_message text,
  args_preview text,                   -- JSON truncated to 2000 chars
  result_bytes integer
);
create index on audit_log(ts desc);
create index on audit_log(user_id, ts desc);
```

Migrations are plain SQL files in `apps/gateway/migrations/NNN_name.sql`, applied in order at
startup inside a `schema_migrations` table.

## 6. Gateway secrets and crypto

* Passwords: `scrypt` from `node:crypto`, N=16384, r=8, p=1, 16-byte salt, 64-byte key, stored as
  `scrypt$16384$8$1$<salt b64>$<key b64>`. Compared with `timingSafeEqual`.
* API keys: `gw_` + 8 chars `[a-z0-9]` (prefix) + `_` + 32 chars base64url random. Only
  `sha256(fullKey)` is stored. Plaintext is returned exactly once at creation. Lookup: by prefix,
  then `timingSafeEqual` on the hash.
* Invite tokens: 32 bytes base64url, sha256 stored, 7-day expiry, single use.
* Upstream credentials: AES-256-GCM with `GATEWAY_ENCRYPTION_KEY` (base64 of 32 random bytes).
  Decrypted only in memory when connecting to the upstream. Never serialised into any API response.
* Session cookie: name `gw_session`, `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when
  `COOKIE_SECURE=true`, 7-day expiry; value is the `sessions.id`.

## 7. Gateway environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port (API, MCP, dashboard proxy not needed) |
| `METRICS_PORT` | `9090` | Prometheus `/metrics` |
| `DATABASE_URL` | required | `postgres://user:pass@host:5432/db` |
| `GATEWAY_ENCRYPTION_KEY` | required | base64 32 bytes |
| `SESSION_SECRET` | required | reserved for signing; sessions are random ids |
| `PUBLIC_URL` | required | e.g. `http://gateway.127.0.0.1.nip.io`; used for invite links and the "connect" page |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | required | bootstrap admin, created only if no admin exists |
| `DEMO_MEMBER_EMAIL`, `DEMO_MEMBER_PASSWORD` | optional | bootstrap a member (user B for the demo) |
| `SEED_SERVERS_JSON` | `[]` | JSON array, see §8 |
| `WOO_MCP_TOKEN`, `NOTES_MCP_TOKEN`, `UTILS_MCP_TOKEN` | optional | referenced by seed entries via `authSecretEnv` |
| `LLM_PROVIDER` | `none` | `anthropic` \| `openai_compatible` \| `mock` \| `none` |
| `ANTHROPIC_API_KEY` | | for `anthropic` |
| `LLM_MODEL` | `claude-opus-5-5` | model id for the chosen provider |
| `LLM_BASE_URL`, `LLM_API_KEY` | | for `openai_compatible` (e.g. Ollama `http://ollama:11434/v1`) |
| `LLM_EFFORT` | unset | optional `low`/`medium`/`high` passed as `output_config.effort` (anthropic only) |
| `CHAT_MAX_ITERATIONS` | `8` | tool loop cap |
| `CHAT_TOOL_SEARCH_THRESHOLD` | `40` | above this many visible tools the chat agent switches to search+execute meta-tools |
| `HEALTH_INTERVAL_MS` | `15000` | upstream probe interval |
| `DEFAULT_TOOL_TIMEOUT_MS` | `30000` | per-call timeout when a server has none |
| `LIST_TOOLS_TIMEOUT_MS` | `10000` | probe / tools/list timeout |
| `CONNECT_TIMEOUT_MS` | `5000` | initialize timeout |
| `ALLOW_PRIVATE_UPSTREAMS` | `false` | allow RFC1918 upstream addresses (local dev) |
| `ALLOWED_INTERNAL_SUFFIXES` | `.svc.cluster.local,.svc` | hostnames ending with these may resolve to private ranges |
| `RATE_LIMIT_PER_MINUTE` | `120` | tool calls per API key per minute (in-memory token bucket) |
| `MCP_ALLOWED_ORIGINS` | `http://localhost:6274,http://127.0.0.1:6274` | extra origins allowed to send an `Origin` header to `/mcp` (browser-based MCP clients such as the Inspector web UI); `PUBLIC_URL`'s origin and `CORS_ORIGIN` are always allowed |
| `COOKIE_SECURE` | `false` | set `true` behind TLS |
| `TRUST_PROXY` | `true` | Express `trust proxy` |
| `LOG_LEVEL` | `info` | pino level |

## 8. Seed servers

`SEED_SERVERS_JSON` example (mounted from a ConfigMap; the secret values come from env):

```json
[
  {"slug":"woo","name":"WooCommerce (demo store)","url":"http://demo-woo-mcp.store-demo.svc.cluster.local:8080/mcp","authType":"bearer","authSecretEnv":"WOO_MCP_TOKEN","timeoutMs":30000},
  {"slug":"notes","name":"Team notes","url":"http://platform-mcp-notes.mcp-platform.svc.cluster.local:8080/mcp","authType":"bearer","authSecretEnv":"NOTES_MCP_TOKEN"},
  {"slug":"utils","name":"Utilities","url":"http://platform-mcp-utils.mcp-platform.svc.cluster.local:8080/mcp","authType":"header","authHeaderName":"X-Api-Key","authSecretEnv":"UTILS_MCP_TOKEN"}
]
```

Seeding runs after migrations on every start: a seed entry is inserted only if its slug does not
exist (`managed_by = 'seed'`); existing rows are never overwritten, so admin edits survive restarts.

## 9. Gateway REST API (`/api`, JSON)

Auth: the `gw_session` cookie. Every error is `{"error":"<code>","message":"<human text>"}` with
status 400/401/403/404/409/429/500. Admin-only routes return 403 for members.
Users are serialised as `{id,email,name,role,status,createdAt}`. Timestamps are ISO 8601 UTC.

| Method & path | Who | Body / query | Response |
|---|---|---|---|
| `POST /api/auth/login` | anyone | `{email,password}` | `{user}` + cookie |
| `POST /api/auth/logout` | session | | `{ok:true}` |
| `GET /api/auth/me` | session | | `{user}` |
| `POST /api/auth/accept-invite` | anyone | `{token,name,password}` | `{user}` + cookie |
| `GET /api/config` | anyone | | `{publicUrl, mcpUrl, chat:{enabled,provider,model}, version}` |
| `GET /api/servers` | session | | `{servers:[Server]}` (members: no `url`, no auth fields, tools filtered by policy) |
| `POST /api/servers` | admin | `ServerInput` | `{server}` (201); probes once before returning |
| `GET /api/servers/:id` | session | | `{server}` |
| `PATCH /api/servers/:id` | admin | partial `ServerInput`; `authSecret` omitted = unchanged, `""` = cleared | `{server}` |
| `DELETE /api/servers/:id` | admin | | `{ok:true}` |
| `POST /api/servers/:id/refresh` | admin | | `{server}` after a fresh probe |
| `GET /api/tools` | session | | `{tools:[PublicTool]}` exactly what this user sees over MCP |
| `GET /api/users` | admin | | `{users:[User]}` |
| `POST /api/users/invite` | admin | `{email,name?,role}` | `{user, inviteUrl}` (201) |
| `PATCH /api/users/:id` | admin | `{role?,status?('active'|'disabled'),name?}` | `{user}` |
| `DELETE /api/users/:id` | admin | | `{ok:true}` (cannot delete self) |
| `GET /api/users/:id/keys` | admin | | `{keys:[ApiKey]}` |
| `POST /api/users/:id/keys` | admin | `{name}` | `{key:ApiKey, plaintext}` (201) |
| `GET /api/keys` | session | | `{keys:[ApiKey]}` own keys |
| `POST /api/keys` | session | `{name}` | `{key:ApiKey, plaintext}` (201) |
| `DELETE /api/keys/:id` | owner or admin | | `{ok:true}` (revokes: sets `revoked_at`) |
| `GET /api/audit` | session | `?limit=50&before=<id>&userId&serverId&outcome&source` | `{entries:[AuditEntry], nextBefore}` members see only their own |
| `POST /api/chat` | session | `{messages:[{role:'user'|'assistant',content:string}]}` | SSE stream, see §11 |

Types:

```ts
type ServerStatus = 'connected' | 'unreachable' | 'disabled';
type MemberToolPolicy = { mode: 'all' } | { mode: 'allowlist' | 'denylist'; patterns: string[] }; // glob with *

interface ServerInput {
  slug: string; name: string; url: string; enabled?: boolean;
  authType: 'none' | 'bearer' | 'header'; authHeaderName?: string; authSecret?: string;
  timeoutMs?: number; memberToolPolicy?: MemberToolPolicy;
}
interface Server {               // never contains the secret
  id: string; slug: string; name: string; url?: string; enabled: boolean;
  authType: 'none'|'bearer'|'header'; authHeaderName?: string; hasCredential: boolean;
  timeoutMs: number; memberToolPolicy: MemberToolPolicy; managedBy: 'admin'|'seed'|'provisioner';
  status: ServerStatus; statusError?: string; statusCheckedAt?: string; toolsUpdatedAt?: string;
  tools: Array<{ name: string; publicName: string; title?: string; description?: string;
                 allowedForMembers: boolean; annotations?: Record<string, unknown> }>;
  createdAt: string; updatedAt: string;
}
interface PublicTool { publicName: string; serverSlug: string; serverName: string; name: string;
  title?: string; description?: string; inputSchema: object; annotations?: object }
interface ApiKey { id: string; userId: string; name: string; prefix: string; createdAt: string;
  lastUsedAt?: string; revokedAt?: string }
interface AuditEntry { id: number; ts: string; userId?: string; userEmail: string; apiKeyId?: string;
  source: 'mcp'|'chat'; serverId?: string; serverSlug?: string; toolName?: string; publicToolName: string;
  durationMs: number; outcome: string; errorMessage?: string; argsPreview?: string; resultBytes?: number }
```

## 10. Gateway MCP endpoint (`/mcp`)

* Auth: `Authorization: Bearer <gw_key>` or `X-Api-Key: <gw_key>`. Missing or invalid key, revoked
  key, or disabled user: `401` with `WWW-Authenticate: Bearer error="invalid_token", error_description="<why>"`
  (no `resource_metadata`) and JSON body `{"error":"invalid_token","error_description":"<why>"}`.
  Claude Code prints that description on its "Issue:" line when a configured header is rejected and
  never starts OAuth for a server whose Authorization header the user configured. Keys are never
  accepted in the query string. The OAuth discovery paths `/.well-known/oauth-protected-resource*`,
  `/.well-known/oauth-authorization-server*`, `/.well-known/openid-configuration*`, `/register`,
  `/authorize`, `/token` answer `404` JSON immediately so SDK clients that try discovery fail fast.
* Origin: if an `Origin` header is present and is not `PUBLIC_URL`'s origin (or `CORS_ORIGIN`), `403`.
* Protocol era: the gateway implements MCP 2025-11-25 Streamable HTTP (SDK 1.32.x). Clients on the
  2026-07-28 revision (Claude Code v2 runtime, Inspector 2.x) probe with `server/discover`, receive the
  SDK's `400` `-32000 Unsupported protocol version` and fall back to `initialize` automatically.
* Streamable HTTP, stateless. Server info `{name:'urumi-mcp-gateway', version}`; capabilities
  `{tools:{}}`. `GET`/`DELETE` → 405.
* `tools/list`: all visible tools (enabled servers, member policy applied) with public names.
* `tools/call`:
  * unknown public name → JSON-RPC error `-32602` `Unknown tool: <name>` (audit outcome `not_found`)
  * tool hidden by policy → JSON-RPC error `-32602` `Tool not permitted for your role` (`denied`)
  * server disabled → JSON-RPC error `-32602` `Server <slug> is disabled` (`denied`)
  * rate limit → JSON-RPC error `-32000` `Rate limit exceeded` (`rate_limited`)
  * upstream timeout → tool result `isError:true`, text `Upstream "<slug>" timed out after <n> ms` (`timeout`)
  * upstream unreachable / transport failure → `isError:true`, text `Upstream "<slug>" is unreachable: <reason>` (`unreachable`)
  * upstream returned `isError:true` or threw a JSON-RPC error → forwarded as `isError:true` (`error`)
  * success → upstream result forwarded unchanged (`success`)
* Every `tools/call` writes exactly one audit row, including failures.

## 11. Chat SSE protocol (`POST /api/chat`)

Response `Content-Type: text/event-stream`. Each event is `event: <type>\ndata: <json>\n\n`.

| event | data |
|---|---|
| `start` | `{model, provider, toolCount}` |
| `text` | `{delta}` streamed assistant text (may arrive once per iteration when the provider does not stream) |
| `tool_call` | `{id, publicName, serverSlug, toolName, args}` |
| `tool_result` | `{id, publicName, outcome, durationMs, preview}` preview ≤ 500 chars |
| `done` | `{message, toolCalls:[...]}` final assistant text and the list of calls |
| `error` | `{message}` then the stream ends |

The chat agent executes tools through the same core function as the MCP endpoint
(`core.callTool(user, publicName, args, {source:'chat'})`), so permission checks and audit rows are
identical, attributed to the logged-in user with `source='chat'`.

## 12. WooCommerce MCP server (`apps/woo-mcp`)

Env: `PORT=8080`, `WOO_BASE_URL` (e.g. `http://demo-wordpress:80`), `WOO_USERNAME`,
`WOO_APP_PASSWORD` (WordPress application password), `MCP_AUTH_TOKEN`, `STORE_NAME`,
`STORE_URL` (public storefront URL for permalinks in descriptions), `WOO_TIMEOUT_MS=15000`.

Talks to WooCommerce through the REST API `wp-json/wc/v3` with HTTP Basic auth
(username + application password). Tools:

| tool | input | notes |
|---|---|---|
| `list_products` | `{search?, status?('any'|'publish'|'draft'|'pending'|'private'), per_page?(1-100, default 20), page?}` | returns `{products:[{id,name,sku,price,regular_price,status,stock_status,permalink,date_created}], total, page}` |
| `get_product` | `{id}` | full product summary |
| `create_product` | `{name, regular_price(string or number), description?, short_description?, sku?, status?(default 'publish'), manage_stock?, stock_quantity?}` | creates a `simple` product, returns the product summary incl. `permalink` |
| `list_orders` | `{status?, after?, before?, per_page?(default 20), page?, search?}` | `after`/`before` accept `YYYY-MM-DD` (expanded to start/end of day in the store's timezone) or full ISO 8601; returns `{orders:[{id,number,status,total,currency,date_created,customer_name,customer_email,payment_method_title,line_items:[{name,quantity,total}]}], total, page}` |
| `get_order` | `{id}` | full order incl. billing/shipping and line items |
| `update_order_status` | `{id, status('pending'|'processing'|'on-hold'|'completed'|'cancelled'|'refunded'|'failed'), note?}` | returns the updated order summary |

`GET /readyz` returns 200 only when `WOO_BASE_URL/wp-json/` answers (cached for 10 s).

## 13. Extra MCP servers (`apps/extra-mcp`)

One package, two entrypoints (`npm run start:notes`, `npm run start:utils`; Docker image runs
`node dist/<name>.js`, chosen by `SERVER=notes|utils` env). Both take `PORT`, `MCP_AUTH_TOKEN`.

`notes` (bearer auth, in-memory store, stateful within pod lifetime):
`create_note {title, body, tags?[]}`, `list_notes {tag?, search?}`, `get_note {id}`,
`delete_note {id}`, `get_current_time {}` (deliberate name collision with utils).

`utils` (`X-Api-Key` auth): `get_current_time {timezone?}`, `calculate {expression}` (safe arithmetic
only), `convert_currency {amount, from, to}` (static rate table, documents the rates), `generate_uuid {}`.

## 14. Helm charts

Both charts: `apiVersion: v2`, Helm 3 and 4 compatible, `helm lint` clean, every workload has
liveness + readiness probes, resource requests and limits, `securityContext` (runAsNonRoot,
drop ALL, no privilege escalation), and every Secret value comes from values (never literal in
templates). `values-local.yaml` and `values-prod.yaml` only override: hosts, ingress class and
annotations, storage class and sizes, image registry/tag/pullPolicy, TLS, replica counts, and
`gateway.allowPrivateUpstreams`.

`charts/store` values (key ones):

```yaml
store:
  name: "Demo Store"
  host: store.127.0.0.1.nip.io
  currency: USD
  country: "US:CA"
  adminUser: admin
  adminEmail: admin@example.com
  sampleProduct: { enabled: true, name: "Demo Mug", price: "12.00" }
secrets:                      # provided at deploy time (deploy/secrets/*.yaml), never committed
  adminPassword: ""           # WordPress admin
  dbPassword: ""
  dbRootPassword: ""
  mcpAuthToken: ""            # bearer the gateway must present to woo-mcp
  wooAppPassword: ""          # 24 alphanumeric chars; the WordPress application password of the
                              # mcp-bot (shop_manager) user. The setup job installs this exact value
                              # into WordPress (wp eval + WP_Application_Passwords::set_user_application_passwords
                              # with WP_Application_Passwords::hash_password), so woo-mcp can read it
                              # from the same Secret. Alphanumeric only: WordPress strips other chars.
gateway:
  namespace: mcp-platform     # allowed to reach woo-mcp (NetworkPolicy)
wordpress: { image: {repository: wordpress, tag: ...}, persistence: {size: 5Gi, storageClass: ""}, resources: {...} }
mariadb:   { image: {repository: mariadb, tag: ...}, persistence: {size: 5Gi, storageClass: ""}, resources: {...} }
wooMcp:    { image: {repository: urumi/woo-mcp, tag: dev, pullPolicy: IfNotPresent}, resources: {...} }
ingress:   { className: traefik, annotations: {}, tls: [] }
networkPolicy: { enabled: true }
quota: { enabled: false }     # ResourceQuota + LimitRange (used by provisioned stores)
```

`charts/platform` values (key ones):

```yaml
host: gateway.127.0.0.1.nip.io
publicScheme: http
ingress: { className: traefik, annotations: {}, tls: [] }
gateway:
  image: { repository: urumi/gateway, tag: dev, pullPolicy: IfNotPresent }
  replicas: 1
  allowPrivateUpstreams: false
  allowedInternalSuffixes: ".svc.cluster.local,.svc"
  llm: { provider: none, model: claude-opus-5-5, baseUrl: "" }
  seedServers: [ ... as in §8 ... ]
  resources: {...}
dashboard: { image: {...}, replicas: 1 }
postgres:  { image: {repository: postgres, tag: 17-alpine}, persistence: {size: 2Gi, storageClass: ""} }
mcpNotes:  { enabled: true, image: {repository: urumi/extra-mcp, tag: dev} }
mcpUtils:  { enabled: true, image: {repository: urumi/extra-mcp, tag: dev} }
secrets:                       # from deploy/secrets/platform.yaml
  adminEmail: admin@example.com
  adminPassword: ""
  demoMemberEmail: member@example.com
  demoMemberPassword: ""
  encryptionKey: ""            # base64 32 bytes
  sessionSecret: ""
  postgresPassword: ""
  anthropicApiKey: ""
  llmApiKey: ""
  wooMcpToken: ""              # must equal the store chart's secrets.mcpAuthToken
  notesMcpToken: ""
  utilsMcpToken: ""
networkPolicy: { enabled: true }
```

## 15. Local workflow (Makefile targets)

| target | does |
|---|---|
| `make tools-check` | verifies docker, kind, kubectl, helm are on PATH |
| `make secrets` | writes `deploy/secrets/{platform,store}.yaml` with random values if missing |
| `make kind-up` | creates cluster from `deploy/kind/kind-config.yaml`, installs ingress-nginx (and Calico when `NETPOL=1`, default on), waits |
| `make build` | builds the four images with tag `dev` |
| `make load` | `kind load docker-image` for the four images |
| `make deploy` | `helm upgrade --install` store then platform with `values-local.yaml` + secrets |
| `make local-up` | all of the above |
| `make local-down` | `kind delete cluster` |
| `make test` | runs `npm test` in every app |
| `make lint` | `helm lint` both charts with both values files, `helm template` dry-run |
| `make status` | prints pods, ingresses, URLs |

Environment overrides: `KIND`/`HELM` paths, `DOMAIN` (default `127.0.0.1.nip.io`), `NETPOL`.
