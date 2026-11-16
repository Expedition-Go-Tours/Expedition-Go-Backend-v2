# Container images

## One Dockerfile, two targets

`Dockerfile` is multi-stage with a shared dependency layer and two runtime
targets:

```
base            OS packages (openssl, ca-certificates, tini), WORKDIR /app
 └── deps       npm ci --omit=dev + prisma generate
      └── runtime   source, non-root user, no CMD
           ├── platform-api   CMD node apps/platform-api/server.js   :5000
           └── stays-api      CMD node apps/stays-api/server.js       :5100
```

Build one target at a time:

```bash
docker build --target platform-api -t platform-api:local .
docker build --target stays-api    -t stays-api:local    .
```

or both through Compose:

```bash
docker compose -f deploy/compose.local.yml build
```

### Why one file

The apps share `package.json`, `node_modules`, the Prisma schema and most of
`src/core`. A second Dockerfile would duplicate the dependency layer and drift.
The split is about **which entry point starts**, not about how the code is
installed.

`prisma` is a production dependency (not dev), so the migration image has the CLI
available. That is what lets `deploy-migrations.sh` run
`prisma migrate deploy` from the platform image without a separate tooling image.

## Image hardening

| Property | Implementation |
| --- | --- |
| Non-root | `USER node` (uid 1000, from the official image) |
| Writable `/app` not required | `/app` is owned by `node` for Prisma engine/cache needs, but the app writes no source files |
| PID 1 signal handling | `tini` entrypoint forwards `SIGTERM`, so `docker stop` runs the graceful shutdown path |
| Secrets not baked | `.dockerignore` excludes `.env`, `.env.*`, `.git`, tests and docs |
| Supply-chain metadata | OCI labels (`revision`, `version`, `source`), BuildKit provenance and SBOM enabled in CI |
| Health | Per-target `HEALTHCHECK` against `/health` |
| Capabilities | `security_opt: no-new-privileges:true` in Compose |
| No migrations at startup | No `prisma db push`, no `prisma migrate deploy` in `CMD` |

The app binds loopback by default (`HOST=127.0.0.1` in the image). Production
overrides are documented in `networking.md`.

## Tags and immutability

Published to:

```
ghcr.io/expedition-go-tours/platform-api
ghcr.io/expedition-go-tours/stays-api
```

Every build produces:

| Tag | Purpose |
| --- | --- |
| `sha-<short>` | Immutable, human-friendly; used by the deploy scripts |
| `sha-<full>` | Immutable, exact provenance |
| `vX.Y.Z` | Only for a `v*.*.*` git tag |
| `X.Y` | Only for a semver tag |

`latest` is never produced: `docker/metadata-action` is configured with
`flavor: latest=false`. The deploy scripts additionally refuse it:

```bash
validate_image_ref "$image" "$repo"   # rejects ':latest' and foreign repos
```

Tags are mutable on GHCR; digests are not. The build job records the digest in
the workflow summary, and the deploy scripts accept
`repo@sha256:…` as an alternative to a tag. For an audit trail use the digest.

## Running locally

`deploy/compose.local.yml` builds both targets on a **bridge** network and
publishes them on loopback only:

```bash
docker compose -f deploy/compose.local.yml up -d --build
curl -s http://127.0.0.1:5000/health
curl -s http://127.0.0.1:5100/health
```

The containers reach a host database through `host.docker.internal` (mapped via
`extra_hosts`). If your `.env` points at the dev Postgres on `localhost:5433`,
override `DATABASE_URL` for the containers as described in the Compose file's
header.

## Verifying an image

```bash
# Identity
docker image inspect platform-api:local --format '{{json .Config.Labels}}'

# Not root
docker run --rm --entrypoint id platform-api:local

# No schema mutation baked in
docker image inspect platform-api:local --format '{{json .Config.Cmd}}'

# Probes
docker run --rm --network host \
  -e DATABASE_URL=... -e JWT_SECRET=... -e JWT_REFRESH_SECRET=... \
  platform-api:local &
curl -s http://127.0.0.1:5000/health | jq
```

`/health` always returns 200 and reports dependency status. `/ready` returns 503
when Postgres is unreachable, for both apps. Stays treats Redis as optional:
`cacheHelper` falls back to an in-process cache, so a Redis outage degrades
performance without taking accommodation offline.

## What the images deliberately do not contain

- Tests, coverage, docs, `.github`, local scripts (`.dockerignore`)
- A `.env` file
- Migrations applied at boot
- Two applications in one container

## Known gaps

- **Single architecture.** Images are built for the runner's `linux/amd64`. The
  target VPS is amd64, so this is sufficient; add `platforms:` to the build step
  before deploying to an ARM host.
- **No image signing.** Provenance and SBOM are published, but there is no
  `cosign` signature. Add it before treating GHCR as a trust boundary for
  third-party consumers.
- **No automatic base-image refresh.** `node:22-slim` is pinned by tag, not
  digest. A Dependabot/Renovate rule for the base image is the next step.
