#!/usr/bin/env bash
# Verify the PUBLIC ingress, not just the containers on loopback.
#
# Why this exists: verify-deployment.sh proves that 127.0.0.1:5000 and :5100
# answer correctly. It cannot prove that a request from the internet reaches the
# intended upstream. A typo in a vhost, a missing include, or a Socket.IO header
# lost in the catch-all would pass the direct checks and fail customers.
#
# This script talks to the real hostnames over TLS, so it also proves DNS,
# certificates and the Nginx server blocks. It is run by the release workflow
# after both deploy jobs, and can be run by hand:
#
#   ./deploy/scripts/verify-public-ingress.sh
#   PUBLIC_HOSTS="apiv1.travioafrica.com api.travioghana.com" \
#     ./deploy/scripts/verify-public-ingress.sh
#
# The upstream is identified by X-Served-By, set by each application. A 401 from
# either service looks identical without it; the header is what proves the Stays
# paths actually reached 5100.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=deploy/scripts/lib.sh
. "$SCRIPT_DIR/lib.sh"

HOSTS="${PUBLIC_HOSTS:-apiv1.travioafrica.com api.travioghana.com api.expeditiongotours.com}"
STAYS_PATH="/travioghana/supplier/stays/properties"

FAILURES=0

status_of() {
  curl -sS -o /dev/null -m 15 -w '%{http_code}' "$1" 2>/dev/null || true
}

header_of() {
  local url="$1" name="$2"
  curl -sS -D - -o /dev/null -m 15 "$url" 2>/dev/null \
    | tr -d '\r' \
    | awk -F': ' -v key="$name" 'tolower($1) == tolower(key) { print $2; exit }'
}

assert_status() {
  local url="$1" expected="$2" description="$3"
  local code
  code="$(status_of "$url")"
  if [ "$code" = "$expected" ]; then
    log "ok    ${code}  ${description}"
    return 0
  fi
  warn "FAIL  ${code:-000} (expected ${expected})  ${description}  ${url}"
  FAILURES=$((FAILURES + 1))
  return 1
}

assert_header() {
  local url="$1" name="$2" expected="$3" description="$4"
  local value
  value="$(header_of "$url" "$name")"
  if [ "$value" = "$expected" ]; then
    log "ok    ${name}: ${value}  ${description}"
    return 0
  fi
  warn "FAIL  ${name}: ${value:-missing} (expected ${expected})  ${description}  ${url}"
  FAILURES=$((FAILURES + 1))
  return 1
}

assert_websocket() {
  local host="$1"
  local code
  # A successful upgrade returns 101 and then keeps the socket open; curl may
  # exit 28 on the timeout even though the status line was received.
  code="$(curl -sS -o /dev/null -m 8 --http1.1 -w '%{http_code}' \
    -H 'Connection: Upgrade' \
    -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    "https://${host}/socket.io/?EIO=4&transport=websocket" 2>/dev/null || true)"
  if [ "$code" = "101" ]; then
    log "ok    101  websocket upgrade"
    return 0
  fi
  warn "FAIL  ${code:-000} (expected 101)  websocket upgrade  https://${host}/socket.io/"
  FAILURES=$((FAILURES + 1))
  return 1
}

log "Public ingress: ${HOSTS}"

for host in $HOSTS; do
  log "── ${host} ──"

  assert_status "https://${host}/api/v1/tours" 200 "canonical Tours" || true
  assert_status "https://${host}/api/tours" 200 "legacy Tours" || true
  assert_header "https://${host}/api/v1/tours" "x-served-by" "platform-api" \
    "canonical Tours reached the Platform" || true
  assert_header "https://${host}/api/tours" "x-served-by" "platform-api" \
    "legacy Tours reached the Platform" || true

  assert_status "https://${host}/api/v1${STAYS_PATH}" 401 "canonical Stays" || true
  assert_status "https://${host}/api${STAYS_PATH}" 401 "legacy Stays" || true
  assert_header "https://${host}/api/v1${STAYS_PATH}" "x-served-by" "stays-api" \
    "canonical Stays reached 5100" || true
  assert_header "https://${host}/api${STAYS_PATH}" "x-served-by" "stays-api" \
    "legacy Stays reached 5100" || true

  assert_websocket "$host" || true
done

if [ "$FAILURES" -ne 0 ]; then
  warn "${FAILURES} public-ingress check(s) failed."
  exit 1
fi

log "All public-ingress checks passed."
