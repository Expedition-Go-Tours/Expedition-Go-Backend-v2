#!/usr/bin/env bash
# Deploy only the Stays API. The Platform API container is not pulled,
# recreated or restarted by this script.
#
# Usage:
#   deploy-stays.sh ghcr.io/expedition-go-tours/stays-api:sha-b94a12e
#   deploy-stays.sh ghcr.io/expedition-go-tours/stays-api@sha256:...
#
# On failure the script restores the previously deployed image automatically
# and exits non-zero.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/scripts/lib.sh
. "$SCRIPT_DIR/lib.sh"

[ $# -eq 1 ] || die "Usage: $0 <stays-api image tag or digest>"

deploy_app stays "$1"
