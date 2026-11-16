# Engineering report: two-app split

**Branch:** `feat/two-app-split` (merged to `main` as `d92644f`)
**Date:** 2026-11-16
**Status:** merged and deployed through the existing PM2 pipeline, then verified
healthy. The container/host cutover has **not** started: Docker is not installed,
Nginx and PM2 configuration are unchanged, and this release applied no database
migration.

This report separates three things that are easy to conflate:

1. what changed **in the repository** (implemented, testable, committed);
2. what was **built and run on this machine and in CI** (images, containers, smoke tests);
3. what has actually changed **on the production server**, and what remains a
   plan requiring approval.

---

## 1. What was asked, and what was delivered

| Requirement | State |
| --- | --- |
| Two independently deployable applications | Done: `apps/platform-api`, `apps/stays-api` |
| Root `app.js` / `server.js` stay compatible | Done: thin re-exports; PM2 config untouched |
| Canonical `/api/v1` + legacy `/api` aliases | Done: same routers mounted twice |
| Path-specific middleware audited for both prefixes | Done: `docs/architecture/api-versioning.md` + tests |
| Shared capabilities reused, not duplicated | Done: `apps/shared`, shared limiters, one Prisma client |
| Stays runs without Platform | Proven by tests and by a standalone container |
| Immutable images, no `latest`, non-root | Done: two Docker targets, SHA tags, `USER node` |
| Host networking in production, bridge locally | Done: `deploy/compose.production.yml`, `deploy/compose.local.yml` |
| CI/CD with independent deploys | Done: `.github/workflows/docker-release.yml`, gated off |
| Inventory race + override fix, separate change | Done in one controller; documented separately |
| GHS/USD inconsistency documented | Done: `docs/architecture/financial-currency.md` |
| 9 architecture/deployment docs | Done, plus this report |
| Preserve legacy compose/Caddy files | Kept, marked legacy with header comments |
| No container/host change | Held. A PM2 release deployed the code; Docker, Nginx and containers are untouched. See §8. |

---

## 2. Test evidence

### Baseline vs current

| Metric | Baseline (`main`) | Current branch |
| --- | ---: | ---: |
| Test suites | 258 | **262** |
| Tests | 4,974 | **5,029** |
| Failures | 0 | **0** |
| ESLint errors | 0 | **0** (101 pre-existing warnings, all outside changed files) |

Full run:

```
TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5433/travio_test" \
TEST_DB_EXPECTED=1 npm test

Test Suites: 262 passed, 262 total
Tests:       5029 passed, 5029 total
```

`TEST_DB_EXPECTED=1` makes the database-backed tests fail rather than skip when
the test database is missing — a silently skipped concurrency test would be
worse than no test.

CI agreed with the local run. On PR #178 all 14 checks passed (`deploy` and
`deploy-verify` skipped as PR-gated, Supabase preview skipped). On `main` after
the merge, every job passed, including `deploy` and `deploy-verify`. The new
`stays-startup` job boots the Stays entry point in production mode with no
Platform process and no Redis, and passes.

### New and extended suites

| File | Tests | Proves |
| --- | ---: | --- |
| `__tests__/api/staysInventory.test.js` | 8 | 5 concurrent bookings → exactly one 201; per-date count/price/minStay/closed enforced; prefix parity; no Tours routes; auth required |
| `__tests__/api/apiVersioning.test.js` | 11 | `/api` and `/api/v1` return identical bodies; version header; 404 parity; webhook raw-body parity; maintenance parity + admin exemption; one shared global budget; one shared upload budget |
| `__tests__/unit/staysBootstrap.test.js` | 7 | Stays starts no workers/schedules, does not load the Platform app or `socket.io`, mounts exactly two routers, 401 for Stays / 404 for Tours, reports `service: 'stays-api'` |
| `__tests__/unit/ciDependencyMap.test.js` | 25 | Path → image mapping, unknown paths build both, docs build nothing, migrations flagged, CLI and `--all` |
| `__tests__/unit/staysOperations.test.js` | 11 (was 7) | Per-date price totals, zero-inventory night rejected, minStay, closed night, booking number still allocated |

