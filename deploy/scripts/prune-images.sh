#!/usr/bin/env bash
# Remove superseded Docker images from the production host.
#
# This script is deliberately narrow. It never runs `docker system prune`,
# never touches containers, volumes, networks, PostgreSQL or Redis data, and
# never passes a wildcard to `docker rmi`. Only explicit image IDs are removed.
#
# Protected images:
#   - CURRENT and PREVIOUS for every app in /var/lib/travio/deploy-state.env
#   - every image referenced by any container, running or stopped
# If a protected reference is not local, the script checks the registry before
# allowing any deletion, so a rollback target is never discarded.
#
# Dry run by default. Set CONFIRM=1 to delete.

set -euo pipefail

STATE_FILE="${TRAVIO_DEPLOY_STATE:-/var/lib/travio/deploy-state.env}"
CONFIRM="${CONFIRM:-0}"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
log() { printf '%s\n' "$*"; }

command -v docker >/dev/null 2>&1 || die "docker not found"
[ -r "$STATE_FILE" ] || die "deploy state not readable: $STATE_FILE"

log "Docker disk usage before:"
docker system df

declare -A protected=()

short_id() {
  local id="${1#sha256:}"
  printf '%s' "${id:0:12}"
}

protect_ref() {
  local ref="$1" id
  [ -n "$ref" ] || return 0
  if id=$(docker image inspect "$ref" --format '{{.Id}}' 2>/dev/null); then
    protected["$(short_id "$id")"]=1
  else
    docker manifest inspect "$ref" >/dev/null 2>&1 ||
      die "rollback image unavailable locally or in registry: $ref"
  fi
}

# Current + previous known-good images for every deployed app.
while IFS='=' read -r key value; do
  case "$key" in
    *_IMAGE_CURRENT|*_IMAGE_PREVIOUS) protect_ref "$value" ;;
  esac
done < "$STATE_FILE"

# Images used by containers, including stopped ones.
while IFS= read -r id; do
  [ -n "$id" ] && protected["$(short_id "$id")"]=1
done < <(docker ps -aq | xargs -r docker inspect --format '{{.Image}}' 2>/dev/null || true)

[ "${#protected[@]}" -gt 0 ] || die "no protected images resolved; refusing to prune"

candidates=()
declare -A seen=() tags_by_id=()
while IFS='|' read -r id ref; do
  short="$(short_id "$id")"
  if [[ -n "${protected[$short]+x}" ]]; then
    log "KEEP  $short  $ref"
    continue
  fi
  tags_by_id["$short"]+=" $ref"
  [ -z "${seen[$short]+x}" ] || continue
  seen["$short"]=1
  candidates+=("$short")
  log "PRUNE $short  $ref"
done < <(docker images --format '{{.ID}}|{{.Repository}}:{{.Tag}}')

if [ "${#candidates[@]}" -eq 0 ]; then
  log "No superseded images to remove."
  exit 0
fi

log "${#candidates[@]} image(s) selected for removal."

if [ "$CONFIRM" != "1" ]; then
  log "Dry run. Set CONFIRM=1 to remove them."
  exit 0
fi

failed=0
for id in "${candidates[@]}"; do
  # An image with several tags cannot always be removed by ID. Remove each tag
  # explicitly, falling back to the ID for an untagged (<none>:<none>) image.
  for ref in ${tags_by_id[$id]-}; do
    target="$id"
    [ "$ref" = "<none>:<none>" ] || target="$ref"
    if ! docker rmi "$target" >/dev/null 2>&1; then
      log "SKIP  $target (in use or cannot remove)"
      failed=$((failed + 1))
    fi
  done
done

log "Docker disk usage after:"
docker system df

[ "$failed" -eq 0 ] || die "$failed image(s) could not be removed"
