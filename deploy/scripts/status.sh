#!/usr/bin/env bash
# Prints pods, ingresses and the public URLs of both releases in the current kubectl context.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

need "$KUBECTL" KUBECTL

for ns in "$STORE_NS" "$PLATFORM_NS"; do
  log "pods in $ns"
  "$KUBECTL" -n "$ns" get pods -o wide 2>&1 || true
  log "ingresses in $ns"
  "$KUBECTL" -n "$ns" get ingress 2>&1 || true
done

log "jobs in $STORE_NS (setup hook)"
"$KUBECTL" -n "$STORE_NS" get jobs 2>&1 || true

cat <<EOF

URLs (DOMAIN=$DOMAIN):
  Storefront        http://store.$DOMAIN/
  WordPress admin   http://store.$DOMAIN/wp-admin/      (user admin, password: deploy/secrets/store.yaml)
  Dashboard         http://gateway.$DOMAIN/              (admin login: deploy/secrets/platform.yaml)
  Gateway API       http://gateway.$DOMAIN/api
  MCP endpoint      http://gateway.$DOMAIN/mcp           (Authorization: Bearer <gw_key>)

Useful:
  $KUBECTL -n $STORE_NS logs job/$STORE_RELEASE-setup
  $KUBECTL -n $PLATFORM_NS logs deploy/$PLATFORM_RELEASE-gateway
EOF
