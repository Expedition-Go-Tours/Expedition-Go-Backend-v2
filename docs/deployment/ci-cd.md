# CI/CD for the two applications

## What already exists, and what is new

| Workflow | State | Purpose |
| --- | --- | --- |
| `.github/workflows/ci.yml` | **unchanged** | Lint, full regression suite (258 suites / 4,974 tests baseline), existing PM2 deploy on `main` |
| `.github/workflows/docker-release.yml` | **new** | Build affected image(s), publish to GHCR, optionally deploy through the scripts |
| `.github/workflows/deploy-validation.yml` | **new** | Validate Compose rendering, the Nginx fragment, shell scripts and the image-reference guard on deployment changes |

Nothing in `ci.yml` was removed or reordered. The PM2 deploy it performs is still
the live mechanism, because the VPS still runs PM2. `docker-release.yml` is
additive and gated off by default.

Run both concurrently and you have two deploy mechanisms. The gate exists to
make that impossible by accident.

`deploy-validation.yml` exists because the main test suite never parses a Compose
file, never asks Nginx to read the routing fragment, and never runs a deploy
script. Those failures would otherwise surface mid-cutover. It is path-filtered
to deployment inputs and also asserts the two negative cases that matter: a
missing `*_IMAGE` variable must fail Compose rendering, and `validate_image_ref`
must reject `:latest` and a foreign repository.


## The change filter

`ci/dependency-map.json` + `ci/detect-changes.js` decide which image(s) a commit
affects. The default is paranoid: a path that matches no rule builds **both**.

| Change | platform | stays |
| --- | --- | --- |
| `src/brands/ghana/staysRoutes.js` | no | yes |
| `apps/stays-api/server.js` | no | yes |
| `routes/tourRoutes.js` | yes | no |
| `apps/platform-api/app.js` | yes | no |
| `src/core/services/prismaClient.js` | yes | yes |
| `middleware/authMiddleware.js` | yes | yes |
| `prisma/schema.prisma` | yes | yes (+ migration) |
| `prisma/migrations/**` | yes | yes (+ migration) |
| `package.json`, `Dockerfile` | yes | yes |
| `deploy/**` | yes | yes |
| `docs/**`, `*.md`, `__tests__/**` | no | no |
| unknown path | yes | yes |

The filter runs in the `changes` job and writes `platform`, `stays` and
`migrations` as step outputs.

### Why documentation changes build nothing

Rebuilding an image whose bytes did not change produces a new digest, which makes
"what is running?" harder to answer for no benefit. Docs and tests are excluded
from the image by `.dockerignore` anyway.

### Why shared changes build both

`middleware/`, `config/`, `src/core/services/` and `prisma/` are loaded by both
processes. Rebuilding only one would deploy two containers built from different
source trees — the exact drift the split is meant to prevent.

### Tests

`__tests__/unit/ciDependencyMap.test.js` pins:

- Stays-only files select only Stays;
- shared files select both;
- docs and tests select neither;
- unknown paths select both **and** are reported;
- migrations are flagged without rebuilding unrelated things;
- the CLI writes `GITHUB_OUTPUT` correctly.

The map is data, not code, so the tests also assert every pattern compiles and
every rule names a known application.

## The release pipeline

```
changes ──▶ build (matrix: platform, stays) ──▶ migrate ──▶ deploy-platform
                                                    └────▶ deploy-stays
                                                        │
notify ◀────────────────────────────────────────────────┘
```

### `build`

- Matrix over `platform` / `stays`.
- Each leg checks its own `changed` flag; an unaffected leg skips its steps and
  finishes green in seconds.
- Uses Buildx with GitHub Actions cache (`scope=platform` / `scope=stays`, so the
  two images do not evict each other).
- Pushes `sha-<short>`, `sha-<full>`, and semver tags on a `v*.*.*` tag.
- **Never pushes `latest`.** `flavor: latest=false` is explicit.
- Publishes provenance and an SBOM.
- Records the image digest in the workflow summary.

### `migrate`

- Runs only when `migrations == true` **and** deployment is enabled.
- Job-level `concurrency: production-database` serialises migration runs across
  the repository. A second release waits instead of racing
  `prisma migrate deploy`.
- SSHes to the VPS and runs `deploy/scripts/deploy-migrations.sh <platform
  image>`. The script also takes a file lock and refuses `db push`.
- Runs **before** either container is replaced. If it fails, no deploy job runs.

### Host checkout sync and readiness

Before running any deploy script, the workflow SSHes to the host and resets the
checkout to the release commit (as the `deploy` user when the SSH user is root).
Without this, a fix to the scripts themselves would never reach the host: the
first container deploy ran from whatever commit happened to be checked out.

The deploy scripts then verify the container, not just the port:

1. the container is running the requested image (`Config.Image`), and
2. its Docker healthcheck is `healthy`,

and only then call `/ready`. This ordering exists because a stale PM2 process
can hold `127.0.0.1:5000` while a new container crash-loops; a port-only check
will accept the stale process's 200 and record a deploy that never ran. A
regression test in `deploy-validation.yml` covers the unhealthy/wrong-image
cases.

