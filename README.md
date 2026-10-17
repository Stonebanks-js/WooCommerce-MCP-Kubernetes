# Urumi MCP Gateway on Kubernetes

A WooCommerce hosting platform with a team MCP gateway, built for the Urumi AI FDE internship
Round 1 assignment. One Helm release runs a WooCommerce store (WordPress + MariaDB) with a
self-written WooCommerce MCP server; a second runs the gateway, its Postgres, the React dashboard
and two extra MCP servers. Admins register MCP servers once; every team member reaches all of them
through a single MCP endpoint (Claude Code, Cursor, MCP Inspector) and through the dashboard's chat
agent, with per-user hashed API keys and a full audit log.

```
 shopper ──► Ingress ──► WordPress ──► MariaDB                       namespace store-demo
                                 ▲  REST /wp-json/wc/v3 (app password)
                             woo-mcp  ◄── only gateway pods (NetworkPolicy)
                                 ▲
 Claude Code / Cursor ──► Ingress ──► gateway ──► mcp-notes, mcp-utils    namespace mcp-platform
 browser ──► Ingress ──► dashboard ──► gateway (/api, /mcp) ──► Postgres
 chat agent = code inside the gateway acting as the logged-in user
```

Documents: [system design and tradeoffs](docs/system-design.md) ·
[threat model](docs/threat-model.md) · [demo script](docs/demo-script.md) ·
[stand-out items](docs/standouts.md) · [contracts (API, schema, env)](docs/contracts.md) ·
[deploy notes (kind, k3s, domains)](deploy/README.md)

## Repository layout

| Path | What |
|---|---|
| `apps/gateway` | Node 22 + TypeScript. REST API for the dashboard, the MCP endpoint (`/mcp`, Streamable HTTP, stateless), the upstream registry, the chat agent, Prometheus metrics. Postgres. |
| `apps/dashboard` | React 19 + Vite SPA served by nginx-unprivileged. Servers, chat, audit log, API keys, team. |
| `apps/woo-mcp` | The WooCommerce MCP server (written here, not a plugin): products and orders as tools over Streamable HTTP, talks to the store through the WooCommerce REST API. |
| `apps/extra-mcp` | Two more upstream servers used in the demo: `notes` (team notes, bearer auth) and `utils` (time, calculator, currency, uuid; `X-Api-Key` auth). |
| `charts/store` | Helm chart for one store: MariaDB, WordPress, setup Job, woo-mcp, Ingress, NetworkPolicies. |
| `charts/platform` | Helm chart for Postgres, gateway, dashboard, notes, utils, Ingress, NetworkPolicies. |
| `deploy/` | kind config, scripts, generated secrets (git-ignored). |

## Local setup (kind)

Prerequisites: Docker (Linux containers), `kind` ≥ 0.33, `kubectl`, `helm` 3 or 4, Node 22+ (only for
running the tests), `make`, Git Bash on Windows. Nothing else; the scripts install Traefik into the cluster.
Every `make` target is a thin wrapper around a script in `deploy/scripts/`, so without `make` (typical on
Windows) run the script directly, for example `bash deploy/scripts/kind-up.sh`; `KIND`, `HELM`, `KUBECTL` and
`DOCKER` environment variables point the scripts at binaries that are not on `PATH`.

```bash
make tools-check
make secrets          # writes deploy/secrets/{platform,store}.yaml with random values (git-ignored)
make local-up         # kind cluster + Traefik + builds and loads the 4 images + both Helm releases
make status           # pods, ingresses and the URLs below
```

The first run takes several minutes: the store's setup Job installs WordPress and WooCommerce
(`kubectl -n store-demo logs job/demo-setup -f` to watch).

| | URL |
|---|---|
| Storefront | http://store.127.0.0.1.nip.io |
| WordPress admin | http://store.127.0.0.1.nip.io/wp-admin (user `admin`, password in `deploy/secrets/store.yaml`) |
| Dashboard | http://gateway.127.0.0.1.nip.io (admin and demo member passwords in `deploy/secrets/platform.yaml`) |
| Gateway MCP endpoint | http://gateway.127.0.0.1.nip.io/mcp |

Local domains: `*.127.0.0.1.nip.io` resolves to `127.0.0.1` through public DNS, so browsers and
CLI tools work without touching the hosts file. Alternatives (offline machines, or if nip.io is
blocked) are in [deploy/README.md](deploy/README.md): `store.localhost` works in browsers only, or add
`127.0.0.1 store.local gateway.local` to the hosts file and set `DOMAIN=local`.

To enable the chat agent, put an LLM key in `deploy/secrets/platform.yaml` (`anthropicApiKey`) and set
`gateway.llm.provider: anthropic` in `charts/platform/values-local.yaml` (default model
`claude-opus-5-5`; `claude-haiku-5-5` is the cheap option). Any OpenAI-compatible endpoint works with
`provider: openai_compatible` + `baseUrl` (Ollama, Groq, OpenRouter), and `provider: mock` demonstrates
the tool loop without any key. Re-run `make deploy`.

Tear down: `make local-down`.

## Production-like setup (k3s on a VPS)

See [deploy/README.md](deploy/README.md) for the full procedure. In short:

