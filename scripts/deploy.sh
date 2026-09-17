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

# Fix ownership: package-lock.json may be root-owned from a previous manual deploy
chown deploy:deploy package-lock.json 2>/dev/null || true
# Use npm install (not npm ci) to avoid tearing down node_modules,
npm install --production
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

  echo "--- prisma migrate ---"
  # Migrations are applied here, not by hand. Leaving this step manual is how
  # schema.prisma, the migration history and production drifted apart: two
  # indexes and a column default existed only in the database, and the
  # travioafrica enum value existed only in the schema.
  #
  # RULE FOR EVERY MIGRATION: it must be backward-compatible with the code that
  # is already running (expand/contract — add nullable, backfill, switch reads,
  # drop in a later release). This step applies automatically on every deploy,
  # so a destructive migration takes effect the moment a deploy runs.
  #
  # `migrate status` is read-only and exits non-zero when something is pending,
  # hence `|| true`; it is here so the deploy log shows what is about to change.
  # `set -e` means a failed migration aborts the deploy and the running code
  # keeps serving — never a half-migrated database with new code on top.
  npx prisma migrate status || true
  # One-time: resolve the stuck reconcile_schema_drift migration (applied before FK safety drops)
  npx prisma migrate resolve --rolled-back 20260916120000_reconcile_schema_drift 2>/dev/null || true
  npx prisma migrate deploy

  echo "--- preflight: guard against a stray second PM2 daemon ---"
  # A PM2 daemon started as root (e.g. an ad-hoc 'sudo pm2 restart') binds
  # port 5000 and makes the deploy-owned expedition-api crash-loop on
  # EADDRINUSE. Detect and remove it before reloading.
  if [[ -f /root/.pm2/pm2.pid ]] && kill -0 "\$(cat /root/.pm2/pm2.pid)" 2>/dev/null; then
    echo "WARN: stray root PM2 daemon detected — deleting its apps and killing it"
    PM2_HOME=/root/.pm2 pm2 delete all >/dev/null 2>&1 || true
    PM2_HOME=/root/.pm2 pm2 kill >/dev/null 2>&1 || true
  fi

  echo "--- pm2 reload (as deploy user) ---"
  # CRITICAL: Use 'su - deploy' to ensure PM2 commands run under the
  # correct user. Running as root creates a second PM2 daemon that
  # competes for port 5000, causing EADDRINUSE restart loops.
  su - deploy -c "cd $APP_DIR && pm2 reload expedition-api --update-env"

  echo "--- flush derived caches (hp:*) ---"
  # Homepage / place caches are derived and can mask a code change. Flush them
  # right after the reload so a deploy is never served a stale body. Scoped to
  # 'hp:*' — never FLUSHDB (Redis also holds queues/sessions/rate limits).
  bash scripts/flush-cache.sh "$APP_DIR/.env" || true

  echo "--- health check ---"
  sleep 5
  curl -s http://localhost:5000/health | python3 -m json.tool 2>/dev/null || curl -s http://localhost:5000/health

  echo "--- deploy user pm2 status ---"
  su - deploy -c "pm2 list"
REMOTE

echo "==> Deploy complete."
