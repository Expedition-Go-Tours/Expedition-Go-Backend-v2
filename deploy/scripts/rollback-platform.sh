#!/usr/bin/env bash
# Roll the Platform API container back to the image that was running before the
# most recent successful deploy. The Stays container is untouched.
#
# Usage:
#   rollback-platform.sh
#
# The previous image is recorded in /var/lib/travio/deploy-state.env by
# deploy-platform.sh. A rollback re-runs the readiness gate; if the previous
# image also fails to become ready the script exits non-zero and prints logs.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/scripts/lib.sh
. "$SCRIPT_DIR/lib.sh"

[ $# -eq 0 ] || die "Usage: $0 (no arguments; rolls back to the recorded previous image)"

rollback_app platform
