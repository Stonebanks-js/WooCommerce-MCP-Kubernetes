# WooCommerce MCP Gateway on Kubernetes

Submission for the **Urumi AI FDE Internship, Round 1**. A WooCommerce hosting platform with a team
MCP gateway: one Helm release runs a WooCommerce store (WordPress + MariaDB) with a self-written
WooCommerce MCP server; a second runs the gateway, its Postgres, the React dashboard and two extra
MCP servers. Admins register MCP servers once; every team member reaches all of them through a
single MCP endpoint (Claude Code, Cursor, MCP Inspector) and through the dashboard's chat agent,
with per-user hashed API keys and a full audit log.

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

---

## 1. Definition of done: checklist

Every item below was executed on a real kind cluster on 2026-10-17 through the Ingress hosts.

### Store
- [x] Open the storefront, add a product to the cart, check out with Cash on delivery. Order placed as a guest; visible in WooCommerce admin as *processing* (order 13).

### Chat agent, as user A (admin)
- [x] "Create a product called Demo Scarf priced 19 dollars" → the agent calls `woo__create_product`; the product is live on the storefront.
- [x] Order placed by hand, then "What orders came in today?" → the agent calls `woo__list_orders` and returns that order with customer and total.

### External MCP client, as user B (member)
- [x] Claude Code connected with only the gateway URL and user B's key (`claude mcp list` → Connected). MCP Inspector CLI also verified.
- [x] Tools of every enabled server visible, namespaced `woo__*`, `notes__*`, `utils__*`; the same orders question succeeds.
- [x] One prompt needing two upstream servers: "What is the total value of today's orders, converted to EUR?" → `woo__list_orders` then `utils__convert_currency`.

### Team and control
- [x] Revoke user B's key → Claude Code reports "Server rejected the configured Authorization header (HTTP 401) … API key has been revoked".
- [x] Disable one upstream (`utils`) → its tools disappear for the chat agent and for the external client.
- [x] Kill an upstream pod (`notes` scaled to 0) → `woo` and `utils` keep working, dashboard shows `notes` as *Unreachable* with the reason.
- [x] Every call above is in the audit log, attributed to the right user and source (`chat` vs `mcp`), with server, tool, duration and outcome.

### Mandatory requirements
| Requirement | Status | Where |
|---|---|---|
| Runs on local Kubernetes (kind) | Done | `deploy/kind/kind-config.yaml`, `deploy/scripts/kind-up.sh` |
| Deployable to k3s with the same charts via values | Scripted and linted, not yet run on a VPS | `charts/*/values-prod.yaml`, `deploy/scripts/k3s-*.sh` |
| Helm only, values-local / values-prod | Done | `charts/store`, `charts/platform` |
| Everything in-cluster, persistent storage for DB and WordPress content | Done | MariaDB and Postgres StatefulSets, WordPress PVC |
| Ingress with stable URLs, local domain approach documented | Done (`*.127.0.0.1.nip.io`) | `deploy/README.md` |
| Readiness and liveness probes, requests and limits on every workload | Done, asserted by `make lint` | chart templates |
| No hardcoded secrets; Kubernetes Secrets | Done | Secrets rendered from git-ignored `deploy/secrets/*.yaml` |
| WooCommerce MCP server written here, Streamable HTTP, 5 required tools, unreachable from outside, store access documented | Done (6 tools) | `apps/woo-mcp`, store NetworkPolicy |
| Gateway: add/edit/disable/remove upstreams with bearer or header credential; one MCP endpoint; collision scheme; timeouts; credentials server-side; ≥3 upstreams | Done | `apps/gateway` |
| Roles admin/member; per-user hashed, revocable keys; audit log in dashboard | Done | `apps/gateway`, `apps/dashboard` |
| Chat agent with an LLM tool loop acting as the logged-in user; LLM key in a Secret | Done | `apps/gateway/src/chat` |

---

## 2. What is built, what is not

