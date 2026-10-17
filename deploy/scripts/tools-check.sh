#!/usr/bin/env bash
# Verifies that docker, kind, kubectl and helm are available and prints their versions.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

status=0
check() {
  local name="$1" var="$2" bin="$3"; shift 3
  if command -v "$bin" >/dev/null 2>&1; then
    printf '  %-8s %s\n' "$name" "$("$bin" "$@" 2>/dev/null | head -n 1)"
  else
    printf '  %-8s MISSING (install it or set %s=/path/to/%s)\n' "$name" "$var" "$name"
    status=1
  fi
}

log "checking tools"
check docker  DOCKER  "$DOCKER"  --version
check kind    KIND    "$KIND"    --version
check kubectl KUBECTL "$KUBECTL" version --client
check helm    HELM    "$HELM"    version --short

if command -v "$DOCKER" >/dev/null 2>&1 && ! "$DOCKER" info >/dev/null 2>&1; then
  warn "docker is installed but the daemon is not reachable (is Docker Desktop running?)"
  status=1
fi

[ "$status" -eq 0 ] && log "all tools present" || die "missing tools"
