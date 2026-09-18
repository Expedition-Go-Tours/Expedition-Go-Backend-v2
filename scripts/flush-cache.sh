#!/usr/bin/env bash
# Flush the app's derived caches (hp:*, expedition:*) from Redis after a deploy.
#
# Why: homepage / expedition caches are derived and can mask a code change (this
# bit us once — a new region-fallback served a pre-deploy body until the cache
# expired). Flushing them right after the reload makes every deploy start clean.
#
# SAFETY: scoped to the derived-cache namespaces. NEVER FLUSHDB — Redis also
# holds the BullMQ queues, sessions and rate-limit counters.
#
# Usage: bash scripts/flush-cache.sh [path/to/.env]
#        FLUSH_PATTERNS="hp:*" bash scripts/flush-cache.sh   # override patterns
set -euo pipefail

ENV_FILE="${1:-/home/deploy/Expedition-Go-Backend-v2/.env}"
# Derived-cache namespaces to clear. Expedition detail/list payloads now embed
# the combined review stats, so they must be cleared alongside the homepage.
PATTERNS="${FLUSH_PATTERNS:-hp:* expedition:*}"

if ! command -v redis-cli >/dev/null 2>&1; then
  echo "flush-cache: redis-cli not found — skipping"
  exit 0
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "flush-cache: env file not found ($ENV_FILE) — skipping"
  exit 0
fi

URL=$(grep -E '^REDIS_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r')
if [ -z "$URL" ]; then
  echo "flush-cache: no REDIS_URL — skipping"
  exit 0
fi

# Parse host/port/password from the URL in Python (robust to special chars,
# which broke redis-cli's own -u parsing on this box).
read -r HOST PORT PASS < <(python3 - "$URL" <<'PY'
import sys, urllib.parse as u
p = u.urlparse(sys.argv[1])
print(p.hostname or '127.0.0.1', p.port or 6379, p.password or '')
PY
)

ARGS=(-h "$HOST" -p "$PORT" --no-auth-warning)
[ -n "$PASS" ] && ARGS+=(-a "$PASS")

if ! redis-cli "${ARGS[@]}" PING >/dev/null 2>&1; then
  echo "flush-cache: Redis unreachable — skipping"
  exit 0
fi

TOTAL=0
for PATTERN in $PATTERNS; do
  KEYS=$(redis-cli "${ARGS[@]}" --scan --pattern "$PATTERN" 2>/dev/null || true)
  if [ -z "$KEYS" ]; then
    echo "flush-cache: no $PATTERN keys"
    continue
  fi
  COUNT=$(printf '%s\n' "$KEYS" | wc -l | tr -d ' ')
  printf '%s\n' "$KEYS" | xargs -r redis-cli "${ARGS[@]}" DEL >/dev/null 2>&1 || true
  echo "flush-cache: flushed $COUNT $PATTERN keys"
  TOTAL=$((TOTAL + COUNT))
done
echo "flush-cache: done ($TOTAL keys)"