The concurrency test is the one that matters most: it fails against the
pre-fix controller (five 201s) and passes now (one 201, four 400s).

Known flake, unchanged from baseline: `tourController.test.js` occasionally
fails a full parallel run with a Jest teardown error and passes standalone.

---

## 3. The inventory fix

Two defects in `staysBookingsController.createBooking`:

1. **Read-then-write race.** The overlap count and the insert ran on different
   connections. Two simultaneous requests both saw zero occupancy.
2. **Ignored overrides.** `StayAvailabilityOverride.count`, `.price` and
   `.minStay` were fetched and discarded; only `.closed` was honoured. A
   supplier could cut a date to one room, price it differently, or set a minimum
   stay, and the endpoint sold the base inventory at the base price anyway.

Fix: a transaction-scoped advisory lock per `(propertyId, roomId)`, `ReadCommitted`
isolation, a retry wrapper for serialization failures/deadlocks, per-night
validation that honours every override field, and booking-number allocation
moved outside the transaction so one counter row does not serialise all bookings.

### The Jest discovery

The lock was first taken with the tagged `tx.$queryRaw`. The database test
still produced **three** successful bookings out of five.

Cause: `jest.setup.js` rewrites tagged raw queries onto the **root** Prisma
client (a workaround for a Prisma-under-Jest quirk). The lock therefore executed
in autocommit, outside the interactive transaction, where an `_xact_` lock is
released the moment the statement returns. Production was correct; the test was
measuring nothing.

The lock now uses `tx.$queryRawUnsafe(sql, ns, key)` with positional parameters.
It is not rewritten, stays bound to `tx`, and interpolates nothing. This is
exactly the class of bug that makes a green suite dangerous, so it is recorded
in `docs/architecture/stays-inventory.md` rather than buried in a commit.

The relational redesign (joinable `StayRoom` / `StayRatePlan` /
`StayInventoryDay`, `EXCLUDE` constraints) is documented as a proposal and
deliberately **not implemented** — it needs a backfill dry run and a frontend
coordination, not just a migration file.

---

## 4. Architecture

- **Composition-root split, not a code migration.** Stays is 9 files
  (~3,082 lines) mounted once at `supplierRoutes.js:94`. Both apps import the
  same routers, middleware and Prisma client.
- **Dual prefix by mounting the same router twice.** No forked controllers.
  Route-scoped middleware is mounted per prefix; prefix-wide middleware
  (global limiter, maintenance) stays on `/api` and normalises the `v1` segment,
  so no request is charged twice and `/api/v1` cannot bypass a guard.
- **SSO limiter fixed in passing.** It used to be created inside
  `mountPrefixRoutes`, giving each prefix its own counter and therefore double
  the intended budget. It now lives in `createLimiters()` and is shared.
- **Stays security is the real chain.** `protect` → `resolveSupplier` →
  `requireTeamPermission('stays.*')`. The Stays app never reads `X-User-Id` or
  `X-Supplier-Id`.
- **No invented Stays endpoints.** Only the existing supplier-side routes moved.

Details: `docs/architecture/two-app-split.md`,
`docs/architecture/module-ownership.md`, `docs/architecture/api-versioning.md`.

---

## 5. Images, local smoke tests

Built locally with Docker 29.8.0:

| Target | Size | User | Healthcheck |
| --- | --- | --- | --- |
| `travio-platform-api:local` | 1.67 GB | `node` (uid 1000) | `:5000/health` |
| `travio-stays-api:local` | 1.67 GB | `node` (uid 1000) | `:5100/health` |

Both built from the same multi-stage `Dockerfile`; the difference is the CMD.
No `.env`, tests, docs or `db push` inside either image.