**Built and verified**
- `apps/gateway`: Express 5 + official MCP SDK. REST API, stateless Streamable HTTP `/mcp`, upstream registry with health probes and per-call timeouts, `<server>__<tool>` namespacing, per-role tool policy, SHA-256-hashed API keys, AES-256-GCM-encrypted upstream credentials, SSRF checks, audit log, Prometheus metrics, chat agent with Anthropic / OpenAI-compatible / mock providers. 42 tests on an in-process Postgres.
- `apps/woo-mcp`: the WooCommerce MCP server (REST + WordPress application password). 44 tests against a fake WooCommerce.
- `apps/extra-mcp`: `notes` (bearer auth) and `utils` (`X-Api-Key` auth), with a deliberate `get_current_time` name collision. 94 tests.
- `apps/dashboard`: React 19 + Vite. Servers, chat with tool cards, audit log, keys with connect snippets, team. 19 tests plus a browser walk-through.
- `charts/store`, `charts/platform`: strict lint, kubeconform, hardened security contexts, default-deny NetworkPolicies.
- Stand-out items done: per-role tool permissions, search-and-execute meta-tools for large catalogues, security hardening, stateless multi-replica gateway with per-key rate limit, metrics, documented upgrade/rollback. Details in [docs/standouts.md](docs/standouts.md).

**Not built**
- Bonus multi-store provisioning (no provisioner, no store list in the dashboard, no automatic registration or teardown). The store chart is already parameterised per store, so a provisioner would run `helm upgrade --install <store> charts/store -n <ns>`.
- OAuth on the gateway (API keys only; the 401 response is OAuth-discovery-safe).
- Hosted MCP servers by container image.
- A real VPS deployment (values and scripts exist, not executed).

**What worked, what did not**
- Worked first time: the gateway core, tool namespacing, policy and audit; the dashboard against the API; NetworkPolicy enforcement with kind's default CNI.
- Did not work until fixed on the cluster: the Traefik chart's service key (`service.spec.type`, otherwise `helm --wait` hangs on a pending LoadBalancer IP); the application-password install (`WP_Application_Passwords::set_user_application_passwords` is protected; the Job now writes the same user meta and verifies the hash); Helm `--set` on a list entry (replaces the whole entry; the seed URL is now derived from `store.release` / `store.namespace`).
- Did not work in the Anthropic provider until review: assistant turns were replayed without the model's thinking blocks, which the API rejects on the second tool iteration.
- NVIDIA's `nemotron-3-ultra-550b-a55b` returned 503 "overloaded" during testing; the sibling `nemotron-3-super-120b-a12b` is configured instead and verified.

---

## 3. Technical stack

| Layer | Choice | Why | Use in this project |
|---|---|---|---|
| Language | TypeScript (Node 22 in images) | One toolchain for gateway and MCP servers; the official MCP SDK has both client and server | all four apps |
| MCP | `@modelcontextprotocol/sdk` 1.32 | Streamable HTTP client and server in one package; low-level `Server` can forward upstream JSON Schemas verbatim | gateway endpoint and upstream connections, all MCP servers |
| HTTP | Express 5 | Minimal, matches the SDK's own examples; async error handling built in | REST API, `/mcp`, health, metrics |
| Gateway DB | PostgreSQL 17 (StatefulSet) | Real stateful workload on Kubernetes; `jsonb` for cached tool lists and policies; multi-replica safe | users, sessions, keys, servers, audit log |
| Test DB | PGlite | Real Postgres in WASM, in-process; no Docker needed for `npm test` | gateway integration tests |
| Dashboard | React 19 + Vite, nginx-unprivileged | Small, fast build; static assets never share a process with secrets | admin and member UI |
| Store | WordPress 7.1 + WooCommerce 11.2, MariaDB 11.8 | The assignment's store; official images | storefront, orders, products |
| Store access | WooCommerce REST + WordPress application password | Standard core auth, revocable, least privilege (`shop_manager`), no OAuth1 signing | `apps/woo-mcp` |
| LLM | OpenAI-compatible endpoint (NVIDIA Nemotron) by default; Anthropic and mock providers | Free tier for the demo; the assignment grades the tool loop, not the model | chat agent |
| Kubernetes | kind locally, k3s on a VPS | Required by the assignment | `deploy/` |
| Ingress | Traefik in both environments | ingress-nginx was retired in March 2026; Traefik ships with k3s, so local and prod are identical | both charts |
| Packaging | Helm 3/4-compatible charts | Mandatory; one chart per release, differences only in values | `charts/` |
| Policy | Kubernetes NetworkPolicy | Enforced by kind's default CNI and k3s' built-in controller; proves woo-mcp is gateway-only | both charts |
| Secrets | Kubernetes Secrets from git-ignored values | No credential in source or images; `helm template` fails without them | `deploy/secrets/` |
| Observability | prom-client, pino | Per-server call counts and latency; JSON logs | gateway `/metrics` |

