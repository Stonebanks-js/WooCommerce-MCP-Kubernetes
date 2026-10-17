#!/usr/bin/env bash
# `make lint`: static validation of both charts without a cluster.
#   1. helm lint  charts/store and charts/platform, each with values-local.yaml and values-prod.yaml
#   2. helm template (--kube-version 1.37.0) for both charts with values-local.yaml
#   3. grep-based invariants on the rendered YAML:
#        - no Secret value that was not supplied through values (nothing defaulted or generated)
#        - every Deployment/StatefulSet has liveness + readiness probes and resources; Jobs have
#          resources; every pod template disables the ServiceAccount token
#        - woo-mcp has no Ingress and only a ClusterIP Service
#        - the gateway Ingress routes /api, /mcp and /
#        - the woo-mcp NetworkPolicy admits exactly one peer: gateway pods from mcp-platform
#   4. kubeconform -strict -ignore-missing-schemas when the binary is available
#      (KUBECONFORM=/path/to/kubeconform, or on PATH)
# Secrets: deploy/secrets/*.yaml are used when present; otherwise throwaway values are written to
# a temp directory (never into deploy/secrets).
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

need "$HELM" HELM
KUBE_VERSION="${KUBE_VERSION:-1.37.0}"
KUBECONFORM="${KUBECONFORM:-kubeconform}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

failures=0
pass() { printf '  \033[1;32mok\033[0m    %s\n' "$*"; }
fail() { printf '  \033[1;31mFAIL\033[0m  %s\n' "$*"; failures=$((failures + 1)); }

# --- secrets -------------------------------------------------------------------------------------
# Throwaway values carry the marker "lintonly" so the invariant check below can recognise them.
if [ -f "$ROOT/deploy/secrets/store.yaml" ] && [ -f "$ROOT/deploy/secrets/platform.yaml" ]; then
  STORE_SECRETS="$ROOT/deploy/secrets/store.yaml"
  PLATFORM_SECRETS="$ROOT/deploy/secrets/platform.yaml"
  MARKER=""
  log "using deploy/secrets/*.yaml"
else
  STORE_SECRETS="$work/store-secrets.yaml"
  PLATFORM_SECRETS="$work/platform-secrets.yaml"
  MARKER="lintonly"
  log "deploy/secrets/*.yaml not found: using throwaway values in $work"
  cat > "$STORE_SECRETS" <<'EOF'
secrets:
  adminPassword: lintonly-admin-password
  dbPassword: lintonly-db-password
  dbRootPassword: lintonly-db-root-password
  mcpAuthToken: lintonly-woo-token
  wooAppPassword: lintonlyAppPassword12345
EOF
  cat > "$PLATFORM_SECRETS" <<'EOF'
secrets:
  adminPassword: lintonly-admin-password
  demoMemberPassword: lintonly-member-password
  encryptionKey: lintonlyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
  sessionSecret: lintonly-session-secret
  postgresPassword: lintonly-pg-password
  wooMcpToken: lintonly-woo-token
  notesMcpToken: lintonly-notes-token
  utilsMcpToken: lintonly-utils-token
EOF
fi

# --- 1. helm lint --------------------------------------------------------------------------------
for chart in store platform; do
  secrets="$STORE_SECRETS"; [ "$chart" = platform ] && secrets="$PLATFORM_SECRETS"
  for values in values-local.yaml values-prod.yaml; do
    log "helm lint charts/$chart -f $values"
    "$HELM" lint "$(native_path "$ROOT/charts/$chart")" \
      -f "$(native_path "$ROOT/charts/$chart/$values")" -f "$(native_path "$secrets")" --strict \
      || fail "helm lint charts/$chart with $values"
  done
done

# --- 2. helm template ----------------------------------------------------------------------------
render() {  # chart release namespace values secrets out
  "$HELM" template "$2" "$(native_path "$ROOT/charts/$1")" --namespace "$3" \
    -f "$(native_path "$ROOT/charts/$1/$4")" -f "$(native_path "$5")" --kube-version "$KUBE_VERSION" > "$6"
}
log "helm template (kube-version $KUBE_VERSION)"
render store    "$STORE_RELEASE"    "$STORE_NS"    values-local.yaml "$STORE_SECRETS"    "$work/store-local.yaml"    || fail "helm template store (local)"
render store    "$STORE_RELEASE"    "$STORE_NS"    values-prod.yaml  "$STORE_SECRETS"    "$work/store-prod.yaml"     || fail "helm template store (prod)"
render platform "$PLATFORM_RELEASE" "$PLATFORM_NS" values-local.yaml "$PLATFORM_SECRETS" "$work/platform-local.yaml" || fail "helm template platform (local)"
render platform "$PLATFORM_RELEASE" "$PLATFORM_NS" values-prod.yaml  "$PLATFORM_SECRETS" "$work/platform-prod.yaml"  || fail "helm template platform (prod)"
[ "$failures" -eq 0 ] || die "rendering failed; skipping invariants"

