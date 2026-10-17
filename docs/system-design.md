# System design and tradeoffs

## The system in one paragraph

Two Helm releases. `store` (namespace `store-demo`) runs MariaDB, WordPress + WooCommerce, a
one-shot setup Job that installs the shop, and the self-written WooCommerce MCP server (`woo-mcp`).
`platform` (namespace `mcp-platform`) runs Postgres, the gateway, the dashboard and two extra MCP
servers (`notes`, `utils`). External MCP clients and the dashboard's chat agent only ever talk to the
gateway at `https://<gateway host>/mcp`; the gateway is an MCP client to every registered upstream
and the only component that holds upstream credentials.

```
 shopper ──► Ingress ──► WordPress ──► MariaDB            (store-demo)
                                 ▲
                                 │ REST /wp-json/wc/v3 (Basic auth, app password)
                             woo-mcp  ◄── NetworkPolicy: only gateway pods
                                 ▲
 Claude Code / Cursor ──► Ingress ──► gateway ──► notes-mcp, utils-mcp   (mcp-platform)
 dashboard (browser) ──► Ingress ──► dashboard (static) / gateway (/api, /mcp)
 chat agent = code inside the gateway, acting as the logged-in user
                                 │
                              Postgres (users, keys, servers, audit)
```

## Architecture choices

| Choice | Why | Alternative considered |
|---|---|---|
| One TypeScript stack (Express 5 + official MCP SDK) for gateway and all MCP servers | The official SDK has both a Streamable HTTP client and server; one language keeps the demo explainable end to end | Python/FastMCP for servers; rejected to avoid two toolchains |
| Gateway speaks **stateless** Streamable HTTP | No session affinity needed, so multiple gateway replicas work behind a plain Ingress; every request is authenticated by API key anyway | Stateful sessions with `Mcp-Session-Id`; needs sticky routing or shared session state |
| Gateway uses the SDK's low-level `Server` for its MCP endpoint | It is the only way to forward upstream tools' JSON Schemas verbatim; the high-level `McpServer` only accepts zod schemas | Re-generating schemas from zod loses upstream details |
| MCP protocol revision 2025-11-25 via `@modelcontextprotocol/sdk` 1.32.x (the maintenance line) | Every current client (Claude Code, Cursor, Inspector 2.x) still speaks it; clients on the newer 2026-07-28 revision probe with `server/discover`, get the SDK's `400 Unsupported protocol version` and fall back to `initialize` automatically; the stateless design maps one-to-one onto the newer revision's per-request model | SDK v2 (`@modelcontextprotocol/server` 2.x, dual-era `createMcpHandler`); it is the upgrade path, but it shipped in July 2026 and the v1 line is still supported, so the better-understood API won for a two-week build |
| API-key failures answer `401` + `WWW-Authenticate: Bearer error="invalid_token"` without `resource_metadata`, and the OAuth discovery paths return 404 | Clients that try OAuth discovery fail fast with a readable reason instead of hanging; Claude Code shows the `error_description` on its "Issue:" line and never starts OAuth for a server whose Authorization header you configured | Full MCP OAuth (stand-out item, not attempted) |
| Postgres for the gateway (StatefulSet) | Real stateful workload on Kubernetes; multi-replica gateway safe; `jsonb` for cached tool lists and policies | SQLite on a PVC (single replica only) |
| Dashboard is a separate nginx Deployment, gateway serves `/api` and `/mcp` | Mirrors the assignment's "gateway backend and dashboard" as distinct workloads; static assets never share a process with secrets | Serving the SPA from Express (simpler, one image) |
| WooCommerce access through the REST API with a WordPress **application password** for a dedicated `shop_manager` user | Standard WP core auth, revocable from WP admin, least privilege, no OAuth1 signing code; TLS terminates at the Ingress so a mu-plugin enables app passwords over in-cluster HTTP | WooCommerce consumer key/secret (Basic auth is refused over plain HTTP, needs OAuth 1.0a); WP-CLI via `kubectl exec` (needs cluster RBAC); direct SQL (bypasses WooCommerce logic) |
| Deterministic application password installed by the setup Job from the Secret | woo-mcp and WordPress read the same Secret; no component needs Kubernetes API rights to copy a generated password around | Job writes a generated password into a Secret (needs a Role) |
| Two extra upstreams written in-repo (`notes`, `utils`) | Self-contained demo, deliberate tool-name collision (`get_current_time`), two credential types (bearer vs custom header), a two-server prompt (orders in EUR) | Public third-party MCP servers (documented as an option for "add by URL") |
| Chat agent runs in-process in the gateway, calling the same `callTool(user, …)` as the MCP endpoint | Guarantees identical permission checks and audit attribution; needs no API key for the browser session | Chat as an MCP client over HTTP to its own endpoint (duplicated auth, extra hop) |
| LLM provider is pluggable (`anthropic` default, `openai_compatible` for Ollama/free tiers, `mock` for tests and keyless demos) | The assignment grades the tool loop, not the model; a mock keeps CI and the kind demo deterministic | Hard-wiring one vendor |
| Local domains `*.127.0.0.1.nip.io` by default | Works in browsers *and* CLI tools (Claude Code, curl) without editing the hosts file; `*.localhost` does not resolve for Node/curl on Windows | hosts-file entries (documented alternative) |