---

## 4. Local setup (kind)

Prerequisites: Docker (Linux containers), `kind` ≥ 0.33, `kubectl`, `helm` 3 or 4, Node 22+ (tests only),
Git Bash on Windows. Every `make` target wraps a script in `deploy/scripts/`, so without `make` run the
scripts directly; `KIND`, `HELM`, `KUBECTL`, `DOCKER` env vars point at binaries not on `PATH`.

```bash
bash deploy/scripts/tools-check.sh
bash deploy/scripts/gen-secrets.sh     # random values into deploy/secrets/*.yaml (git-ignored)
bash deploy/scripts/kind-up.sh         # kind cluster + Traefik
bash deploy/scripts/build-images.sh
bash deploy/scripts/load-images.sh
bash deploy/scripts/deploy.sh          # store release, then platform release
bash deploy/scripts/status.sh
```

The first deploy takes several minutes: the store's setup Job installs WordPress and WooCommerce
(`kubectl -n store-demo logs job/demo-setup -f`).

| | URL / credentials |
|---|---|
| Storefront | http://store.127.0.0.1.nip.io |
| WordPress admin | http://store.127.0.0.1.nip.io/wp-admin, user `admin`, password `adminPassword` in `deploy/secrets/store.yaml` |
| Dashboard | http://gateway.127.0.0.1.nip.io |
| User A (admin) | `admin@example.com`, password `adminPassword` in `deploy/secrets/platform.yaml` |
| User B (member) | `member@example.com`, password `demoMemberPassword` in `deploy/secrets/platform.yaml` |
| Gateway MCP endpoint | http://gateway.127.0.0.1.nip.io/mcp |

Local domains: `*.127.0.0.1.nip.io` resolves to `127.0.0.1` through public DNS, so browsers and CLI
tools work without touching the hosts file (`*.localhost` does not resolve for Node on Windows).
Alternatives are in [deploy/README.md](deploy/README.md).

Chat agent: configured under `gateway.llm` in `charts/platform/values-local.yaml`; the key comes from
`deploy/secrets/platform.yaml` (`llmApiKey` for OpenAI-compatible endpoints, `anthropicApiKey` for
Anthropic). `provider: mock` demonstrates the loop without any key. Re-run `deploy.sh` after changes.

Tear down: `bash deploy/scripts/local-down.sh`.

## 5. Production-like setup (k3s)

See [deploy/README.md](deploy/README.md). In short: install k3s, point `store.<domain>` and
`gateway.<domain>` at the VPS, push the four images to a registry (or sideload them with
`deploy/scripts/k3s-load-images.sh`), copy `deploy/secrets/*.yaml`, run
`DOMAIN=example.com deploy/scripts/k3s-deploy.sh`. Only `values-prod.yaml` differs: Traefik class,
`local-path` storage, registry images, TLS block, resources, two gateway replicas.

## 6. How to place an order, connect a client, use the chat

- **Order**: open the storefront, add "Demo Mug" to the cart, check out as a guest with Cash on delivery. It appears in WordPress admin → WooCommerce → Orders.
- **External client**: Dashboard → API keys → Create key (shown once). Then

  ```bash
  claude mcp add --transport http urumi-gateway http://gateway.127.0.0.1.nip.io/mcp --header "Authorization: Bearer <your key>"
  ```

  Cursor (`~/.cursor/mcp.json`): `{ "mcpServers": { "urumi-gateway": { "url": "http://gateway.127.0.0.1.nip.io/mcp", "headers": { "Authorization": "Bearer <your key>" } } } }`.
  MCP Inspector: `npx @modelcontextprotocol/inspector --cli --transport http --server-url http://gateway.127.0.0.1.nip.io/mcp --header "Authorization: Bearer <your key>" --method tools/list`.