# Split a rendered stream into one file per document for the checks below.
split_docs() {  # in dir
  mkdir -p "$2"
  awk -v dir="$2" 'BEGIN { n = 0; f = sprintf("%s/doc-%03d.yaml", dir, n) }
       /^---/ { n++; f = sprintf("%s/doc-%03d.yaml", dir, n); next }
       { print > f }' "$1"
}
doc_kind() { sed -n 's/^kind: *//p' "$1" | head -n 1; }
doc_name() { awk '/^metadata:/{m=1; next} m && /^  name: /{sub(/^  name: */, ""); print; exit}' "$1"; }

# --- 3. invariants -------------------------------------------------------------------------------
log "checking invariants on the rendered manifests"
for rendered in store-local store-prod platform-local platform-prod; do
  dir="$work/$rendered.d"; split_docs "$work/$rendered.yaml" "$dir"

  for doc in "$dir"/doc-*.yaml; do
    grep -q '^kind:' "$doc" || continue
    kind="$(doc_kind "$doc")"; name="$(doc_name "$doc")"
    case "$kind" in
      Secret)
        # Every non-empty value must be one we supplied (marker present) when throwaway secrets are
        # in use; with real secret files we can only check that nothing is empty-by-accident.
        if [ -n "$MARKER" ]; then
          bad="$(awk '/^stringData:/{s=1; next} s && /^[^ ]/{s=0} s && /^  [A-Za-z0-9_.-]+: /{print}' "$doc" \
                 | sed 's/^  [A-Za-z0-9_.-]*: //' | grep -v '^""$' | grep -v "$MARKER" || true)"
          [ -z "$bad" ] && pass "$rendered: Secret/$name holds only supplied values" \
                        || fail "$rendered: Secret/$name contains a value not supplied via values: $bad"
        fi
        ;;
      Deployment|StatefulSet)
        ok=1
        grep -q 'livenessProbe:'  "$doc" || { ok=0; fail "$rendered: $kind/$name has no livenessProbe"; }
        grep -q 'readinessProbe:' "$doc" || { ok=0; fail "$rendered: $kind/$name has no readinessProbe"; }
        grep -q '^ *resources:'   "$doc" || { ok=0; fail "$rendered: $kind/$name has no resources"; }
        grep -q 'limits:'         "$doc" || { ok=0; fail "$rendered: $kind/$name has no resource limits"; }
        grep -q 'automountServiceAccountToken: false' "$doc" || { ok=0; fail "$rendered: $kind/$name mounts the SA token"; }
        grep -q 'allowPrivilegeEscalation: false'     "$doc" || { ok=0; fail "$rendered: $kind/$name allows privilege escalation"; }
        [ "$ok" -eq 1 ] && pass "$rendered: $kind/$name has probes, resources, hardened securityContext"
        ;;
      Job)
        ok=1
        grep -q '^ *resources:' "$doc" || { ok=0; fail "$rendered: Job/$name has no resources"; }
        grep -q 'automountServiceAccountToken: false' "$doc" || { ok=0; fail "$rendered: Job/$name mounts the SA token"; }
        [ "$ok" -eq 1 ] && pass "$rendered: Job/$name has resources and no SA token"
        ;;
      Ingress)
        if grep -q 'woo-mcp' "$doc"; then fail "$rendered: Ingress/$name references woo-mcp"; fi
        ;;
      Service)
        if [ "$name" = "$STORE_RELEASE-woo-mcp" ]; then
          grep -q 'type: ClusterIP' "$doc" && pass "$rendered: Service/$name is ClusterIP" \
                                            || fail "$rendered: Service/$name is not ClusterIP"
        fi
        ;;
    esac
  done

  case "$rendered" in
    store-*)
      ing="$(grep -l '^kind: Ingress' "$dir"/doc-*.yaml || true)"
      [ -n "$ing" ] && ! grep -q 'woo-mcp' $ing \
        && pass "$rendered: no Ingress exposes woo-mcp" || fail "$rendered: woo-mcp appears in an Ingress (or no Ingress rendered)"

      np="$(grep -l "^  name: $STORE_RELEASE-woo-mcp$" $(grep -l '^kind: NetworkPolicy' "$dir"/doc-*.yaml) || true)"
      if [ -z "$np" ]; then
        fail "$rendered: NetworkPolicy $STORE_RELEASE-woo-mcp not rendered"
      else
        # The ingress section must contain exactly one `from` peer, carrying both the namespace
        # and the gateway pod selector.
        ingress_block="$(awk '/^  ingress:/{s=1; next} s && /^  [a-z]/{s=0} s' "$np")"
        # peers = list items directly under `from:` (8-space indent), not the `ports:` items
        peers="$(printf '%s\n' "$ingress_block" | awk '/^    - from:/{f=1; next} /^      ports:/{f=0} f && /^        - /{n++} END{print n+0}')"
        printf '%s\n' "$ingress_block" | grep -q "kubernetes.io/metadata.name: \"$PLATFORM_NS\"" \
          && printf '%s\n' "$ingress_block" | grep -q 'app.kubernetes.io/name: gateway' \
          && [ "$peers" = "1" ] \
          && pass "$rendered: NetworkPolicy $STORE_RELEASE-woo-mcp admits only gateway pods from $PLATFORM_NS" \
          || fail "$rendered: NetworkPolicy $STORE_RELEASE-woo-mcp ingress peers are not exactly {gateway pods in $PLATFORM_NS} ($peers peer(s))"
      fi
      ;;
    platform-*)
      ing="$(grep -l '^kind: Ingress' "$dir"/doc-*.yaml || true)"
      if [ -z "$ing" ]; then fail "$rendered: no Ingress rendered"; else
        ok=1
        for p in '"/api"' '"/mcp"' '/'; do
          grep -q "^          - path: $p\$" $ing || { ok=0; fail "$rendered: Ingress lacks path $p"; }
        done
        grep -q "$PLATFORM_RELEASE-gateway"   $ing || { ok=0; fail "$rendered: Ingress does not route to the gateway"; }
        grep -q "$PLATFORM_RELEASE-dashboard" $ing || { ok=0; fail "$rendered: Ingress does not route to the dashboard"; }
        grep -q 'mcp-notes\|mcp-utils' $ing && { ok=0; fail "$rendered: Ingress exposes an upstream MCP server"; }
        [ "$ok" -eq 1 ] && pass "$rendered: Ingress routes /api, /mcp -> gateway and / -> dashboard only"
      fi
      ;;
  esac
