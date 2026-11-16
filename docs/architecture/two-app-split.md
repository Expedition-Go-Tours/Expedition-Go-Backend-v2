# Two applications, one repository

## Summary

The backend now has two composition roots:

| Application | Entry point | Port | Owns |
| --- | --- | --- | --- |
| Platform API | `apps/platform-api/server.js` | 5000 | Tours, bookings, payments, stores, admin, auth, chat, workers, schedulers, Socket.IO |
| Stays API | `apps/stays-api/server.js` | 5100 | Accommodation: properties, rooms, rate plans, availability, supplier reservations, offers, finance/payout requests, refund claims, verification |

Both are built from the same repository, the same `package.json` and the same
Prisma schema. They are **deployment-independent**, not code-independent: a
shared capability (`protect`, `resolveSupplier`, rate limiters, Prisma client)
is imported, never copied. What differs is which capabilities each process
starts, and therefore what a release of one can affect.

The root `app.js` and `server.js` are compatibility shims. They re-export the
Platform application, so the existing 258 test suites, the PM2 process
definition (`script: 'server.js'`) and every relative import keep working
unchanged.

## Why this shape

The alternative — copying the server and deleting routes — was rejected. It
would have produced two copies of auth, two copies of CORS, two copies of the
logging stack, and a permanent obligation to keep them in sync. The actual
problem was narrower:

- 965 route registrations existed in a single Express app, all booted by one
  process.
- Stays was 9 files under `src/brands/ghana/stays*.js` plus one validation
  module, mounted exactly once (`src/brands/ghana/supplierRoutes.js:94`).
- Stays used no queue worker and no scheduled job. Its only process-level
  dependencies were Prisma, Redis (through the cache helper) and Cloudinary.
- A Stays-only change therefore still required restarting Tours, payments,
  webhooks, websocket clients and every cron job.

Extracting the *composition root* — the place that decides what to mount and
what to start — fixes the deployment coupling without touching domain logic.
That is why `apps/stays-api/app.js` mounts the existing `staysRoutes` router
rather than a new one.

## Runtime topology

```
                        ┌─────────────────────────────┐
   Internet ── 443 ──▶  │  host Nginx                 │
                        │  /api/...stays  → 127.0.0.1:5100
                        │  everything      → 127.0.0.1:5000
                        └──────────┬──────────┬───────┘
                                   │          │
                     ┌─────────────▼──┐   ┌───▼─────────────┐
                     │ Platform API   │   │ Stays API       │
                     │ 965 routes     │   │ 54 routes       │
                     │ Socket.IO      │   │ no realtime     │
                     │ BullMQ workers │   │ no workers      │
                     │ schedulers     │   │ no schedules    │
                     └───────┬────────┘   └───────┬─────────┘
                             │                    │
                     ┌───────▼────────────────────▼────────┐
                     │ Postgres 127.0.0.1:5432 (shared schema)│
                     │ Redis    127.0.0.1:6379 (shared, opt.) │
                     └───────────────────────────────────────┘
```

Locally, the same two apps run side by side on those ports, or in the bridge
network from `deploy/compose.local.yml`.

## What each process starts

| Concern | Platform | Stays | Where |
| --- | --- | --- | --- |
| Express app | yes | yes | `apps/*/app.js` |
| Prisma client | yes | yes | `src/core/services/prismaClient` |
| Redis + cache | yes | yes (optional at readiness) | `src/core/services/redisClient` |
| JWT auth (`protect`) | yes | yes | `middleware/authMiddleware` |
| Supplier resolution | yes | yes | `middleware/teamRoleMiddleware` |
| Socket.IO | yes | **no** | `apps/platform-api/server.js` |
| BullMQ workers | yes | **no** | `src/core/services/queue` |
| Scheduled jobs | yes | **no** | `registerSchedules` |
| AI cron fallback | yes | **no** | `aiCronFallback` |
| Chat email poller | yes | **no** | `chatEmailIngest` |
| BM25 index build | yes | **no** | `bm25Index` |
| Stripe/PayPal webhooks | yes | **no** | route mounts |
| Tours routers | yes | **no** | route mounts |
| Migrations at boot | **no** | **no** | deliberately absent |

`__tests__/unit/staysBootstrap.test.js` asserts the "no" column by mocking
`bullmq`, checking `require.cache` for the Platform app and `socket.io`, and
scanning both Stays entry files for worker/scheduler/socket references. A future
refactor that copies `server.js` into Stays fails that suite before it reaches a
release.

## URL contract

Both applications answer under two prefixes:

```
/api/travioghana/supplier/stays/*      legacy alias (unchanged)
/api/v1/travioghana/supplier/stays/*   canonical
```

The Platform API additionally serves its full route table under both prefixes.
Implementation and middleware audit: `api-versioning.md`.

## Deployment independence, concretely

A Stays release:

1. builds and pushes `ghcr.io/expedition-go-tours/stays-api:sha-<commit>`;
2. runs `deploy/scripts/deploy-stays.sh <image>`;
3. replaces only the `stays-api` container;
4. gates on `http://127.0.0.1:5100/ready` returning 200;
5. auto-rolls back to the previously recorded Stays image on failure.

At no point is the Platform container pulled, recreated or restarted. The same
is true in reverse for a Platform release. `deploy/scripts/lib.sh` enforces the
separation by always passing `--no-deps` and by recording one image per app.

## Coexistence and rollback

During the transition the Platform API still mounts the Stays router. That is
intentional:

- Nginx can send Stays paths to 5100 while every other path stays on 5000.
- If the Stays container is stopped, removing the Nginx `include` returns Stays
  traffic to 5000, which is exactly the production behaviour before the split.
- No application deploy is needed to roll back the routing change.

Removing Stays from the Platform app is a later, separate step — after Stays has
run independently, after the Nginx split has been observed, and after the
supplier dashboard has been confirmed against the new process.

## Files

```
apps/
  platform-api/app.js        composition root (dual prefix, limiters, probes)
  platform-api/server.js     process entry (Socket.IO, workers, schedules)
  stays-api/app.js           composition root (Stays router only)
  stays-api/server.js        process entry (graceful shutdown, no workers)
  shared/observability.js    BigInt JSON polyfill, Sentry init once
app.js                       shim → apps/platform-api/app
server.js                    shim → apps/platform-api/server
middleware/apiVersion.js     prefix helpers, version header
```

## Non-goals

- No TypeScript migration.
- No monorepo tooling (Nx/Turborepo), no second package manager.
- No split of the Prisma schema or database.
- No message broker between the apps.
- No customer-facing Stays endpoints were invented; only the existing
  supplier-side routes moved.
