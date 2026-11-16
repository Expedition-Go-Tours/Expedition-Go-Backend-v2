# Engineering report: two-app split

**Branch:** `feat/two-app-split` (merged to `main` as `d92644f`)
**Date:** 2026-11-16
**Status:** merged (`d92644f`) and fully cut over to containers on 2026-11-16.
The Platform API and Stays API run as independent containers behind host Nginx;
PM2 is retired from the runtime and retained only as a rollback path. This
release applied no database migration.

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

The first dispatch of the new pipeline exposed a second configuration gap: the
deploy jobs referenced `DEPLOY_*` secrets that do not exist. They now use the
repository's existing `HETZNER_HOST` and `HETZNER_SSH_KEY`, run as `root`, and
accept an optional pinned `DEPLOY_HOST_KEY` with an `ssh-keyscan` fallback.
The variable and secrets required are listed in `docs/deployment/ci-cd.md`.
The PM2 deploy in `ci.yml` is now gated behind `PM2_DEPLOY_ENABLED` (unset as of
the cutover), so the two mechanisms cannot run together. Setting
`DOCKER_DEPLOY_ENABLED=true` enables the container pipeline; setting
`PM2_DEPLOY_ENABLED=true` is the deliberate rollback path.

---

## 8. Production state after the cutover

Both applications run as containers as of 2026-11-16. Verified from the host and
from outside:

| Item | Observed |
| --- | --- |
| Platform container | `travio-platform-api`, healthy, `sha-d92644f`, non-root, 768 MB limit, ~257 MB RSS |
| Stays container | `travio-stays-api`, healthy, `sha-d92644f`, non-root, 384 MB limit, ~114 MB RSS |
| Platform `/health` | 200, `service: platform-api`, DB and Redis healthy, 12/12 workers, 33/32 schedules, commit `d92644f` |
| Stays `/health` | 200, `service: stays-api`, DB and Redis healthy |
| Ports | `127.0.0.1:5000` and `127.0.0.1:5100`, both owned by the container processes; public 5100 refused |
| Nginx | Stays prefixes → 5100, everything else → 5000, on all three vhosts |
| WebSocket | **101** through Nginx on every vhost |
| PM2 | app removed from the daemon and the resurrect dump; `pm2-deploy.service` disabled; Docker enabled at boot. The docs merge re-ran the old deploy once; see the incident below |
| Deploy state | `/var/lib/travio/deploy-state.env` records both images |
| Database migration | none |
| Cutover interruption | ~4–5 seconds of connection-refused/502 at 11:56:16–18, bounded by the readiness gate |

The PM2 rollback path is retained: stop the Platform container, then
`systemctl enable --now pm2-deploy` and
`pm2 start ecosystem.config.js --only expedition-api`. The Stays container and
the Nginx routing are independent of that step.

Backups taken before further changes: an 11 MB custom-format `pg_dump`
(`/var/backups/travio-20261116-1158.dump`, `0600`) and a configuration archive
covering Nginx, `/etc/travio`, `/opt/travio` and the deploy state.

### Deployment gate incident (2026-11-16)

The docs merge (`7dd9ef0`) landed before the CI gate existed, so its push ran the
old PM2 deploy. PM2 started `expedition-api` while the Platform container still
held 5000, and crash-looped. When the Platform image was then rolled to
`5d8a6b3`, the container released 5000 for a moment and PM2 won the race. The
deploy script curled `127.0.0.1:5000/ready`, received a 200 from the PM2 process,
and recorded a successful deploy of a container that had never bound the port.

Detected by inspecting the running image and container logs, not by the gate.
Fixed by stopping and deleting the PM2 app again, restarting the container, and
changing the deploy gate to require the container to be running the requested
image **and** its Docker healthcheck to be healthy before the application
`/ready` check. The release workflow also syncs the host checkout to the release
commit before running deploy scripts; previously a stale checkout meant a script
fix would not take effect on the next release.

The `8b3e127` release exposed one more race: the two deploy jobs fetched the
same checkout concurrently and the Stays job failed with `incorrect old value
provided`. The sync is now serialized with `flock`. The Stays container was
redeployed manually to `8b3e127`, then the Platform image and PM2 fallback
drills were run.

Current state after the 16 November releases:

- `DOCKER_DEPLOY_ENABLED` is enabled; main pushes build and deploy the affected
  images.
- Public ingress is checked automatically (`verify-public`) and by
  `verify-public-ingress.sh`.
- Deploys are digest-pinned.
- The Platform image rollback and the Platform-to-PM2 fallback were drilled.
- Currency reporting and the settlement policy are still unchanged.
- No staging environment.

---

## 9. Remaining work, in order

1. **Merge the checkout-sync race fix.** Concurrent `git fetch` in the two
   deploy jobs failed on `8b3e127`; the sync is now serialized with `flock`.
2. **Click through the supplier dashboard** on the Stays process: property
   list, calendar, a test reservation (then cancel), finance.
3. **Decide and configure the currency policy**; implement grouped reporting
   and the currency-aware refund threshold map as a separate change.
4. **Add a staging environment.** The readiness gate and the DB-backed suite are
   still the only pre-production signals.
5. **Relational inventory** as a separate project with a backfill dry run.

## 10. Known limitations

- No staging; no blue/green. Recreate-with-readiness-gate means a brief,
  bounded interruption on Platform replacement. The runbook says so.
- Migrations are forward-only; every change must be additive first.
- `sha-<commit>` tags are mutable on GHCR; use digests for exact provenance.
- The deploy scripts have run against the real host (`deploy-stays.sh`,
  `deploy-platform.sh`, `verify-deployment.sh`). The Stays image rollback was
  drilled with a real container recreate, the Nginx routing rollback was drilled
  live with no downtime, and the Platform image + PM2 fallback were drilled on
  2026-11-16. See `docs/deployment/rollback-drills.md`.
- Images are `linux/amd64` only, matching the VPS.
- No image signing (`cosign`) yet; provenance and SBOM are published.
- The Stays/Platform import boundary is enforced by tests, not by an ESLint
  rule. Revisit if the Stays surface grows past ~20 files.
- `tourController.test.js` remains a pre-existing intermittent flake.
