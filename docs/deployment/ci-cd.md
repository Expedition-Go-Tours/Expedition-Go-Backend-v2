# CI/CD for the two applications

## What already exists, and what is new

| Workflow | State | Purpose |
| --- | --- | --- |
| `.github/workflows/ci.yml` | **test suite** | Lint, full regression suite, and the `test-summary` artifact (counts + changed files). Its legacy PM2 deploy is gated off behind `PM2_DEPLOY_ENABLED`. |
| `.github/workflows/docker-release.yml` | **live deploy** | Triggered by a successful CI run on `main`; builds affected images, deploys them, verifies ingress, notifies Discord |
| `.github/workflows/deploy-validation.yml` | validation | Validate Compose rendering, the Nginx fragment, shell scripts and the image-reference guard on deployment changes |

A main-branch deploy is **gated on CI**. `docker-release.yml` no longer triggers
on a raw push: it runs on `workflow_run` after the CI workflow completes and
only when the conclusion is `success`. Tag pushes and manual dispatches still
publish images; `DOCKER_DEPLOY_ENABLED` gates the deploy jobs. PM2 is kept only
as a rollback path.

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

## The CI gate

`docker-release.yml` listens for the **CI** workflow's `completed` event on
`main`. `changes` refuses to run unless the conclusion is `success`, so a red
test suite cannot ship.

- `RELEASE_SHA` is `workflow_run.head_sha`, not `GITHUB_SHA` — the branch head at
  trigger time can be newer than the commit CI tested. Checkouts, image tags,
  migrations and deploys all use `RELEASE_SHA`.
- CI uploads `test-summary.json` and `changed-files.txt`. `changes` downloads
  them and feeds the file list to `ci/detect-changes.js`; `notify` uses the
  counts. The artifact is the authoritative record of what was tested.
- Tag pushes and `workflow_dispatch` skip the gate; they publish images, and
  deploy only when `DOCKER_DEPLOY_ENABLED=true`.
- Runs are serialised by `docker-release-<sha>` so a re-run cannot race itself.

## The release pipeline

```
changes ──▶ build (matrix: platform, stays) ──▶ migrate ──▶ deploy-platform ─┐
                                                    └────▶ deploy-stays ─────┴─▶ verify-public ─▶ notify
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
- Resolves the pushed platform tag to its manifest digest and runs
  `deploy/scripts/deploy-migrations.sh <repo>@sha256:<digest>`. The script also
  takes a file lock and refuses `db push`.
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

### Digest pinning

The build publishes `sha-<short>` tags, but the deploy and migrate jobs log in to
GHCR and resolve the tag to its manifest digest immediately before use:

```bash
docker buildx imagetools inspect "$tag" --format '{{json .Manifest.Digest}}'
```

The scripts receive `repo@sha256:...`, and `deploy-state.env` records that exact
reference. Tags are mutable; the running container is identified by a digest.
The build log and the job summary already record the same digest.

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

### `verify-public`

Runs on the GitHub runner after both deploy jobs when at least one succeeded.
It executes `deploy/scripts/verify-public-ingress.sh` against every configured
vhost and fails the release if any of these is wrong:

- `/api/v1/tours` and `/api/tours` → 200, `X-Served-By: platform-api`
- both Stays prefixes → 401, `X-Served-By: stays-api`
- Socket.IO upgrade → 101

The `X-Served-By` header is set by each application, so the check proves which
upstream answered. A missing Nginx `include`, a DNS mistake or a lost websocket
header fails the release instead of waiting for a customer to find it.

### `announce`

- Runs after `changes`, only when `DOCKER_DEPLOY_ENABLED=true` and at least one
  application changed.
- Calls `scripts/release/notify.js` in `MODE=start`: blue **"Deploy started"**
  card with the commit subject/body, author, PR, trigger and run link.
- Posts to `DISCORD_RELEASE_WEBHOOK` (falls back to `DISCORD_DEPLOY_WEBHOOK`).
  Missing webhook or a Discord failure is a `::warning::`, never a failed job.

### `notify`

- `if: always()` **and** at least one application changed, so workflow-only
  pushes do not post a false failure.
- Calls `scripts/release/notify.js` in `MODE=final`, which renders:
  - a stage table with durations from the run's jobs API;
  - test counts from the CI artifact, with the CI run link;
  - health/latency for every public vhost;
  - commit subject/body, author, PR, and URL buttons for run, commit, PR, CI run
    and the rollback runbook.
- The card is red if the build, either deploy, or public ingress failed or was
  cancelled. Failure pings `@on-call` via `DISCORD_ONCALL_ROLE_ID` when set.
- Missing webhook or a Discord failure is a `::warning::`; it never fails the
  release.

## Required configuration

### Secrets

| Secret | Used by | Notes |
| --- | --- | --- |
| `HETZNER_SSH_KEY` | migrate, deploy, verify | Private key for `root@HETZNER_HOST`; the same key the PM2 pipeline uses |
| `HETZNER_HOST` | migrate, deploy, verify | VPS address |
| `DEPLOY_HOST_KEY` | migrate, deploy, verify | Optional pinned `known_hosts` line. When unset, the workflow falls back to `ssh-keyscan`; add it to remove the TOFU window |
| `DISCORD_RELEASE_WEBHOOK` | announce, notify | Optional. Release start/summary embeds; falls back to `DISCORD_DEPLOY_WEBHOOK` when unset |
| `GITHUB_TOKEN` | build, notify | Automatic; needs `packages: write`, `actions: read` (artifact + job timings) and `pull-requests: read` (PR link) |

The deploy commands run as `root`, matching the existing pipeline. A dedicated
deploy user with Docker access would be tighter, but Docker group membership is
root-equivalent; do not treat it as a privilege reduction without a separate
design.

### Repository variable

| Variable | Default | Effect |
| --- | --- | --- |
| `DOCKER_DEPLOY_ENABLED` | unset (`false`) | When exactly `"true"`, the container deploy jobs run. Otherwise images are published only. |
| `PM2_DEPLOY_ENABLED` | unset (`false`) | When exactly `"true"`, the legacy PM2 deploy and verify jobs run. Leave unset while containers are the runtime; set it only for a deliberate rollback. |
| `DISCORD_ONCALL_ROLE_ID` | unset | Optional Discord role ID pinged on a failed release. Success never pings. |

Current state after the 2026-11-16 cutover: `PM2_DEPLOY_ENABLED` is unset, so
`ci.yml` no longer touches the host. `DOCKER_DEPLOY_ENABLED` is `true`, so the
container deploy jobs run for every change that touches either application. The
two variables must never both be true.

## Enabling the new pipeline

Do these in order:

Done in the 2026-11-16 cutover:

1. ~~Disable the PM2 deploy~~ — gated behind `PM2_DEPLOY_ENABLED` in `ci.yml`.
2. ~~Create the env files and log in to GHCR~~ — both exist on the host.
3. ~~Run the cutover phases~~ — both containers are healthy and Nginx is split.

Still to do:

4. ~~Set `DOCKER_DEPLOY_ENABLED=true`~~ — live since the cutover.
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
