#!/usr/bin/env bash
# Builds the four application images: urumi/{gateway,dashboard,woo-mcp,extra-mcp}:$TAG (default dev).
# Images are single-arch (the host's platform) and never tagged "latest": the charts pin a tag and
# use pullPolicy IfNotPresent, so a stale "latest" could never be mistaken for a fresh build.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

need "$DOCKER" DOCKER

for name in "${IMAGES[@]}"; do
  log "building urumi/$name:$TAG from apps/$name"
  "$DOCKER" build -t "urumi/$name:$TAG" "$(native_path "$ROOT/apps/$name")"
done

log "built (tag $TAG): ${IMAGES[*]/#/urumi/}"