Smoke results (containers against the test PostGIS database, Redis absent):

| Check | Platform | Stays |
| --- | --- | --- |
| `/health` | 200, `service: platform-api` | 200, `service: stays-api` |
| `/ready` | **503** (Redis down) | **200** (Redis optional) |
| `/api/v1/tours` | 200 | **404** |
| `/api/travioghana/supplier/stays/properties` | 401 | 401 |

`deploy/scripts/verify-deployment.sh` passed every assertion except Platform
`/ready`, which is the expected consequence of running without Redis. That is
useful evidence rather than a failure: Platform readiness requires Redis, Stays
does not, and the script reports the difference instead of hiding it.

`docker run --entrypoint id` returns `uid=1000(node)` for both images.

### Static validation of the deployment artifacts

These run without a Docker host or a VPS:

| Check | Result |
| --- | --- |
| `docker compose -f deploy/compose.production.yml config` (with image/env overrides) | exit 0; `network_mode: host` on both, `HOST: 127.0.0.1`, memory ceilings applied |
| `nginx -t` with `api-routing.conf` included in a test `server` block | syntax ok |
| `shellcheck -x deploy/scripts/*.sh` | clean |
| `actionlint .github/workflows/docker-release.yml` | clean (one SC2016 false positive fixed in the notify step) |
| `actionlint .github/workflows/deploy-validation.yml` | clean |
| `npm audit --omit=dev` | 5 low; no high or critical |

The same checks are now permanent: `.github/workflows/deploy-validation.yml`
runs `bash -n`, shellcheck, Compose rendering (including a missing-image failure
case), the Nginx fragment under `nginx -t`, and the `validate_image_ref`
negative cases whenever a deployment input changes. Every step was executed
locally before the workflow was committed.

The production Compose file now sets `NODE_ENV=production` and `TZ: UTC`
explicitly. Relying on the env file for `NODE_ENV` meant one missing line would
silently run the container in development mode — stack traces in responses and
Swagger mounted. The PM2 config always set it, so this closes a gap introduced
by moving the runtime declaration.

The audit findings are the known `deepmerge` advisory (reached through
`@sendgrid/mail`, no patched release without a breaking downgrade) and
`fast-xml-parser`. Neither is high or critical. They are not upgraded in this
branch because a dependency change immediately before a cutover is a worse risk
than a low-severity advisory; they are a separate PR.

---

## 6. Financial currency finding (GHS/USD)

Not fixed in this branch — documented with evidence and options in
`docs/architecture/financial-currency.md`. Summary:

- Defaults disagree inside one product: Stays property/booking/calendar default
  to **GHS**; Tours and admin revenue default to **USD**; Stays finance rows
  default to **USD**; payout methods default to GHS for bank/mobile money and
  USD for PayPal.
- **Analytics and finance summaries add amounts across currencies.** A supplier
  with one GHS and one USD booking gets a meaningless "total earnings", labelled
  with whichever currency the first booking happened to have.
- The payout **request** path is stricter than the summary: it refuses mixed
  currencies. So the dashboard shows a combined balance and the request then
  fails.
- The refund two-person-approval threshold can be **silently disabled** for a
  currency missing from the configured map (`releaseThreshold` returns `0`,
  which the caller treats as "no control").

Proposed: explicit currency at creation, `groupBy: ['currency']` reporting,
fail-closed thresholds, and one settlement-currency rule per supplier. No schema
change required for the first three.

---

## 7. Release pipeline

`.github/workflows/docker-release.yml` is **additive**. `ci.yml` — including its
existing PM2 deploy — is untouched and remains live.

```
changes ─▶ build (platform, stays) ─▶ migrate ─▶ deploy-platform ─┐
                                             └─▶ deploy-stays ────┴─▶ notify
```

Gating, in order:

1. `build` runs only if the change filter selects at least one app.
2. `migrate` requires `build.result == 'success'`, a migration-flagged change,
   **and** `vars.DOCKER_DEPLOY_ENABLED == 'true'`.
