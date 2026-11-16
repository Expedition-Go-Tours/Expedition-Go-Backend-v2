#!/usr/bin/env bash
# Deploy only the Platform API. The Stays container is not pulled, recreated or
# restarted by this script.
#
# Usage:
#   deploy-platform.sh ghcr.io/expedition-go-tours/platform-api:sha-a83f92c
#   deploy-platform.sh ghcr.io/expedition-go-tours/platform-api@sha256:...
#
# Prerequisites (one-time, see docs/deployment/hetzner-migration.md):
#   /opt/travio/api/deploy/compose.production.yml
#   /etc/travio/platform-api.env
#   docker login ghcr.io with a read-only package token
#
# On failure the script restores the previously deployed image automatically
# and exits non-zero. It never reports success before /ready returns 200.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/scripts/lib.sh
. "$SCRIPT_DIR/lib.sh"

[ $# -eq 1 ] || die "Usage: $0 <platform-api image tag or digest>"

deploy_app platform "$1"