## Tool aggregation, routing and failure handling

**Registry.** On start and every `HEALTH_INTERVAL_MS` (15 s) the gateway reloads the `mcp_servers`
rows and probes every enabled server: `initialize` (5 s timeout) then `tools/list` (10 s timeout),
all servers concurrently with `Promise.allSettled`. Success stores the raw tool list in
`tools_json` and marks the server `connected`; failure marks it `unreachable` with a short reason
(`connect ECONNREFUSED …`, `HTTP 401 from upstream`, `timeout after 10000 ms`). Disabled servers are
never contacted. Admin mutations (add/edit/disable/remove/refresh) probe synchronously so the
dashboard shows the live status in the response.

**Naming.** A public tool is `<slug>__<tool>`; the slug is the admin-chosen server identifier, so two
servers exposing `get_current_time` become `notes__get_current_time` and `utils__get_current_time`.
Descriptions are prefixed with the server's display name. Names longer than 64 characters (the limit
most model APIs impose) are truncated with a hash suffix, and the gateway keeps an exact
`public → (server, tool)` map, so routing never parses names heuristically.

**tools/list** = every cached tool of every enabled server, filtered by the caller's role policy.
Unreachable servers keep their last cached list (clients see a stable catalogue); calls to them fail
fast.

**tools/call** path: authenticate key → rate limit → resolve public name → check server enabled and
tool allowed for the role → `client.callTool` on that server's connection with the server's timeout
→ classify the outcome → write one audit row → return. Outcomes: `success`, `error` (upstream said
`isError` or returned a JSON-RPC error), `timeout`, `unreachable` (connection/HTTP failure; the server
is marked unreachable and its client dropped so the next call reconnects), `denied`, `not_found`,
`rate_limited`. Timeouts and unreachable upstreams are returned to the model as `isError` tool
results with a one-line explanation, so an agent can carry on with other tools instead of crashing
its turn.

**Isolation.** One connection object per upstream; a failure in one never touches another; each
probe and call has its own timeout; the SDK's request timeout does not abort the HTTP socket, so the
gateway installs a per-POST `AbortSignal.timeout` through a custom `fetch` to really cut slow
upstreams off.

**Chat agent.** Same core function, `source = chat`, at most `CHAT_MAX_ITERATIONS` tool rounds, and
when the visible catalogue exceeds `CHAT_TOOL_SEARCH_THRESHOLD` tools the model gets two meta-tools
(`search_tools`, `call_tool`) instead of hundreds of definitions; audit still records the real tool.

## Security summary

API keys: `gw_<prefix>_<secret>`, only the SHA-256 of the full key is stored, lookup by prefix,
timing-safe compare, revocable. Passwords: scrypt. Upstream credentials: AES-256-GCM with a key from a
Secret, never returned by any API. Upstream URLs: SSRF validation at registration and at connect time.
Every workload: non-root where the image allows it, dropped capabilities, no service-account token,
requests/limits, probes. NetworkPolicies: default deny, woo-mcp reachable only from gateway pods.
See `threat-model.md`.

## What changes for production (k3s on a VPS)

Only values (`values-prod.yaml`):

| Concern | Local (kind) | Production (k3s) |
|---|---|---|
| DNS / hosts | `store.127.0.0.1.nip.io`, `gateway.127.0.0.1.nip.io` | real records `store.example.com`, `gateway.example.com` → VPS IP |
| Ingress | `ingressClassName: traefik` (Traefik Helm chart installed by `make kind-up`, hostPorts 80/443 mapped to the host); ingress-nginx was retired in March 2026, so Traefik everywhere keeps local and production identical | `ingressClassName: traefik` (bundled with k3s); Traefik streams SSE without annotations |
| NetworkPolicy | enforced by kind's default CNI (kindnet ships kube-network-policies) | enforced by k3s' embedded controller; only the controller namespace differs (`traefik` vs `kube-system`) |
| TLS | none | `ingress.tls` block; cert-manager `ClusterIssuer` annotation optional |
| Storage class | `standard` (kind local-path) | `local-path` (k3s default) or a cloud class; sizes raised |
| Images | built locally, `kind load docker-image`, `pullPolicy: IfNotPresent` | pushed to a registry (`image.repository` + tag), `pullPolicy: Always` |
| Secrets | generated once by `make secrets` into git-ignored files | provided by the operator (`--set-file`/`-f` from a secrets store, or sealed secrets); same keys |
| Resources | small requests | real requests/limits, `gateway.replicas: 2` |
| `COOKIE_SECURE` / `publicScheme` | `false` / `http` | `true` / `https` |

Upgrade and rollback: images are tagged per build; `helm upgrade --install … --wait` rolls out a new
tag, `helm rollback <release> <revision>` returns to the previous one. The gateway's migrations are
additive, and the WordPress setup Job is idempotent, so both directions are safe for this project.
