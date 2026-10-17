# Local workflow (docs/contracts.md section 15). Every target delegates to deploy/scripts/*.sh,
# which run under bash (Git Bash on Windows, bash on Linux/macOS).
#
# Overrides (environment or `make VAR=value`):
#   KIND / HELM / KUBECTL / DOCKER   binaries           DOMAIN   local domain (default 127.0.0.1.nip.io)
#   TAG                              image tag (dev)    CLUSTER  kind cluster name (urumi)
#   KUBECONFORM                      path to kubeconform for `make lint` (optional)
#
# NetworkPolicies are enforced by kind's default CNI (kube-network-policies) and by k3s's
# kube-router, so there is no NETPOL switch and no Calico install.

SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
SCRIPTS := deploy/scripts
APPS := gateway dashboard woo-mcp extra-mcp

export KIND HELM KUBECTL DOCKER DOMAIN TAG CLUSTER KUBECONFORM

.PHONY: help tools-check secrets kind-up build load deploy local-up local-down status test lint k3s-deploy k3s-load-images

help: ## list targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-16s\033[0m %s\n", $$1, $$2}'

tools-check: ## verify docker, kind, kubectl, helm are on PATH
	@$(SCRIPTS)/tools-check.sh

secrets: ## write deploy/secrets/{platform,store}.yaml with random values (never overwrites)
	@$(SCRIPTS)/gen-secrets.sh

kind-up: ## create the kind cluster and install Traefik
	@$(SCRIPTS)/kind-up.sh

build: ## build the four images with tag $(TAG)
	@$(SCRIPTS)/build-images.sh

load: ## load the four images into kind (docker save --platform + kind load image-archive)
	@$(SCRIPTS)/load-images.sh

deploy: ## helm upgrade --install store then platform with values-local.yaml + deploy/secrets
	@$(SCRIPTS)/deploy.sh

local-up: tools-check secrets kind-up build load deploy ## everything: cluster, images, both releases

local-down: ## delete the kind cluster
	@$(SCRIPTS)/local-down.sh

status: ## pods, ingresses, URLs
	@$(SCRIPTS)/status.sh

test: ## npm test in every app
	@for app in $(APPS); do \
	  echo "==> apps/$$app"; \
	  ( cd "apps/$$app" && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && npm test ); \
	done

lint: ## helm lint both charts with both values files, helm template + invariant greps (+ kubeconform if present)
	@$(SCRIPTS)/lint.sh

k3s-deploy: ## deploy to k3s with values-prod.yaml (DOMAIN=... IMAGE_PREFIX=... TAG=...)
	@$(SCRIPTS)/k3s-deploy.sh

k3s-load-images: ## sideload images into a k3s node over ssh (K3S_HOST=user@host)
	@$(SCRIPTS)/k3s-load-images.sh
