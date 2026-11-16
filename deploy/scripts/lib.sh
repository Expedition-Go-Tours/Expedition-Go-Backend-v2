#!/usr/bin/env bash
# Shared helpers for the Travio deploy scripts.
#
# Every script sources this file. Nothing here reaches the network unless the
# calling script asks it to, and nothing here prints a secret.

set -euo pipefail

# ── Locations (override with environment variables) ─────────────────────────
# The deploy workflow syncs this checkout to the release commit before invoking
# any script, so the repo is the source of truth for the Compose file as well as
# the scripts. A manual operator can still point COMPOSE_FILE elsewhere.
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$LIB_DIR/../.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_ROOT/deploy/compose.production.yml}"
STATE_DIR="${STATE_DIR:-/var/lib/travio}"
STATE_FILE="${STATE_FILE:-$STATE_DIR/deploy-state.env}"
PLATFORM_ENV_FILE="${PLATFORM_ENV_FILE:-/etc/travio/platform-api.env}"
STAYS_ENV_FILE="${STAYS_ENV_FILE:-/etc/travio/stays-api.env}"

PLATFORM_PORT="${PLATFORM_PORT:-5000}"
STAYS_PORT="${STAYS_PORT:-5100}"

PLATFORM_IMAGE_REPO="ghcr.io/expedition-go-tours/platform-api"
STAYS_IMAGE_REPO="ghcr.io/expedition-go-tours/stays-api"

# ── Output ──────────────────────────────────────────────────────────────────
log()  { printf '[deploy] %s\n' "$*"; }
warn() { printf '[deploy] WARNING: %s\n' "$*" >&2; }
die()  { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

# ── Argument validation ─────────────────────────────────────────────────────
# Accept an immutable tag (`…:sha-abc1234`, `…:1.4.0`) or a digest
# (`…@sha256:…`). Refuse `latest` and refuse a bare repository.
validate_image_ref() {
  local image="$1" expected_repo="$2"

  [ -n "$image" ] || die "Image reference is required."

  if [[ "$image" == "$expected_repo@sha256:"* ]]; then
    return 0
  fi

  if [[ "$image" != "$expected_repo:"* ]]; then
    die "Image '$image' does not belong to '$expected_repo'. Refusing to deploy the wrong application."
  fi

  local tag="${image##*:}"
  [ -n "$tag" ] || die "Image '$image' has no tag."
  [ "$tag" != "latest" ] || die "Refusing to deploy ':latest'. Pass an immutable commit-SHA or semver tag (or a digest)."

  return 0
}

# ── State ───────────────────────────────────────────────────────────────────
ensure_state_dir() {
  mkdir -p "$STATE_DIR"
}

state_get() {
  local key="$1"
  [ -f "$STATE_FILE" ] || return 0
  # `grep` may legitimately find nothing; keep `set -e` from killing the script.
  { grep -E "^${key}=" "$STATE_FILE" 2>/dev/null || true; } | tail -n 1 | cut -d= -f2-
}

# Atomically record one key without losing the others.
state_set() {
  local key="$1" value="$2"
  ensure_state_dir
  local tmp
  tmp="$(mktemp "${STATE_FILE}.XXXXXX")"
  if [ -f "$STATE_FILE" ]; then
    grep -vE "^${key}=" "$STATE_FILE" > "$tmp" || true
  fi
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  chmod 0640 "$tmp"
  mv "$tmp" "$STATE_FILE"
}

# ── Readiness ───────────────────────────────────────────────────────────────
# A container being "Up" is not a deployment. This polls the application's own
# readiness endpoint until it returns 200 or the attempts run out.
wait_ready() {
  local port="$1"
  local path="${2:-/ready}"
  local attempts="${3:-30}"
  local delay="${4:-2}"

  command -v curl >/dev/null 2>&1 || die "curl is required for readiness checks."

  local i code
  for i in $(seq 1 "$attempts"); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}${path}" || true)"
    if [ "$code" = "200" ]; then
      log "ready after ${i} attempt(s): http://127.0.0.1:${port}${path} -> 200"
      return 0
    fi
    log "not ready yet (attempt ${i}/${attempts}, status ${code:-none})"
    sleep "$delay"
  done

  return 1
}

