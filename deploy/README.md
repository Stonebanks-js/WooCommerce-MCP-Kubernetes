# deploy/: local kind workflow and k3s notes

Everything is Helm (no Kustomize): `charts/store` and `charts/platform` run unchanged on kind and
on k3s; only `values-local.yaml` / `values-prod.yaml` (hosts, ingress class/TLS, storage class,
images, replicas, resources) and the git-ignored secret files differ.

## Quick start (local)

```bash
make local-up          # tools-check + secrets + kind-up + build + load + deploy
make status            # pods, ingresses, URLs
make local-down        # delete the kind cluster
```

Open http://store.127.0.0.1.nip.io (storefront) and http://gateway.127.0.0.1.nip.io (dashboard).
Credentials are in `deploy/secrets/store.yaml` (WordPress admin) and `deploy/secrets/platform.yaml`
(dashboard admin + demo member).

Overrides for every target: `KIND`, `HELM`, `KUBECTL`, `DOCKER` (binary paths), `DOMAIN`
(default `127.0.0.1.nip.io`), `TAG` (image tag, default `dev`), `CLUSTER` (kind cluster name,
default `urumi`). Example: `make deploy DOMAIN=myhost.local HELM=/opt/helm4/helm`.

## Scripts

| Script | What it does |
|---|---|
| `tools-check.sh` | Verifies docker, kind, kubectl, helm are on PATH and the Docker daemon answers. |
| `gen-secrets.sh` | Writes `deploy/secrets/store.yaml` and `platform.yaml` with random values (`openssl rand`). Never overwrites; keeps the WooCommerce MCP token identical in both files; `wooAppPassword` is 24 alphanumeric chars (WordPress strips anything else). |
| `kind-up.sh` | Creates the cluster from `kind/kind-config.yaml` if missing, installs Traefik from the official chart into namespace `traefik` with hostPorts 80/443 on the `ingress-ready` node, waits for the rollout. |
| `build-images.sh` | `docker build` for `apps/{gateway,dashboard,woo-mcp,extra-mcp}` as `urumi/<name>:$TAG`. Never `latest`. |
| `load-images.sh` | `docker save --platform linux/amd64` + `kind load image-archive` per image (see below for why). |
| `deploy.sh` | `helm upgrade --install demo charts/store -n store-demo ...` then `platform charts/platform -n mcp-platform ...`, each with `values-local.yaml` + the secrets file, `--wait --timeout 15m` (Helm 4: `--wait=legacy`). |
| `status.sh` | Pods, ingresses, jobs and the URLs. |
| `local-down.sh` | `kind delete cluster`. |
| `lint.sh` | `make lint`: `helm lint` both charts with both values files, `helm template --kube-version 1.37.0`, grep invariants (no unsupplied secret values, probes + resources + hardened securityContext on every workload, no Ingress for woo-mcp, gateway Ingress paths, woo-mcp NetworkPolicy admits only gateway pods from `mcp-platform`), and `kubeconform -strict -ignore-missing-schemas` when a binary is available (`KUBECONFORM=/path`). |
| `k3s-deploy.sh` | Same helm commands with `values-prod.yaml`; `DOMAIN`, `IMAGE_PREFIX`, `TAG`, `SECRETS_DIR` variables. |
| `k3s-load-images.sh` | Sideloads the images into a k3s node over ssh (`docker save` + `scp` + `k3s ctr images import`). |
| `common.sh` | Shared variables and helpers (sourced by the others). |

Deploy order matters: the platform's seeded `woo` server points at
`demo-woo-mcp.store-demo.svc.cluster.local`, so the store goes first. The store's setup Job is a
Helm post-install/post-upgrade hook; with `--wait` it runs only after WordPress is Ready and Helm
waits for it to finish (`kubectl -n store-demo logs job/demo-setup` shows what it did).

## Local domain

`*.127.0.0.1.nip.io` resolves to 127.0.0.1 on any machine with internet DNS, and the kind config
forwards host ports 80/443 (bound to 127.0.0.1) into the node where Traefik listens, so the
Ingress hosts work from the host without touching any config. Alternatives:

* `*.localhost` (`DOMAIN=localhost`): browsers resolve it to loopback by themselves, but curl,
  Node and the WordPress loopback (wp-cron) do not, so use it only for browser-only testing.
* hosts-file entries (`127.0.0.1 store.mydomain.test gateway.mydomain.test`) with
  `DOMAIN=mydomain.test`: works everywhere, needs admin rights to edit the hosts file.

The in-cluster addresses never change; only the Ingress hosts (`store.$DOMAIN`, `gateway.$DOMAIN`)
and WordPress's `WP_HOME`/`WP_SITEURL` follow `DOMAIN`. Changing `DOMAIN` after the first install
is a `helm upgrade` (the setup Job updates nothing about the URL; WordPress reads `WP_HOME` from
the environment at every request).

## Ingress controller: Traefik on both environments

ingress-nginx was retired and archived in March 2026 (last release controller-v1.15.1), so Traefik
is used everywhere: k3s bundles it (IngressClass `traefik`, default, in `kube-system`), and
`kind-up.sh` installs the same chart locally (namespace `traefik`). Consequences baked into the
values files: `ingress.className: traefik`, no SSE annotations (Traefik streams
`text/event-stream` as it arrives, has no write timeout by default and buffers only when the
Buffering middleware is attached), and `networkPolicy.ingressControllerNamespace` is `traefik`
locally and `kube-system` in prod. The nginx annotations one would need instead are listed as
comments in both `values.yaml` files.

