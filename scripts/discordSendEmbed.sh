#!/usr/bin/env bash
# discordSendEmbed.sh — post a rich embed to a Discord webhook.
#
# Usage:
#   bash scripts/discordSendEmbed.sh <webhook_url> <json_payload_file>
#
# The JSON payload file must contain the full Discord embed structure, e.g.:
#   {
#     "embeds": [{
#       "title": "Deploy Successful",
#       "description": "v2.3.1 — minor bugfix",
#       "color": 5763719,
#       "fields": [
#         { "name": "Commit", "value": "`abc1234` fix: API error handling", "inline": true },
#         { "name": "Author", "value": "gideon211", "inline": true }
#       ],
#       "timestamp": "2026-09-01T12:00:00Z"
#     }]
#   }
#
# Exit codes:
#   0  — webhook returned 2xx (or was skipped because webhook_url is empty)
#   1  — usage error (missing args or file)
#   2  — curl failed

set -euo pipefail

WEBHOOK_URL="${1:-}"
PAYLOAD_FILE="${2:-}"

if [[ -z "$WEBHOOK_URL" ]]; then
  echo "discordSendEmbed.sh: DISCORD_WEBHOOK_URL is empty — skipping."
  exit 0
fi

if [[ ! -f "$PAYLOAD_FILE" ]]; then
  echo "discordSendEmbed.sh: payload file not found: $PAYLOAD_FILE" >&2
  exit 1
fi

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Content-Type: application/json" \
  -d @"$PAYLOAD_FILE" \
  --max-time 15 \
  "$WEBHOOK_URL")

if [[ "$HTTP_CODE" =~ ^2 ]]; then
  echo "discordSendEmbed.sh: sent (HTTP $HTTP_CODE)"
  exit 0
elif [[ "$HTTP_CODE" == "429" ]]; then
  RETRY_AFTER=$(cat /dev/null)
  echo "discordSendEmbed.sh: rate-limited (HTTP 429) — skipping." >&2
  exit 2
else
  echo "discordSendEmbed.sh: webhook returned HTTP $HTTP_CODE" >&2
  exit 2
fi