# Container name used by compose.production.yml.
container_name_for() {
  case "$1" in
    platform) printf 'travio-platform-api\n' ;;
    stays)    printf 'travio-stays-api\n' ;;
    *) die "Unknown application: $1" ;;
  esac
}

# Wait for the specific container to be running the expected image AND for its
# Docker healthcheck to report healthy.
#
# The port is not enough. On 2026-11-16 a stale PM2 process held port 5000 while
# the new Platform container crash-looped; `curl /ready` hit the stale process
# and the deploy reported success for a container that never bound the port.
# Checking `Config.Image` and `.State.Health` against the requested image makes
# that failure mode impossible: a different process cannot satisfy it, and a
# crash-looping container never reports healthy.
wait_container_healthy() {
  local container="$1" expected_image="$2" attempts="${3:-60}" delay="${4:-2}"
  local i running image health

  for i in $(seq 1 "$attempts"); do
    running="$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || true)"
    image="$(docker inspect -f '{{.Config.Image}}' "$container" 2>/dev/null || true)"
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || true)"

    if [ "$running" = "running" ] && [ "$image" = "$expected_image" ] && [ "$health" = "healthy" ]; then
      log "container healthy: $container ($expected_image)"
      return 0
    fi

    log "container not healthy yet (attempt ${i}/${attempts}: status=${running:-missing} image=${image:-none} health=${health:-none})"
    sleep "$delay"
  done

  return 1
}

# ── Compose wrapper ─────────────────────────────────────────────────────────
# Both image variables must be defined even when only one service is being
# changed: Compose interpolates the whole file before honouring --no-deps.
compose_env_for() {
  local app="$1" image="$2"
  local platform stays
  if [ "$app" = "platform" ]; then
    platform="$image"
    stays="$(state_get STAYS_IMAGE_CURRENT)"
    stays="${stays:-${STAYS_IMAGE_REPO}:not-deployed}"
  else
    stays="$image"
    platform="$(state_get PLATFORM_IMAGE_CURRENT)"
    platform="${platform:-${PLATFORM_IMAGE_REPO}:not-deployed}"
  fi
  printf '%s\n%s\n' "$platform" "$stays"
}

compose_up_one() {
  local app="$1" image="$2" service="$3"
  local images platform stays
  images="$(compose_env_for "$app" "$image")"
  platform="$(printf '%s\n' "$images" | sed -n '1p')"
  stays="$(printf '%s\n' "$images" | sed -n '2p')"

  PLATFORM_IMAGE="$platform" \
  STAYS_IMAGE="$stays" \
  PLATFORM_ENV_FILE="$PLATFORM_ENV_FILE" \
  STAYS_ENV_FILE="$STAYS_ENV_FILE" \
  docker compose -f "$COMPOSE_FILE" up -d --no-deps "$service"
}

compose_logs() {
  local service="$1"
  local platform stays
  platform="$(state_get PLATFORM_IMAGE_CURRENT)"
  stays="$(state_get STAYS_IMAGE_CURRENT)"
  PLATFORM_IMAGE="${platform:-${PLATFORM_IMAGE_REPO}:not-deployed}" \
  STAYS_IMAGE="${stays:-${STAYS_IMAGE_REPO}:not-deployed}" \
  PLATFORM_ENV_FILE="$PLATFORM_ENV_FILE" \
  STAYS_ENV_FILE="$STAYS_ENV_FILE" \
  docker compose -f "$COMPOSE_FILE" logs --tail=120 --no-color "$service" || true
}

