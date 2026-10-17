#!/usr/bin/env bash
# Creates the local kind cluster (if missing) and installs Traefik as the ingress controller.
#
# Traefik (not ingress-nginx, which was retired/archived in March 2026) is used on kind and on
# k3s alike, so the charts' ingressClassName is "traefik" in both values files. On kind it is
# installed from the official chart with hostPorts 80/443 on the ingress-ready node, which the
# kind config forwards from 127.0.0.1:80/443 on the host.
#
# NetworkPolicies need nothing extra: kind's default CNI (kindnet) enforces them via
# kube-network-policies since kind v0.24.
#
# Env: TRAEFIK_CHART_VERSION (optional pin, e.g. 37.0.0), plus the common overrides (common.sh).
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

need "$KIND" KIND
need "$HELM" HELM
need "$KUBECTL" KUBECTL
need "$DOCKER" DOCKER

if "$KIND" get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  log "kind cluster '$CLUSTER' already exists"
else
  log "creating kind cluster '$CLUSTER' from deploy/kind/kind-config.yaml"
  "$KIND" create cluster --name "$CLUSTER" --config "$(native_path "$ROOT/deploy/kind/kind-config.yaml")" --wait 120s
fi

"$KUBECTL" config use-context "kind-$CLUSTER" >/dev/null

log "installing Traefik (namespace traefik, hostPorts 80/443)"
"$HELM" repo add traefik https://traefik.github.io/charts >/dev/null 2>&1 || true
"$HELM" repo update traefik >/dev/null

version_args=()
[ -n "${TRAEFIK_CHART_VERSION:-}" ] && version_args=(--version "$TRAEFIK_CHART_VERSION")

# Keys verified against `helm show values traefik/traefik`:
#   ports.web.hostPort / ports.websecure.hostPort  bind the node's 80/443 to the Traefik pod
#   service.spec.type=ClusterIP                     no LoadBalancer on kind (hostPorts carry traffic; a pending
#                                                   LoadBalancer IP would stall helm --wait forever)
#   ingressClass.enabled / isDefaultClass           publish the "traefik" IngressClass as default
#   nodeSelector (string value!)                    schedule on the node with the port mappings
# shellcheck disable=SC2046
"$HELM" upgrade --install traefik traefik/traefik \
  --namespace traefik --create-namespace \
  "${version_args[@]}" \
  --set ports.web.hostPort=80 \
  --set ports.websecure.hostPort=443 \
  --set service.spec.type=ClusterIP \
  --set ingressClass.enabled=true \
  --set ingressClass.isDefaultClass=true \
  --set-string 'nodeSelector.ingress-ready=true' \
  $(helm_wait_flag) --timeout 5m

log "waiting for the Traefik rollout"
"$KUBECTL" -n traefik rollout status deploy/traefik --timeout=300s

log "cluster ready: kubectl context kind-$CLUSTER, ingress on http://127.0.0.1 (hosts *.$DOMAIN)"