done

# Template-level checks: no secret may be generated or defaulted to a non-empty literal.
# (function calls take an argument, e.g. `randAlphaNum 32`; comments that merely mention them do not)
if grep -rnE '(randAlphaNum|randAscii|randNumeric|randBytes) +[0-9]|derivePassword +|genPrivateKey +"' "$ROOT/charts"/*/templates >/dev/null; then
  fail "a template generates secret material (rand*/derivePassword/genPrivateKey)"
else
  pass "no template generates secret material"
fi
if grep -rn 'Values\.secrets\.[A-Za-z]* *| *default *"[^"]\+"' "$ROOT/charts"/*/templates >/dev/null; then
  fail "a template defaults a secret to a non-empty literal"
else
  pass "no secret value is defaulted to a literal in the templates"
fi

# --- 4. kubeconform (optional) -------------------------------------------------------------------
if command -v "$KUBECONFORM" >/dev/null 2>&1; then
  for rendered in store-local store-prod platform-local platform-prod; do
    log "kubeconform $rendered"
    "$KUBECONFORM" -strict -ignore-missing-schemas -kubernetes-version "${KUBECONFORM_K8S_VERSION:-1.33.0}" -summary "$work/$rendered.yaml" \
      || fail "kubeconform $rendered"
  done
else
  warn "kubeconform not found (set KUBECONFORM=/path or install it); skipping schema validation"
fi

[ "$failures" -eq 0 ] && log "lint passed" || die "$failures check(s) failed"
