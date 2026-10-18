#!/usr/bin/env bash
#
# Provision the isolated local test database (`travio_test`).
#
# Why a separate database
# -----------------------
# Tests write. `__tests__/user.integration.test.js` creates users and only
# cleans up the `integration-*` ones (its duplicate-email rows are never
# removed), and `__tests__/unit/regionFallback.test.js` runs deleteMany against
# attractions. Run against the development `travio` database they silently
# mutate real dev data.
#
# `travio_test` is created alongside `travio` in the same container, so it
# shares nothing with dev except the Postgres instance. The dev database is
# never read, written, or dropped by this script.
#
# Usage:
#   npm run test:db:up
#   TEST_DATABASE_URL=... npm run test:api
set -euo pipefail

DB_NAME="travio_test"
# Resolved below: whichever container publishes PG_PORT, since on this machine
# compose's travio-dev-postgres is not the one holding 5433.
PG_CONTAINER=""
PG_USER="postgres"
PG_PORT="${POSTGRES_PORT:-5433}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_URL="postgresql://${PG_USER}:postgres@localhost:${PG_PORT}/${DB_NAME}"

cd "$REPO_DIR"

echo "==> Ensuring Docker is running"
if ! docker info >/dev/null 2>&1; then
  echo "    Docker daemon is not up; launching Docker Desktop..."
  open -a Docker
  for _ in $(seq 1 60); do
    docker info >/dev/null 2>&1 && break
    sleep 2
  done
  docker info >/dev/null 2>&1 || {
    echo "    ERROR: Docker did not become ready. Cannot provision the test DB." >&2
    exit 1
  }
fi

# A Postgres may already be serving POSTGRES_PORT from another container (on
# this machine `travio-postgres` publishes 5433 and holds the live dev database).
# Compose's `travio-dev-postgres` cannot bind that port, so forcing
# `docker compose up` would fail — and recreating containers to win the port
# risks the existing data. Whichever server owns the port is fine: this script
# only ever creates and migrates `travio_test`, never `travio`.
pg_already_up() {
  if command -v nc >/dev/null 2>&1; then
    nc -z -G 1 localhost "$PG_PORT" >/dev/null 2>&1
  else
    (echo >/dev/tcp/localhost/"$PG_PORT") >/dev/null 2>&1
  fi
}

if pg_already_up; then
  echo "==> Postgres already listening on :${PG_PORT} — using it (leaving it alone)"
else
  echo "==> Starting postgres via docker compose"
  docker compose up -d postgres

  echo "==> Waiting for postgres on :${PG_PORT}"
  for _ in $(seq 1 45); do
    pg_already_up && break
    sleep 2
  done
  pg_already_up || {
    echo "    ERROR: postgres never became ready on :${PG_PORT}." >&2
    exit 1
  }
fi

# Find the container that actually publishes PG_PORT. Hardcoding compose's name
# would target a container that isn't running (and can't run while another owns
# the port), so `createdb` would silently fail against the wrong server.
PG_CONTAINER="$(docker ps --filter "publish=${PG_PORT}" --format '{{.Names}}' 2>/dev/null | head -1 || true)"

# Prisma can execute SQL over TCP, which is what we need when Postgres is not
# running in Docker on this machine at all.
run_sql() {
  local db="$1" sql="$2"
  if [ -n "$PG_CONTAINER" ]; then
    # `-d` and the name must be separate argv words: `psql "-d travio_test"`
    # makes getopt read the value as " travio_test" (leading space) and fail
    # with a confusing "database does not exist".
    printf '%s' "$sql" | docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -q -v ON_ERROR_STOP=1 -d "$db" >/dev/null
  else
    printf '%s' "$sql" | npx prisma db execute --url "$TEST_URL" >/dev/null
  fi
}

if [ -n "$PG_CONTAINER" ]; then
  echo "==> Postgres container: ${PG_CONTAINER}"
else
  echo "==> No Docker container publishes :${PG_PORT} (host Postgres?); using prisma db execute"
fi

echo "==> Creating ${DB_NAME} if missing"
if [ -n "$PG_CONTAINER" ]; then
  if [ "$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -tAc \
      "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'")" != "1" ]; then
    docker exec "$PG_CONTAINER" createdb -U "$PG_USER" "$DB_NAME"
    echo "    created."
  else
    echo "    already exists."
  fi
else
  # CREATE DATABASE cannot go through the target database's own connection.
  printf "SELECT 'ok' FROM pg_database WHERE datname='%s'" "$DB_NAME" \
    | npx prisma db execute --url "postgresql://${PG_USER}:postgres@localhost:${PG_PORT}/postgres" >/dev/null 2>&1 || true
  npx prisma db execute --url "postgresql://${PG_USER}:postgres@localhost:${PG_PORT}/postgres" \
    --stdin <<<"CREATE DATABASE ${DB_NAME};" >/dev/null 2>&1 || echo "    (may already exist)"
fi

# The app queries geography columns, so the test database needs the same
# extensions the dev database has.
echo "==> Enabling PostGIS extensions"
run_sql "$DB_NAME" "CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS pg_trgm;"

echo "==> Applying migrations"
DATABASE_URL="$TEST_URL" DIRECT_URL="$TEST_URL" npx prisma migrate deploy

echo "==> Seeding RBAC + dev users"
DATABASE_URL="$TEST_URL" DIRECT_URL="$TEST_URL" node prisma/seed.js

echo
echo "Test database ready: ${TEST_URL}"
echo
echo "Run the DB-gated suites against it:"
echo "  TEST_DATABASE_URL=\"$TEST_URL\" npm run test:api"
echo "  TEST_DATABASE_URL=\"$TEST_URL\" TEST_DB_EXPECTED=1 npm test"
echo
echo "Without TEST_DATABASE_URL, jest.globalSetup.js will refuse to run the"
echo "DB-gated suites (they would fall through to the dev \`travio\` database)."
