# Demo script (definition of done, step by step)

Two users: **user A = the admin** (`admin@example.com`) and **user B = a member**
(`member@example.com`). Both passwords are in `deploy/secrets/platform.yaml` after `make secrets`.
URLs below assume the local defaults; replace the domain for a VPS.

| | URL |
|---|---|
| Storefront | http://store.127.0.0.1.nip.io |
| WordPress admin | http://store.127.0.0.1.nip.io/wp-admin (admin password in `deploy/secrets/store.yaml`) |
| Dashboard | http://gateway.127.0.0.1.nip.io |
| Gateway MCP endpoint | http://gateway.127.0.0.1.nip.io/mcp |

## 0. Bring it up

```bash
make local-up        # kind cluster + Traefik ingress + images + both Helm releases
make status          # pods, ingresses, URLs
```

Wait until the `demo-setup` Job in `store-demo` has completed (it installs WordPress and WooCommerce,
takes a few minutes the first time): `kubectl -n store-demo logs job/demo-setup -f`.

## 1. Store

1. Open the storefront, open the "Demo Mug" product, add to cart, checkout with **Cash on delivery**
   (guest checkout, any name/address).
2. Open WordPress admin → WooCommerce → Orders: the order is there with status *Processing*.

## 2. Chat agent as user A (admin)

1. Log in to the dashboard as A. Servers page shows `woo` (WooCommerce), `notes`, `utils` as *Connected*
   with their tools. Open `woo` to see `woo__list_products`, `woo__create_product`, `woo__list_orders`,
   `woo__get_order`, `woo__update_order_status`.
2. Chat: *"Create a product called Demo Hoodie priced 49."* → the agent calls `woo__create_product`;
   the tool card shows the call and the result; the product appears on the storefront (refresh).
3. On the storefront, order the Demo Hoodie by hand (COD).
4. Chat: *"What orders came in today?"* → `woo__list_orders` with `after: <today>`; the answer lists
   the new order (and the one from step 1).
5. Audit log page: both calls appear with user A, `source = chat`, duration and `success`.

## 3. External MCP client as user B (member)

1. Log in as B in a private window (or log A out). *API keys* → create a key, copy it once.
2. Connect a client with only the gateway URL and the key:

   ```bash
   claude mcp add --transport http urumi-gateway http://gateway.127.0.0.1.nip.io/mcp --header "Authorization: Bearer <B's key>"
   claude mcp list
   ```

   or MCP Inspector: `npx @modelcontextprotocol/inspector` → Streamable HTTP, the URL, Authentication header `Authorization: Bearer <key>`.
   Tools from all three servers are listed with their `<server>__` prefix (and nothing from disabled servers).
3. Ask the same question: *"What orders came in today?"* → `woo__list_orders` → the order.
4. A prompt that needs two servers: *"What is today's total order value in EUR?"* → `woo__list_orders`
   then `utils__convert_currency`. (Or *"Save a note summarising today's orders"* → `woo__list_orders` + `notes__create_note`.)
5. Audit log (as A): B's calls appear with `source = mcp` and B's key prefix.

## 4. Team and control

1. As A: Team → B → revoke the key. B's next call from the client is rejected (`401 unauthorized`).
   (Issue B a new key if you want to continue the demo.)
2. As A: Servers → `utils` → Disable. Chat's tool count drops and `utils__*` tools disappear from the
   external client's tool list (`claude mcp list` / Inspector "List tools" again).
3. Kill an upstream: `kubectl -n mcp-platform scale deploy platform-mcp-notes --replicas=0`
   (or `kubectl delete pod -l app.kubernetes.io/name=mcp-notes`). Within 15 s the dashboard shows
   `notes` as *Unreachable* with the reason; `woo__*` calls keep working; a call to `notes__*` returns a
   clear "unreachable" error. Scale back to 1 and it returns to *Connected*.
4. Audit log: every call above is attributed to the right user, with server, tool, time, duration and outcome.

## 5. Things to show while explaining

* `kubectl get all,ingress,netpol,pvc,secret -n store-demo` and `-n mcp-platform`: what runs where.
* `kubectl -n store-demo get svc demo-woo-mcp` has no Ingress; `kubectl -n store-demo describe netpol` shows the gateway-only rule.
* `kubectl -n mcp-platform port-forward deploy/platform-gateway 9090:9090` → http://localhost:9090/metrics for per-server call counts and latency.
* `helm history platform -n mcp-platform`, then a `helm upgrade` with a new image tag and `helm rollback platform <n>`.
