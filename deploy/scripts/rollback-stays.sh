#!/usr/bin/env bash
# Roll the Stays API container back to the image that was running before the
# most recent successful deploy. The Platform API container is untouched.
#
# Usage:
#   rollback-stays.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/scripts/lib.sh
. "$SCRIPT_DIR/lib.sh"

[ $# -eq 0 ] || die "Usage: $0 (no arguments; rolls back to the recorded previous image)"

rollback_app stays
