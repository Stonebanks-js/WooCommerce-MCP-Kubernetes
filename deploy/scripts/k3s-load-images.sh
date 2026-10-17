#!/usr/bin/env bash
# Sideloads the four urumi/*:$TAG images into a k3s node over ssh, for a VPS without a registry:
#   docker save --platform linux/amd64 -> scp -> sudo k3s ctr images import
# Afterwards deploy with IMAGE_PREFIX=urumi TAG=$TAG k3s-deploy.sh (pullPolicy IfNotPresent).
# The registry route (docker push + values-prod image.repository) is the alternative; see
# deploy/README.md.
#
# Env: K3S_HOST (required, e.g. ubuntu@203.0.113.10), SSH (default ssh), SCP (default scp),
#      PLATFORM (default linux/amd64), REMOTE_DIR (default /tmp), plus TAG / DOCKER.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

need "$DOCKER" DOCKER
K3S_HOST="${K3S_HOST:-}"
[ -n "$K3S_HOST" ] || die "set K3S_HOST=user@host"
SSH="${SSH:-ssh}"
SCP="${SCP:-scp}"
PLATFORM="${PLATFORM:-linux/amd64}"
REMOTE_DIR="${REMOTE_DIR:-/tmp}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for name in "${IMAGES[@]}"; do
  image="urumi/$name:$TAG"
  archive="$tmp/$name.tar"
  log "exporting $image ($PLATFORM)"
  "$DOCKER" save --platform "$PLATFORM" -o "$(native_path "$archive")" "$image" \
    || "$DOCKER" save -o "$(native_path "$archive")" "$image"

  log "copying to $K3S_HOST:$REMOTE_DIR/$name.tar"
  "$SCP" -q "$archive" "$K3S_HOST:$REMOTE_DIR/$name.tar"

  log "importing on the node"
  "$SSH" "$K3S_HOST" "sudo k3s ctr images import '$REMOTE_DIR/$name.tar' && rm -f '$REMOTE_DIR/$name.tar'"
  rm -f "$archive"
done

log "images imported; deploy with: IMAGE_PREFIX=urumi TAG=$TAG DOMAIN=<domain> deploy/scripts/k3s-deploy.sh"
