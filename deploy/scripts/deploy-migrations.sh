#!/usr/bin/env bash
# Apply the shared Prisma migration history exactly once.
#
# Usage:
#   deploy-migrations.sh                                  # apply, using the image currently recorded for platform-api
#   deploy-migrations.sh <platform-api image tag/digest>   # apply, using a specific image
#   deploy-migrations.sh --status [image]                 # report pending/applied, change nothing
#
# Why the platform image: it carries `prisma/schema.prisma`, the migration
# directory and the Prisma CLI. Both APIs share one schema, so running the
# command twice would be meaningless — a file lock and the workflow's
# `concurrency: production-database` group keep two deploy jobs from racing.
#
# This script never runs `prisma db push`. Destructive schema synchronisation is
# not an option on a live database.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/scripts/lib.sh
. "$SCRIPT_DIR/lib.sh"

MODE="apply"
if [ "${1:-}" = "--status" ]; then
  MODE="status"
  shift
fi

IMAGE="${1:-}"
if [ -z "$IMAGE" ]; then
  IMAGE="$(state_get PLATFORM_IMAGE_CURRENT)"
fi

[ -n "$IMAGE" ] || die "No platform image supplied and none recorded in $STATE_FILE."
validate_image_ref "$IMAGE" "$PLATFORM_IMAGE_REPO"

[ -f "$COMPOSE_FILE" ] || die "Compose file not found: $COMPOSE_FILE"

ensure_state_dir
if command -v flock >/dev/null 2>&1; then
  exec 9>"${STATE_DIR}/migrations.lock"
  flock -n 9 || die "Another migration run holds the lock."
fi

STAYS_IMAGE="$(state_get STAYS_IMAGE_CURRENT)"
STAYS_IMAGE="${STAYS_IMAGE:-${STAYS_IMAGE_REPO}:not-deployed}"

run_prisma() {
  PLATFORM_IMAGE="$IMAGE" \
  STAYS_IMAGE="$STAYS_IMAGE" \
  PLATFORM_ENV_FILE="$PLATFORM_ENV_FILE" \
  STAYS_ENV_FILE="$STAYS_ENV_FILE" \
  docker compose -f "$COMPOSE_FILE" run --rm -T --no-deps --entrypoint npx platform-api "$@"
}

if [ "$MODE" = "status" ]; then
  log "Migration status using $IMAGE"
  run_prisma prisma migrate status
  exit 0
fi

log "Applying migrations once, using $IMAGE"
run_prisma prisma migrate deploy

log "Migration run completed"
