#!/usr/bin/env bash
# Deletes the local kind cluster. Persistent volumes live inside the node container, so this also
# wipes the WordPress and database data (deploy/secrets/ is kept; reuse it on the next local-up).
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

need "$KIND" KIND

if "$KIND" get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  log "deleting kind cluster '$CLUSTER'"
  "$KIND" delete cluster --name "$CLUSTER"
else
  log "kind cluster '$CLUSTER' does not exist"
fi
