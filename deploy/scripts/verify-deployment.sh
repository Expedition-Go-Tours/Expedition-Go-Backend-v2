#!/usr/bin/env bash
# Verify a running pair of API containers from the host.
#
# Usage:
#   verify-deployment.sh            # verify both services
#   verify-deployment.sh platform   # verify only 127.0.0.1:5000
#   verify-deployment.sh stays      # verify only 127.0.0.1:5100
#
# Why this exists: `/ready` returning 200 only proves the process reached the
# database. It does not prove that the route table survived the release, that
# the Stays container is not accidentally serving Tours, or that the legacy
# aliases still answer. Those are the failure modes a container health check
# cannot see, and they are the ones a version split makes possible.
#
# Exit status is 0 only if every assertion passed. Failures are printed with the
# endpoint, the expected status class and the actual one.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/scripts/lib.sh
. "$SCRIPT_DIR/lib.sh"

TARGET="${1:-both}"
case "$TARGET" in
  both|platform|stays) ;;
  *) die "Usage: $0 [both|platform|stays]" ;;
esac

command -v curl >/dev/null 2>&1 || die "curl is required."

FAILURES=0

# A deploy gate must not fail on a single connection blip: the two deploy jobs
# run concurrently, and a route can be mid-recreate for a second. Retry only
# outcomes that are genuinely transient (connection failure, rate limit, 5xx);
# a wrong 200/401/404 is a real failure and is reported immediately.
RETRY_ATTEMPTS="${VERIFY_RETRIES:-3}"
RETRY_DELAY="${VERIFY_RETRY_DELAY:-2}"

# Status code for a GET, or 000 when the connection failed.
status_of() {
  local url="$1"
  curl -s -o /dev/null -m 10 -w '%{http_code}' "$url" 2>/dev/null || true
}

# assert_status <url> <expected-regex> <description>
assert_status() {
  local url="$1" expected="$2" description="$3"
  local code attempt
  for attempt in $(seq 1 "$RETRY_ATTEMPTS"); do
    code="$(status_of "$url")"
    if [[ "$code" =~ ^($expected)$ ]]; then
      log "ok    ${code}  ${description}"
      return 0
    fi
    if [[ "$code" =~ ^(000|429|5[0-9][0-9])$ ]] && [ "$attempt" -lt "$RETRY_ATTEMPTS" ]; then
      warn "retry ${code:-000} (attempt ${attempt}/${RETRY_ATTEMPTS})  ${description}  ${url}"
      sleep "$RETRY_DELAY"
      continue
    fi
    break
  done

  warn "FAIL  ${code:-000} (expected ${expected})  ${description}  ${url}"
  FAILURES=$((FAILURES + 1))
  return 1
}

# ── Platform API ────────────────────────────────────────────────────────────
verify_platform() {
  local base="http://127.0.0.1:${PLATFORM_PORT}"
  log "── platform-api (${base}) ──"

  assert_status "${base}/health" "200" "liveness" || true
  assert_status "${base}/ready" "200" "readiness" || true

  # A public Tours collection. 200 is success; 429 would mean the limiter is
  # misconfigured; 404 would mean the router did not mount.
  assert_status "${base}/api/v1/tours" "200" "canonical Tours route" || true
  assert_status "${base}/api/tours" "200" "legacy Tours route" || true

  # Stays is served by the Platform API during the alias period. A 401 proves
  # the route exists *and* the auth guard is in front of it.
  assert_status "${base}/api/v1/travioghana/supplier/stays/properties" "401" \
    "Stays route still guarded on Platform (alias period)" || true

  # The probes are outside the rate-limited `/api` mount. This is a smoke test
  # of that arrangement: 404 here would mean the probe was moved behind auth.
  assert_status "${base}/api/v1/definitely-not-a-route" "404" "unknown route 404" || true
}

# ── Stays API ───────────────────────────────────────────────────────────────
verify_stays() {
  local base="http://127.0.0.1:${STAYS_PORT}"
  log "── stays-api (${base}) ──"

  assert_status "${base}/health" "200" "liveness" || true
  assert_status "${base}/ready" "200" "readiness" || true

  # Protected route: 401 means mounted and guarded. Anything 5xx means the
  # process is up but the router or its guards are broken.
  assert_status "${base}/api/v1/travioghana/supplier/stays/properties" "401" \
    "canonical Stays route is guarded" || true
  assert_status "${base}/api/travioghana/supplier/stays/properties" "401" \
    "legacy Stays route is guarded" || true

  # Isolation. This is the whole point of the second application: a Stays-only
  # release must not be able to serve a Tours surface, even by accident.
  assert_status "${base}/api/v1/tours" "404" "Tours route absent from Stays" || true
  assert_status "${base}/api/tours" "404" "legacy Tours route absent from Stays" || true
}

case "$TARGET" in
  platform) verify_platform ;;
  stays) verify_stays ;;
  both) verify_platform; verify_stays ;;
esac

if [ "$FAILURES" -ne 0 ]; then
  warn "${FAILURES} check(s) failed."
  exit 1
fi

log "All checks passed."
