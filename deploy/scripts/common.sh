#!/usr/bin/env bash
# Shared settings for deploy/scripts/*.sh. Sourced, not executed.
# Every script honours these environment overrides:
#   KIND, HELM, KUBECTL, DOCKER   paths to the binaries (default: found on PATH)
#   DOMAIN                        local wildcard domain (default 127.0.0.1.nip.io):
#                                 the store is store.$DOMAIN, the dashboard/gateway gateway.$DOMAIN
#   CLUSTER                       kind cluster name (default urumi, must match deploy/kind/kind-config.yaml)
#   TAG                           image tag for the four urumi/* images (default dev)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KIND="${KIND:-kind}"
HELM="${HELM:-helm}"
KUBECTL="${KUBECTL:-kubectl}"
DOCKER="${DOCKER:-docker}"
DOMAIN="${DOMAIN:-127.0.0.1.nip.io}"
CLUSTER="${CLUSTER:-urumi}"
TAG="${TAG:-dev}"

STORE_NS="store-demo"
PLATFORM_NS="mcp-platform"
STORE_RELEASE="demo"
PLATFORM_RELEASE="platform"
IMAGES=(gateway dashboard woo-mcp extra-mcp)   # apps/<name> -> urumi/<name>:$TAG

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 not found on PATH (override with $2=/path/to/binary)"; }

# Helm 3 has a boolean --wait. Helm 4's bare --wait selects the kstatus watcher (needs RBAC
# `watch` and is stricter); --wait=legacy keeps the Helm 3 behaviour. Pick the right spelling.
helm_wait_flag() {
  if "$HELM" version --short 2>/dev/null | grep -q '^v4'; then
    echo "--wait=legacy"
  else
    echo "--wait"
  fi
}

# Windows (Git Bash / MSYS): native binaries such as docker.exe and kind.exe need Windows paths.
native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s\n' "$1"; fi
}
