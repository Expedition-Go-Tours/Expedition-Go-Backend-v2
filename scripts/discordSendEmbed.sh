#!/usr/bin/env bash
set -euo pipefail

WEBHOOK_URL="$1"
PAYLOAD_FILE="$2"

# Sanitize the JSON payload before sending.
# Discord rejects an empty-string `"timestamp": ""` with HTTP 400.
# We also re-serialize to guarantee valid JSON (shell interpolation may break escaping).
node -e '
  const fs = require("fs");
  const file = process.argv[1];
  const raw = fs.readFileSync(file, "utf8");
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    console.error("discordSendEmbed.sh: payload is not valid JSON:", e.message);
    process.exit(1);
  }
  if (payload.embeds && Array.isArray(payload.embeds)) {
    payload.embeds = payload.embeds.map(embed => {
      if (embed.timestamp === "") {
        delete embed.timestamp;
      }
      return embed;
    });
  }
  fs.writeFileSync(file, JSON.stringify(payload));
' "$PAYLOAD_FILE"

HTTP_CODE=$(curl -s -o /tmp/discord-response.json -w "%{http_code}" \\
  -X POST "$WEBHOOK_URL" \\
  -H "Content-Type: application/json" \\
  -d "@$PAYLOAD_FILE")

if [ "$HTTP_CODE" -ge 400 ]; then
  echo "discordSendEmbed.sh: webhook returned HTTP $HTTP_CODE"
  cat /tmp/discord-response.json 2>/dev/null || true
  exit 2
fi

echo "discordSendEmbed.sh: message sent (HTTP $HTTP_CODE)"
