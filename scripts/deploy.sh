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
  echo "=== Guarding against a stray second PM2 daemon ==="
  # A PM2 daemon started as root (an ad-hoc `sudo pm2 …`) binds port
  # 5000 and makes the deploy-owned expedition-api exit with
  # "Port already in use — Exiting for PM2 backoff" on every boot, so
  # PM2 restart-loops. scripts/deploy.sh has had this preflight for
  # exactly that reason; the CI path was missing it.
  #
  # Two rules this code must obey, both learned on 2026-10-22:
  #   1. NEVER run `pm2` as root here. pm2 STARTS the God daemon when
  #      none is running, and that daemon auto-resurrects its saved
  #      app list — so `pm2 delete all` CREATES the stray it is meant
  #      to remove. That is what put the API in a bind loop.
  #   2. This runs under `set -euo pipefail`, where `grep` finding
  #      nothing aborts the deploy — and a naive ps|grep|awk matches
  #      its own pipeline (each command carries the search string in
  #      its own argv) and would kill itself. Detection is therefore
  #      no-match-safe and filters out its own processes.
  root_pids_matching() {
    ps -eo pid=,user=,args= 2>/dev/null \
      | grep -F -- "\$1" 2>/dev/null \
      | grep -v grep 2>/dev/null \
      | awk -v self="\$\$" -v parent="\$PPID" \
          '\$2=="root" && \$1 != self && \$1 != parent && \$0 !~ /root_pids_matching|grep -v grep|ps -eo|pgrep|bash -c/ {print \$1}' \
      || true
  }

  ROOT_PM2_PIDS="\$(root_pids_matching 'God Daemon (/root/.pm2)')"
  for PID in \$ROOT_PM2_PIDS; do
    case "\$PID" in ''|*[!0-9]*) continue ;; esac
    echo "WARN: stray root PM2 daemon (pid \$PID) — killing it"
    kill -TERM "\$PID" 2>/dev/null || true
  done
  if [ -n "\$ROOT_PM2_PIDS" ]; then sleep 2; fi
  for PID in \$ROOT_PM2_PIDS; do
    case "\$PID" in ''|*[!0-9]*) continue ;; esac
    kill -KILL "\$PID" 2>/dev/null || true
  done

  # Root-owned copies of OUR apps fight the deploy-owned ones for the
  # port. Kill those too, matched on this repo's paths only.
  for APP_PATH in server.js utils/clipService.py bots/discord-bot/index.js; do
    for PID in \$(root_pids_matching "/home/deploy/Expedition-Go-Backend-v2/\$APP_PATH"); do
      case "\$PID" in ''|*[!0-9]*) continue ;; esac
      echo "WARN: root-owned \$APP_PATH (pid \$PID) — killing"
      kill -9 "\$PID" 2>/dev/null || true
    done
  done
  rm -rf /root/.pm2

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
