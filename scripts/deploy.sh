#!/usr/bin/env bash
# deploy.sh — Production deploy for Expedition Go Backend
#
# USAGE (from local machine):
#   bash scripts/deploy.sh              # pull + install + reload
#   bash scripts/deploy.sh --skip-install  # pull + reload only
#
# IMPORTANT: All PM2 commands MUST run as the `deploy` user.
# Running PM2 as root creates a second daemon that fights for port 5000
# and causes EADDRINUSE restart loops.
#
set -euo pipefail

SERVER="root@2.28.45.181"
SSH_KEY="$HOME/.ssh/hetzner_new"
APP_DIR="/home/deploy/Expedition-Go-Backend-v2"
SKIP_INSTALL=false

if [[ "${1:-}" == "--skip-install" ]]; then
  SKIP_INSTALL=true
fi

echo "==> Deploying to $SERVER as deploy user..."

ssh -i "$SSH_KEY" "$SERVER" bash -s <<REMOTE
  set -euo pipefail
  cd "$APP_DIR"

  echo "--- git pull ---"
  git pull origin main

  if [[ "$SKIP_INSTALL" == "false" ]]; then
    echo "--- npm install ---"
    npm install --production --silent
  fi

  echo "--- pm2 reload (as deploy user) ---"
  # CRITICAL: Use 'su - deploy' to ensure PM2 commands run under the
  # correct user. Running as root creates a second PM2 daemon that
  # competes for port 5000, causing EADDRINUSE restart loops.
  su - deploy -c "cd $APP_DIR && pm2 reload expedition-api --update-env"

  echo "--- health check ---"
  sleep 5
  curl -s http://localhost:5000/health | python3 -m json.tool 2>/dev/null || curl -s http://localhost:5000/health

  echo "--- deploy user pm2 status ---"
  su - deploy -c "pm2 list"
REMOTE

echo "==> Deploy complete."