3. `deploy-*` require `build.result == 'success'`, `migrate` not failed, the app
   selected, and the same variable.
4. `notify` is `always()` so a failed release is reported rather than silent.

With the variable unset — the state it ships in — the workflow only publishes
images. `ci/dependency-map.json` routes shared paths to **both** images and
unrecognised paths to both as well; only docs and tests build nothing.

The first `main` run (`d92644f`) built and pushed both images and skipped both
deploy jobs, exactly as intended. Those are the first immutable images available
for the container cutover.

The variable and secrets required are listed in `docs/deployment/ci-cd.md`.
**Enabling it while the PM2 deploy in `ci.yml` still runs would put two deploy
mechanisms on one host.** That ordering is a precondition, not a suggestion.

---

## 8. Production state

The merge to `main` (`d92644f`, PR #178) triggered the existing `ci.yml` PM2
deploy. Verified read-only immediately afterwards:

| Item | Observed |
| --- | --- |
| Checkout | `d92644f` |
| PM2 | `expedition-api` online, cluster mode, restarted by the deploy, ~317 MB RSS |
| `/health` | 200, `service: platform-api`, database and Redis healthy, 12/12 workers running, no missing or stale schedules |
| `/api/v1/tours` and `/api/tours` | 200 |
| Stays route, both prefixes | 401 (mounted and guarded) |
| Port 5000 | `127.0.0.1:5000`; the loopback bind took effect and PM2's God daemon owns the socket |
| Docker | not installed |
| Nginx, PM2 config, firewall, DNS | unchanged |
| Database migration | none in this release |

`docker-release.yml` also ran on the same push: both images built and were
pushed, and both deploy jobs were skipped because `DOCKER_DEPLOY_ENABLED` is not
set. No container was started.

Not done, and still approval-gated:

- Docker install and the `/etc/travio/*.env` files
- GHCR login on the host and an image pull
- the Nginx routing fragment
- a Stays container, and the Platform container cutover
- any firewall or DNS change

The PM2 rollback path remains available: revert the merge commit and let
`ci.yml` deploy again. No container state is involved.

---

## 9. Remaining work, in order

1. **Container cutover, phases 1-3.** The code half is live. The runbook is
   `docs/deployment/hetzner-cutover.md`; every phase is approval-gated and Stays
   is introduced before the Platform container replaces PM2.
2. **Disable the PM2 deploy in `ci.yml`** before setting
   `DOCKER_DEPLOY_ENABLED=true`.
3. **Create the deploy secrets and `/etc/travio/*.env`** on the host, with a
   read-only GHCR token. The JWT and database values must match across both
   files.
4. **Test a rollback deliberately** (`rollback-stays.sh`, then deploy forward)
   before relying on it.
5. **Decide the currency question** in `financial-currency.md`; implement
   grouped reporting and a fail-closed refund threshold as a separate change.
6. **Add a staging environment.** The single biggest remaining gap: the
   readiness gate and the DB-backed suite are currently the only pre-production
   signals beyond this PM2 release.
7. **Relational inventory** as a separate project with a backfill dry run.

## 10. Known limitations

- No staging; no blue/green. Recreate-with-readiness-gate means a brief,
  bounded interruption on Platform replacement. The runbook says so.
- Migrations are forward-only; every change must be additive first.
- `sha-<commit>` tags are mutable on GHCR; use digests for exact provenance.
- Deploy scripts are syntax-checked and reviewed, not executed against a real
  Docker host — the workflow cannot prove them until the cutover runs.
- Images are `linux/amd64` only, matching the VPS.
- No image signing (`cosign`) yet; provenance and SBOM are published.
- The Stays/Platform import boundary is enforced by tests, not by an ESLint
  rule. Revisit if the Stays surface grows past ~20 files.
- `tourController.test.js` remains a pre-existing intermittent flake.