## NetworkPolicies are enforced in both environments

kind's default CNI (kindnet) ships kube-network-policies since kind v0.24, and k3s runs the
embedded kube-router policy controller by default. Nothing is installed for this (no Calico, no
`disableDefaultCNI`, one `kind-config.yaml`). Both namespaces default-deny ingress and egress and
allow exactly the flows the components need; woo-mcp accepts connections only from pods labelled
`app.kubernetes.io/name=gateway` in `mcp-platform`, and the gateway may only reach Postgres, the
two extra MCP servers, `woo-mcp` pods, DNS and the internet on 443 (LLM APIs). A quick check
after `make local-up`:

```bash
# from the platform namespace, not a gateway pod -> must hang/fail
kubectl -n mcp-platform run np-test --rm -it --restart=Never --image=curlimages/curl:8.12.1 -- \
  curl -s -m 5 http://demo-woo-mcp.store-demo.svc.cluster.local:8080/healthz ; echo "exit $?"
# from a gateway pod -> 200
kubectl -n mcp-platform exec deploy/platform-gateway -- \
  node -e 'fetch("http://demo-woo-mcp.store-demo.svc.cluster.local:8080/healthz").then(r=>console.log(r.status))'
```

## Image loading on kind

`kind load docker-image` is unreliable with Docker Desktop's containerd image store (multi-arch
digests not found, already-loaded images never detected: kind issues #3795 and #4236).
`load-images.sh` therefore exports a single-platform archive with `docker save --platform
linux/amd64` and imports it with `kind load image-archive`, falling back to the plain commands on
older Docker versions. The charts use `pullPolicy: IfNotPresent` with a pinned tag (`dev`), never
`latest`, so the node uses the loaded image and never tries to pull it.

## Storage on kind

The storage class is `standard` (rancher local-path, `WaitForFirstConsumer`). PV data lives
inside the kind node container: it survives pod restarts and `helm upgrade`, but
`make local-down` (`kind delete cluster`) deletes it. The generated secrets in `deploy/secrets/`
are kept, so the next `make local-up` reinstalls with the same credentials.

## Helm 3 / Helm 4

The charts are `apiVersion: v2` and use nothing Helm-4-only. The scripts adapt the one flag that
changed: Helm 4's bare `--wait` means the stricter kstatus watcher, so they pass `--wait=legacy`
on v4 and `--wait` on v3. `helm lint` is always given an explicit chart path (Helm 4 no longer
lints the cwd). The setup Job carries `helm.sh/hook-output-log-policy: hook-failed`, which Helm 4
uses to print the Job log when the hook fails (Helm 3 ignores it). `--atomic`/`--force` are not
used (renamed in Helm 4; use `--rollback-on-failure` manually on v4 if wanted).

## k3s on a VPS

Install (stable channel as of 2026-10-16):

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=v1.36.5+k3s1 K3S_KUBECONFIG_MODE=644 sh -
```

Firewall: open 6443/tcp (API, only if you deploy remotely), 80/tcp and 443/tcp. Never expose
8472/udp (flannel VXLAN). k3s gives you Traefik as the default IngressClass (`traefik`, in
`kube-system`), the `local-path` storage class (PVs under `/var/lib/rancher/k3s/storage`, pinned
to the node) and kube-router NetworkPolicy enforcement; `values-prod.yaml` already matches all of
that.

DNS: point `store.<domain>` and `gateway.<domain>` at the VPS. TLS: install cert-manager, then
uncomment the `annotations`/`tls` blocks in both `values-prod.yaml` files (the charts switch
`WP_HOME`, `PUBLIC_URL` and `COOKIE_SECURE` to https automatically when a TLS block is present).

Images, two options:

1. Registry: `make build TAG=0.1.0`, `docker tag`/`docker push` to `registry.example.com/urumi/<name>:0.1.0`,
   then `DOMAIN=example.com IMAGE_PREFIX=registry.example.com/urumi TAG=0.1.0 make k3s-deploy`.
   For a private registry, add credentials in `/etc/rancher/k3s/registries.yaml` on the node.
2. Sideload without a registry: `K3S_HOST=ubuntu@vps make k3s-load-images` (`docker save --platform
   linux/amd64` + `scp` + `sudo k3s ctr images import`), then
   `DOMAIN=example.com IMAGE_PREFIX=urumi TAG=dev make k3s-deploy`.

Secrets: run `make secrets` locally and copy `deploy/secrets/*.yaml` to the VPS (or point
`SECRETS_DIR` at them); they are never committed. Run `k3s-deploy.sh` on the VPS, or remotely with
`KUBECONFIG` pointing at a copy of `/etc/rancher/k3s/k3s.yaml` whose server is the public IP.

## Production notes

* wp-cron stays on the default (triggered by page views, loopback through the Ingress host). The
  production-grade alternative is `define('DISABLE_WP_CRON', true);` in `wordpress.configExtra`
  plus a CronJob running the `wordpress:cli` image with `wp cron event run --due-now` against the
  same PVC and env (the setup Job template shows the exact mounts/env to copy).
* The gateway's `/metrics` is served on container port 9090 (Service port `metrics`), reachable
  only in-cluster and only from the namespace named in `networkPolicy.gateway.metricsFromNamespace`.
* `quota.enabled: true` (prod) adds a ResourceQuota + LimitRange to the store namespace, the
  pattern a store-provisioner would use per tenant namespace.