### `deploy-platform` / `deploy-stays`

- Independent jobs, separate concurrency groups.
- Each calls only its own script with only its own image:
  - `deploy-platform.sh ghcr.io/expedition-go-tours/platform-api:sha-…`
  - `deploy-stays.sh ghcr.io/expedition-go-tours/stays-api:sha-…`
- Each script uses `docker compose up -d --no-deps <service>`, so the other
  container is not pulled, recreated or restarted.
- Each gates on `/ready` returning 200 and auto-rolls back to the previously
  recorded image on failure.
- After either deploy, `verify-deployment.sh` re-checks both services from the
  host (probes, canonical and legacy routes, and Stays/Tours isolation).

### `notify`

- `if: always()`.
- Posts app(s), commit, ref, build/migration/deploy status, and the rollback
  procedure to `DISCORD_RELEASE_WEBHOOK` when configured; otherwise logs and
  exits 0.

## Required configuration

### Secrets

| Secret | Used by | Notes |
| --- | --- | --- |
| `DEPLOY_SSH_KEY` | migrate, deploy, verify | Private key for the deploy user |
| `DEPLOY_HOST_KEY` | migrate, deploy, verify | Pinned `known_hosts` line; avoids TOFU |
| `DEPLOY_USER` | migrate, deploy, verify | e.g. `deploy` |
| `DEPLOY_HOST` | migrate, deploy, verify | VPS address |
| `DISCORD_RELEASE_WEBHOOK` | notify | Optional |
| `GITHUB_TOKEN` | build | Automatic; needs `packages: write` (set in workflow permissions) |

### Repository variable

| Variable | Default | Effect |
| --- | --- | --- |
| `DOCKER_DEPLOY_ENABLED` | unset (`false`) | When exactly `"true"`, the container deploy jobs run. Otherwise images are published only. |
| `PM2_DEPLOY_ENABLED` | unset (`false`) | When exactly `"true"`, the legacy PM2 deploy and verify jobs run. Leave unset while containers are the runtime; set it only for a deliberate rollback. |

Current state after the 2026-11-16 cutover: `PM2_DEPLOY_ENABLED` is unset, so
`ci.yml` no longer touches the host. `DOCKER_DEPLOY_ENABLED` is also unset, so
images are published but not deployed. Enabling the container pipeline is the
next step; the two variables must never both be true.

## Enabling the new pipeline

Do these in order:

Done in the 2026-11-16 cutover:

1. ~~Disable the PM2 deploy~~ — gated behind `PM2_DEPLOY_ENABLED` in `ci.yml`.
2. ~~Create the env files and log in to GHCR~~ — both exist on the host.
3. ~~Run the cutover phases~~ — both containers are healthy and Nginx is split.

Still to do:

4. Set `DOCKER_DEPLOY_ENABLED=true` (leave `PM2_DEPLOY_ENABLED` unset).
5. Push a change that affects only Stays and confirm the Platform container's
   `StartedAt` does not change:

   ```bash
   docker inspect -f '{{.State.StartedAt}}' travio-platform-api
   ```

6. Run `rollback-stays.sh` once deliberately, verify it restores the previous
   image, then deploy forward again. An untested rollback is not a rollback.

## Rollback

| Scope | Command | What it does |
| --- | --- | --- |
| Stays image | `deploy/scripts/rollback-stays.sh` | Replaces only `stays-api` with the recorded previous image, re-runs the readiness gate |
| Platform image | `deploy/scripts/rollback-platform.sh` | Same for `platform-api` |
| Nginx routing | remove the `include`, `nginx -t`, `systemctl reload nginx` | Returns Stays traffic to port 5000 without an app deploy |
| Whole cutover | restart PM2, remove the Nginx include | Restores the pre-split production topology |
| Migration | none automatic | `prisma migrate deploy` has no down migration; roll back the image, keep the additive schema |

The state file (`/var/lib/travio/deploy-state.env`) stores one
`*_IMAGE_CURRENT` and one `*_IMAGE_PREVIOUS` per app. A rollback swaps them, so
rolling back twice returns to the failed image — by design, it reflects
alternation, not a history stack.

## Honest limitations

- **No staging environment.** The readiness gate and the database-backed test
  suite are the only pre-production signals. A staging host would be the single
  most valuable addition.
- **Recreate, not blue/green.** The VPS has 2 vCPU and ~2.3 GB free; two Platform
  instances would not fit alongside Postgres, Redis and the OS. A replace
  produces a brief interruption bounded by startup time. `wait_ready` makes the
  interruption visible and bounded, but it is still an interruption.
- **Migrations are forward-only.** Prisma has no down migrations. Every schema
  change must be additive first, destructive later, in separate releases.
- **Tag mutability.** `sha-<commit>` can be overwritten. Use digests where the
  exact bytes matter.
- **The workflow cannot prove the deploy scripts work** until they have run
  against a real Docker host. They are syntax-checked (`bash -n`) and reviewed,
  not executed here.
