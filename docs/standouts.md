# Bonus and stand-out items: what was attempted and where to find it

The core (store, self-written WooCommerce MCP server, gateway + dashboard, chat agent, Helm charts,
kind + k3s values) is the deliverable. The items below are the extras from the assignment's
"Other ways to stand out" list that are implemented, with pointers.

| Item | Status | Where |
|---|---|---|
| 2) Tool permissions (per-role) | Done | `mcp_servers.member_tool_policy` (allow/deny globs per server); enforced in `apps/gateway/src/upstream/policy.ts` and `src/core/gatewayCore.ts`; hidden from `tools/list` and rejected on call with audit outcome `denied`; editable in the dashboard server form |
| 4) Handling many tools | Done | `apps/gateway/src/chat/toolSearch.ts`: above `CHAT_TOOL_SEARCH_THRESHOLD` visible tools the chat agent gets `search_tools` + `call_tool` meta-tools instead of the full catalogue; audit still records the real tool |
| 6) Security hardening | Done | SSRF validation of upstream URLs (`src/upstream/ssrf.ts`, registration + connect time, metadata/loopback/link-local blocked, private ranges only for allow-listed in-cluster suffixes); upstream credentials AES-256-GCM at rest (`src/crypto/secretbox.ts`); default-deny NetworkPolicies in both charts; containers non-root with dropped capabilities and no service-account token; no component talks to the Kubernetes API (so least-privilege RBAC is "none") |
| 7) Scaling | Partly | Gateway is stateless Streamable HTTP (no session affinity), `gateway.replicas` in `values-prod.yaml`; per-key token-bucket rate limit (`src/core/ratelimit.ts`). Rate-limit counters and upstream health are per replica (documented limitation) |
| 8) Observability | Done | Prometheus metrics on port 9090 (`gateway_tool_calls_total`, `gateway_tool_call_duration_seconds`, `gateway_upstream_up`); every unreachable server shows its last error in the dashboard and `GET /api/servers`; every failed call carries a one-line reason in the audit log |
| 9) Upgrades and rollback | Documented | `docs/system-design.md` (production table) and `README.md`: image tags per build, `helm upgrade --install`, `helm history`, `helm rollback`; migrations are additive, the WordPress setup Job is idempotent |
| 1) VPS deployment | Values + scripts, not demonstrated | `charts/*/values-prod.yaml`, `deploy/scripts/k3s-*.sh`, `deploy/README.md` |
| 3) OAuth on the gateway | Not attempted | API keys only; the 401 response shape is OAuth-discovery-safe (see `docs/threat-model.md`) |
| 5) Hosted MCP servers by image | Not attempted | |
| Bonus: multi-store provisioning | Not attempted | The store chart is already parameterised per store (own namespace, DB, Secrets, PVCs, Ingress host, optional ResourceQuota/LimitRange) so a provisioner would run `helm upgrade --install <store> charts/store -n <ns>`; see "Next steps" in `README.md` |