1. `curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=v1.36.5+k3s1 K3S_KUBECONFIG_MODE=644 sh -`
   on the VPS; open 80, 443 and 6443; point `store.<domain>` and `gateway.<domain>` at the VPS.
2. Push the four images to a registry (or sideload them with `deploy/scripts/k3s-load-images.sh`).
3. Copy `deploy/secrets/*.yaml` (generated once, kept out of git) to the VPS.
4. `DOMAIN=example.com deploy/scripts/k3s-deploy.sh` runs the same two `helm upgrade --install`
   commands with `values-prod.yaml`: Traefik ingress class, `local-path` storage class, registry
   images, TLS block (cert-manager optional), bigger resources, two gateway replicas.

Everything that differs between local and production is in `charts/*/values-local.yaml` vs
`charts/*/values-prod.yaml`; the templates are identical.

## How to place an order

Open the storefront, add the sample product to the cart, check out as a guest with **Cash on
delivery**. The order appears in WordPress admin → WooCommerce → Orders, and `woo__list_orders`
returns it (see the [demo script](docs/demo-script.md) for the full two-user flow).

## How to connect an external MCP client

1. Log in to the dashboard → *API keys* → *Create key*. Copy it: it is shown once and stored hashed.
2. Claude Code:

   ```bash
   claude mcp add --transport http urumi-gateway http://gateway.127.0.0.1.nip.io/mcp --header "Authorization: Bearer <your key>"
   claude mcp list
   ```

   Cursor (`~/.cursor/mcp.json`):

   ```json
   { "mcpServers": { "urumi-gateway": { "url": "http://gateway.127.0.0.1.nip.io/mcp", "headers": { "Authorization": "Bearer <your key>" } } } }
   ```

   MCP Inspector:

   ```bash
   npx @modelcontextprotocol/inspector --cli --transport http --server-url http://gateway.127.0.0.1.nip.io/mcp --header "Authorization: Bearer <your key>" --method tools/list
   ```

3. Tools are named `<server>__<tool>` (for example `woo__list_orders`, `utils__convert_currency`);
   the *Connect* panel on the API keys page shows these snippets with your gateway URL filled in.

## How to use the chat agent

Dashboard → *Chat*. The agent acts as the logged-in user: it sees exactly the tools that user may
call, every call it makes is written to the audit log under that user with `source = chat`, and each
tool call is shown as a card (tool, arguments, outcome, duration, result preview). Try
*"Create a product called Demo Hoodie priced 49"* and *"What orders came in today?"*.

## Tests

```bash
make test        # npm test in every app (no Docker or cluster needed; the gateway tests run on an in-process Postgres)
make lint        # helm lint + helm template for both charts with both values files
```

## Upgrades and rollback

Images are tagged per build (`TAG=v2 make build load deploy`). `helm upgrade --install` rolls the
new tag out; `helm history platform -n mcp-platform` lists revisions and
`helm rollback platform <revision> -n mcp-platform` returns to a previous one. Gateway migrations are
additive and the store setup Job is idempotent, so both directions are safe.

## Verification status (honest account)

| What | How it was verified |
|---|---|
| Gateway, WooCommerce MCP server, extra MCP servers, dashboard | Unit + integration tests in each package (`make test`): gateway 42 (in-process Postgres + fake upstreams), woo-mcp 44 (fake WooCommerce REST), extra-mcp 94, dashboard 19 + a browser walk-through of every page against the mock API |
| External MCP clients | MCP Inspector 2.x CLI and Claude Code (`claude mcp add … --header`) against the gateway running locally: namespaced tool list, member tool policy hiding a tool, routed calls, `disable` removing tools, a killed upstream reported as `unreachable` with `connect ECONNREFUSED`, chat tool loop (mock provider), audit attribution, key revocation shown by Claude Code as "Failed to connect … API key has been revoked" |
| Helm charts | `helm lint --strict` and `helm template` for both charts with both values files, kubeconform (strict), plus rendered-manifest invariants (no literal secrets, probes and resources on every workload, no Ingress for woo-mcp, NetworkPolicy admits only gateway pods) |
| Full stack on kind (kind v0.33 + Traefik, WordPress 7.1.3 + WooCommerce 11.2.1, real setup Job, NetworkPolicies) | **Run on 2026-10-17**: `make local-up` equivalent scripts from a clean cluster; setup Job completed and verified the mcp-bot application password over REST (HTTP 200); storefront served through the ingress; chat (mock provider) created a product that appeared on the storefront; a guest Cash-on-delivery order placed through the WooCommerce Store API (the checkout block's own API) showed up as *processing*; `woo__list_orders` returned it for user A (chat) and user B (Inspector through the ingress); Claude Code connected with user B's key and reported the revoked key as rejected; disabling `utils` removed its tools from user B's list; scaling `notes` to 0 showed *Unreachable* while `woo` kept working; a busybox pod in the store namespace could not reach `woo-mcp` while the gateway pod could; audit rows attribute every call to the right user and source; `/metrics` counts them. Three bugs were found only on the cluster and fixed: the Traefik chart's service key (`service.spec.type`), a protected WordPress method in the app-password install, and Helm `--set` replacing a seed list entry |