- **Chat**: Dashboard → Chat. It acts as the logged-in user; every call is a tool card and an audit row with `source = chat`. Full two-user walkthrough: [docs/demo-script.md](docs/demo-script.md).

## 7. Tests and checks

```bash
make test        # npm test in every app (no Docker or cluster needed)
make lint        # helm lint --strict, helm template, kubeconform, rendered-manifest invariants
```

Upgrades and rollback: images are tagged per build (`TAG=v2`), `helm upgrade --install` rolls them out,
`helm history` / `helm rollback <release> <revision>` returns. Migrations are additive and the store
setup Job is idempotent.

---

## 8. Key difficulties

1. **Windows development machine.** Docker Desktop could not start at first (Virtual Machine Platform disabled, no WSL 2), so the first day of verification ran without a cluster; `*.localhost` does not resolve for Node; the workspace path exceeded `MAX_PATH` for Python; Git Bash rewrites Linux paths in `kubectl exec` arguments.
2. **Retired ingress-nginx.** The usual kind recipe is unmaintained since March 2026; switching to Traefik in both environments simplified the values story but cost a round of chart-key debugging (`service.spec.type`).
3. **WordPress automation.** Installing WooCommerce, disabling "coming soon", enabling COD and installing a deterministic application password non-interactively, as uid 33 on a read-only root filesystem; a protected core method only showed up on the real cluster.
4. **MCP SDK details.** The high-level `McpServer` cannot forward raw JSON Schemas (a proxy needs the low-level `Server`); request timeouts do not abort sockets; a bare 401 does not stop OAuth discovery; thinking blocks must be replayed verbatim.
5. **Helm semantics.** Helm 4's `--wait` strategies vs Helm 3; `--set` on a list entry replacing the entry; a killed upgrade leaving a release locked.

## 9. Conclusion

The core of the assignment is complete, tested, and demonstrated end to end on a real cluster with
two users, including every control check. The design choices that matter for the interview are
written down with their alternatives in `docs/system-design.md` and `docs/threat-model.md`. The bonus
multi-store provisioning is the natural next step: the per-store chart, namespacing, quotas and
NetworkPolicies already exist, and only the provisioner and dashboard surface are missing.

---

## 10. AI usage

This project was built with **Claude Code** (Claude Fable 5.1 in the Claude desktop app), under my
direction, and I can walk through every component and decision. Being precise about the split:

**What Claude Code did**
- Researched the unknowns before writing code (MCP SDK 1.32 internals, WordPress/WooCommerce CLI and REST behaviour, kind/Traefik/Helm 4 changes, MCP client behaviour on 401) with parallel research agents, verified against installed packages and official docs.
- Wrote the contract (`docs/contracts.md`) and then the four apps and both charts with parallel build agents, each with its own tests; wrote the design, threat-model and demo documents.
- Code review (`/code-review`) across the whole project: 15 findings, 13 fixed, including the Anthropic thinking-block replay bug and the Origin check that blocked browser clients.
- Found and fixed the three cluster-only bugs during the kind run (Traefik service key, protected WordPress method, Helm `--set` on a list entry) and lint/typecheck failures left by interrupted build agents.
- Verified the definition of done on the cluster with curl, Inspector, Claude Code and the WooCommerce Store API.

**What I did**
- Set the goal, chose the stack direction and the tradeoffs recorded in the design note, and reviewed the checklist against the assignment text word by word.
- Prepared the environment: installed WSL 2 so Docker Desktop could start, created the GitHub repository and moved the work into it, chose where secrets live.
- Supplied the free NVIDIA endpoint and key for the chat agent and decided to switch models when the 550B model was overloaded.
- Did the manual checks in the browser (storefront, WordPress admin, dashboard logins), decided what to commit and when, and directed each follow-up (end-to-end run, review pass, README).

**Claude Code skills used**: `workflow-authoring` (parallel research and build workflows), `code-review`, `claude-api` (Anthropic provider), built-in browser (dashboard walk-through), Agent subagents (build, review, fix), the Workflow tool.
**Connectors and plugins present in the session**: Playwright (dashboard smoke test by a review agent), the built-in browser pane, Chrome DevTools (connected but unused); the engineering, Apify, Notion, Linear and Stitch plugins were available but not used for this project.
