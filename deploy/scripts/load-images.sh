#!/usr/bin/env bash
# Loads the four urumi/*:$TAG images into the kind cluster.
#
# Why not `kind load docker-image`? With Docker Desktop's containerd image store it is unreliable:
# multi-arch digests are not found (kind #3795) and already-loaded images are never detected
# (kind #4236). Exporting a single-platform archive with `docker save --platform linux/amd64` and
# importing it with `kind load image-archive` works regardless of the image store. Older Docker
# versions without --platform fall back to a plain `docker save` and finally to
# `kind load docker-image`.
#
# Env: PLATFORM (default linux/amd64), plus the common overrides (common.sh).
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

need "$DOCKER" DOCKER
need "$KIND" KIND
PLATFORM="${PLATFORM:-linux/amd64}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for name in "${IMAGES[@]}"; do
  image="urumi/$name:$TAG"
  archive="$tmp/$name.tar"
  "$DOCKER" image inspect "$image" >/dev/null 2>&1 || die "$image not found locally; run build-images.sh first"

  log "exporting $image ($PLATFORM)"
  if "$DOCKER" save --platform "$PLATFORM" -o "$(native_path "$archive")" "$image" 2>/dev/null; then
    :
  elif "$DOCKER" save -o "$(native_path "$archive")" "$image"; then
    warn "docker save --platform unsupported; exported all platforms of $image"
  else
    warn "docker save failed for $image; falling back to kind load docker-image"
    "$KIND" load docker-image "$image" --name "$CLUSTER"
    continue
  fi

  log "importing $image into kind cluster '$CLUSTER'"
  "$KIND" load image-archive "$(native_path "$archive")" --name "$CLUSTER"
  rm -f "$archive"
done

log "images loaded"
