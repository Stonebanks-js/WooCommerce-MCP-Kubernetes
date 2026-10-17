#!/usr/bin/env bash
# Deploys (or upgrades) the store and the platform into the current kubectl context with the
# local values files plus the generated secrets:
#   helm upgrade --install demo     charts/store    -n store-demo   -f values-local.yaml -f deploy/secrets/store.yaml
#   helm upgrade --install platform charts/platform -n mcp-platform -f values-local.yaml -f deploy/secrets/platform.yaml
# The store goes first because the platform's seed entry points at <STORE_RELEASE>-woo-mcp.<STORE_NS>
# (the platform chart renders that address from store.release / store.namespace, set below).
# --wait makes Helm wait for every workload to become Ready; for the store this also means the
# setup Job (post-install hook) only starts once WordPress answers, and Helm then waits for the Job.
#
# Env: DOMAIN (default 127.0.0.1.nip.io -> store.$DOMAIN / gateway.$DOMAIN), HELM_TIMEOUT (15m),
# plus the common overrides (common.sh).
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

need "$HELM" HELM
need "$KUBECTL" KUBECTL
HELM_TIMEOUT="${HELM_TIMEOUT:-15m}"

[ -f "$ROOT/deploy/secrets/store.yaml" ] && [ -f "$ROOT/deploy/secrets/platform.yaml" ] \
  || die "deploy/secrets/*.yaml missing; run deploy/scripts/gen-secrets.sh (make secrets) first"

WAIT="$(helm_wait_flag)"

log "deploying store release '$STORE_RELEASE' into namespace $STORE_NS (host store.$DOMAIN)"
"$HELM" upgrade --install "$STORE_RELEASE" "$(native_path "$ROOT/charts/store")" \
  --namespace "$STORE_NS" --create-namespace \
  -f "$(native_path "$ROOT/charts/store/values-local.yaml")" \
  -f "$(native_path "$ROOT/deploy/secrets/store.yaml")" \
  --set "store.host=store.$DOMAIN" \
  --set "wooMcp.image.tag=$TAG" \
  "$WAIT" --timeout "$HELM_TIMEOUT"

log "deploying platform release '$PLATFORM_RELEASE' into namespace $PLATFORM_NS (host gateway.$DOMAIN)"
"$HELM" upgrade --install "$PLATFORM_RELEASE" "$(native_path "$ROOT/charts/platform")" \
  --namespace "$PLATFORM_NS" --create-namespace \
  -f "$(native_path "$ROOT/charts/platform/values-local.yaml")" \
  -f "$(native_path "$ROOT/deploy/secrets/platform.yaml")" \
  --set "host=gateway.$DOMAIN" \
  --set "store.release=$STORE_RELEASE" --set "store.namespace=$STORE_NS" \
  --set "gateway.image.tag=$TAG" \
  --set "dashboard.image.tag=$TAG" \
  --set "mcpNotes.image.tag=$TAG" \
  --set "mcpUtils.image.tag=$TAG" \
  "$WAIT" --timeout "$HELM_TIMEOUT"

log "deployed"
"$(dirname "${BASH_SOURCE[0]}")/status.sh"
