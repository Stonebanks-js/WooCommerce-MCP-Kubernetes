#!/usr/bin/env bash
# Deploys both releases to a k3s cluster with values-prod.yaml. Run it where kubectl/helm can reach
# the cluster (on the VPS itself, or with KUBECONFIG pointing at a copy of /etc/rancher/k3s/k3s.yaml
# whose server address is the VPS's public IP).
#
# Same helm commands as deploy.sh, different values file: the charts do not change between kind
# and k3s. k3s specifics the values-prod files already carry: ingressClassName traefik (bundled,
# Traefik runs in kube-system), storageClass local-path, NetworkPolicies enforced by kube-router.
#
# Variables:
#   DOMAIN        public domain: store.$DOMAIN and gateway.$DOMAIN must resolve to the VPS (required)
#   IMAGE_PREFIX  registry path of the four images (default registry.example.com/urumi). Use
#                 "urumi" when the images were sideloaded with k3s-load-images.sh.
#   TAG           image tag (default: dev)
#   HELM_TIMEOUT  (default 15m)
#   SECRETS_DIR   directory holding store.yaml / platform.yaml (default deploy/secrets; generate
#                 them with gen-secrets.sh and copy them to the VPS over scp, never commit them)
#   EXTRA_STORE_ARGS / EXTRA_PLATFORM_ARGS   appended verbatim, e.g. "--set ingress.tls[0].secretName=..."
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

need "$HELM" HELM
need "$KUBECTL" KUBECTL
[ "${DOMAIN}" != "127.0.0.1.nip.io" ] || die "set DOMAIN to the public domain of the VPS (e.g. DOMAIN=example.com)"

IMAGE_PREFIX="${IMAGE_PREFIX:-registry.example.com/urumi}"
HELM_TIMEOUT="${HELM_TIMEOUT:-15m}"
SECRETS_DIR="${SECRETS_DIR:-$ROOT/deploy/secrets}"
[ -f "$SECRETS_DIR/store.yaml" ] && [ -f "$SECRETS_DIR/platform.yaml" ] \
  || die "$SECRETS_DIR/{store,platform}.yaml missing (gen-secrets.sh, then copy them here)"

WAIT="$(helm_wait_flag)"

log "store -> $STORE_NS (host store.$DOMAIN, image $IMAGE_PREFIX/woo-mcp:$TAG)"
# shellcheck disable=SC2086
"$HELM" upgrade --install "$STORE_RELEASE" "$ROOT/charts/store" \
  --namespace "$STORE_NS" --create-namespace \
  -f "$ROOT/charts/store/values-prod.yaml" \
  -f "$SECRETS_DIR/store.yaml" \
  --set "store.host=store.$DOMAIN" \
  --set "wooMcp.image.repository=$IMAGE_PREFIX/woo-mcp" \
  --set "wooMcp.image.tag=$TAG" \
  "$WAIT" --timeout "$HELM_TIMEOUT" ${EXTRA_STORE_ARGS:-}

log "platform -> $PLATFORM_NS (host gateway.$DOMAIN, images $IMAGE_PREFIX/*:$TAG)"
# shellcheck disable=SC2086
"$HELM" upgrade --install "$PLATFORM_RELEASE" "$ROOT/charts/platform" \
  --namespace "$PLATFORM_NS" --create-namespace \
  -f "$ROOT/charts/platform/values-prod.yaml" \
  -f "$SECRETS_DIR/platform.yaml" \
  --set "host=gateway.$DOMAIN" \
  --set "gateway.image.repository=$IMAGE_PREFIX/gateway" \
  --set "gateway.image.tag=$TAG" \
  --set "dashboard.image.repository=$IMAGE_PREFIX/dashboard" \
  --set "dashboard.image.tag=$TAG" \
  --set "mcpNotes.image.repository=$IMAGE_PREFIX/extra-mcp" \
  --set "mcpNotes.image.tag=$TAG" \
  --set "mcpUtils.image.repository=$IMAGE_PREFIX/extra-mcp" \
  --set "mcpUtils.image.tag=$TAG" \
  "$WAIT" --timeout "$HELM_TIMEOUT" ${EXTRA_PLATFORM_ARGS:-}

log "deployed: http://store.$DOMAIN/  http://gateway.$DOMAIN/"
"$(dirname "${BASH_SOURCE[0]}")/status.sh"