# ── Deploy one application ──────────────────────────────────────────────────
deploy_app() {
  local app="$1" image="$2"
  local service port repo current_key previous_key

  case "$app" in
    platform) service="platform-api"; port="$PLATFORM_PORT"; repo="$PLATFORM_IMAGE_REPO"
              current_key="PLATFORM_IMAGE_CURRENT"; previous_key="PLATFORM_IMAGE_PREVIOUS" ;;
    stays)    service="stays-api";    port="$STAYS_PORT";    repo="$STAYS_IMAGE_REPO"
              current_key="STAYS_IMAGE_CURRENT"; previous_key="STAYS_IMAGE_PREVIOUS" ;;
    *) die "Unknown application: $app" ;;
  esac

  validate_image_ref "$image" "$repo"

  [ -f "$COMPOSE_FILE" ] || die "Compose file not found: $COMPOSE_FILE"

  if command -v flock >/dev/null 2>&1; then
    exec 9>"${STATE_DIR}/deploy-${app}.lock"
    flock -n 9 || die "Another ${app} deployment holds the lock."
  fi

  local previous
  previous="$(state_get "$current_key")"

  log "Pulling $image"
  local images platform stays
  images="$(compose_env_for "$app" "$image")"
  platform="$(printf '%s\n' "$images" | sed -n '1p')"
  stays="$(printf '%s\n' "$images" | sed -n '2p')"
  PLATFORM_IMAGE="$platform" STAYS_IMAGE="$stays" \
    PLATFORM_ENV_FILE="$PLATFORM_ENV_FILE" STAYS_ENV_FILE="$STAYS_ENV_FILE" \
    docker compose -f "$COMPOSE_FILE" pull "$service"

  local container
  container="$(container_name_for "$app")"

  log "Replacing only the '$service' container (no other service is touched)"
  compose_up_one "$app" "$image" "$service"

  # Container identity and Docker health first, then the application's own
  # readiness endpoint. The order matters: a stale process on the port must not
  # be able to satisfy the gate on behalf of a container that never started.
  if wait_container_healthy "$container" "$image" 75 2 && wait_ready "$port" /ready 45 2; then
    [ -z "$previous" ] || state_set "$previous_key" "$previous"
    state_set "$current_key" "$image"
    log "$service is healthy on image $image"
    return 0
  fi

  warn "$service did not become ready on $image"
  compose_logs "$service"

  if [ -n "$previous" ]; then
    warn "Rolling back $service to $previous"
    compose_up_one "$app" "$previous" "$service" || true
    if wait_container_healthy "$container" "$previous" 60 2 && wait_ready "$port" /ready 30 2; then
      warn "Rollback of $service succeeded; deployment FAILED. Previous image is running."
    else
      warn "Rollback of $service did NOT become ready. Manual intervention required."
    fi
  else
    warn "No previous image recorded for $service; cannot auto-rollback."
  fi

  exit 1
}

rollback_app() {
  local app="$1"
  local service port current_key previous_key target

  case "$app" in
    platform) service="platform-api"; port="$PLATFORM_PORT"
              current_key="PLATFORM_IMAGE_CURRENT"; previous_key="PLATFORM_IMAGE_PREVIOUS" ;;
    stays)    service="stays-api";    port="$STAYS_PORT"
              current_key="STAYS_IMAGE_CURRENT"; previous_key="STAYS_IMAGE_PREVIOUS" ;;
    *) die "Unknown application: $app" ;;
  esac

  target="$(state_get "$previous_key")"
  [ -n "$target" ] || die "No previous image recorded for $service; nothing to roll back to."

  local container
  container="$(container_name_for "$app")"

  log "Rolling $service back to $target"
  compose_up_one "$app" "$target" "$service"

  if ! wait_container_healthy "$container" "$target" 75 2 || ! wait_ready "$port" /ready 45 2; then
    compose_logs "$service"
    die "$service did not become ready after rollback."
  fi

  local current
  current="$(state_get "$current_key")"
  state_set "$current_key" "$target"
  [ -z "$current" ] || state_set "$previous_key" "$current"
  log "$service rolled back to $target"
}
