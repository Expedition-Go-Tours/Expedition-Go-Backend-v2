# Expedition Go / Travio Africa — Backend API

Production-grade REST API for the Expedition Go Tours / Travio Africa travel marketplace. Powers the customer storefront, the supplier dashboard, and the admin dashboard.

Express + Prisma + PostgreSQL (PostGIS) + Redis + Socket.IO, with Stripe payments, Cloudinary media, Resend email, Firebase/Google auth, and full supplier verification.

---

## Capabilities

- **Auth & accounts** — email/password (bcrypt + JWT access/refresh rotation), Google OAuth + One Tap, Firebase Admin role verification, team members & invitations.
- **Tours** — full product builder storage, draft → `PENDING_APPROVAL` → `ACTIVE` moderation workflow, live-tour edit drafts, full-text + geo + facet search, availability calendars with date overrides, pricing tiers, special offers, popularity ranking.
- **Bookings** — cart, Stripe Payment Intents (pay-now / reserve-pay-later with an automatic collection sweep), cancellations & refunds, booking reminders, pickup planning, verified reviews.
- **Payments & payouts** — Stripe webhooks with retry queue, per-supplier payout methods, payout approval/release lifecycle.
- **Chat & notifications** — supplier↔admin / customer↔support chat (Socket.IO), in-app + email + admin notification feeds with realtime delivery.
- **Admin platform** — RBAC roles & permissions, tour/supplier/review moderation queues, revenue/user/funnel analytics, tamper-evident audit log (hash chain), platform settings, expedition listing publishing.
- **Blog** — Sanity-backed articles, categories/tags, SEO, sitemap.
- **Supplier registration & verification** (new) — see [Supplier Verification](#supplier-registration--verification).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ |
| Framework | Express |
| Database | PostgreSQL 16 (PostGIS) |
| ORM | Prisma 5 |
| Queue / Cache | Redis 7 (BullMQ-style workers + in-memory fallback) |
| Auth | JWT, Google OAuth (passport), Firebase Admin SDK |
| Payments | Stripe (Payment Intents, pay-later, payouts) |
| Media | Cloudinary (multer storage; `Media` table tracks every upload) |
| Email | Resend (compiled templates via `utils/emailRenderer.js`) |
| Real-time | Socket.IO (+ Redis adapter) |
| Monitoring | Sentry + Logtail (Better Stack) |
| API docs | Swagger (OpenAPI) |

---

## Architecture

- **`app.js`** — Express app (middleware, routes, error handling). **`server.js`** — entry point: HTTP server, Socket.IO, queue worker registration, and the background scheduler.
- **Queue workers** — email, notifications, Stripe customer creation, webhook retries, content sync, analytics events, aggregations, and cleanup jobs. If Redis is unavailable the app degrades to in-process fallbacks so nothing silently drops.
- **Scheduler** — periodic jobs registered in `server.js`:
  - `cleanup-expired-cart`, `cleanup-stale-bookings`, `charge-pay-later-bookings`
  - `plan-booking-reminders` / `dispatch-booking-reminders`
  - `refresh-popularity`, `cleanup-events`, `cleanup-notifications`, `cleanup-audit-logs`, `purge-archived-tours`, `expire-special-offers`
  - `expire-supplier-documents` / `plan-doc-expiry-reminders` (licence/certificate expiry tracking)
- **Caching** — Redis-backed helper with in-memory fallback and a 1-minute dashboard cache; public tour caches are invalidated on supplier/tour status changes.
- **Audit trail** — `utils/auditLogger.js` writes a hash-chained log (`AuditLog` + `AuditLogArchive`) that can be integrity-verified end to end.

---

## Quick Start

### Prerequisites

- Node.js 20+
- Docker Desktop (for local PostgreSQL + Redis)
- A `.env` file (see [Environment Variables](#environment-variables))

### Setup

```bash
# 1. Start local PostgreSQL (PostGIS) and Redis
docker compose up -d

# 2. Install dependencies (also regenerates the Prisma client)
npm install

# 3. Apply migrations
npm run migrate          # = npx prisma migrate deploy

# 4. Seed roles/permissions/sample data
npm run seed

# 5. (Optional) Seed the supplier-verification pipeline test data
npm run seed:verification

# 6. Start the dev server (auto-reload)
npm run dev
```

The API runs at `http://localhost:5000` — Swagger docs at `http://localhost:5000/api-docs`.

> **Note:** local PostgreSQL maps to host port **5433** (avoids conflicts with native installs on Windows). Redis uses **6379**.

### Wiping the local database

```bash
docker compose down -v
docker compose up -d
npm run migrate
npm run seed
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in the required values. `DATABASE_URL`/`DIRECT_URL` point at the local Docker Postgres by default.

| Variable | Default (local) | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5433/travio` | App connection (Neon direct endpoint in prod, **not** pgbouncer) |
| `DIRECT_URL` | same as above | Used by Prisma for migrations only |
| `REDIS_URL` | `redis://localhost:6379` | Redis for queue workers + cache |
| `JWT_SECRET` | — | Access-token signing secret (**required in prod**) |
| `JWT_REFRESH_SECRET` | — | Refresh-token signing secret (**required in prod**) |
| `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` | — | Firebase Admin SDK (role verification) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_CALLBACK_URL` | — | Google OAuth login |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | — | Cloudinary media/document storage |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | — | Stripe payments |
| `RESEND_API_KEY` | — | Transactional email delivery |
| `EMAIL_FROM` / `EMAIL_REPLY_TO` / `LOGO_URL` / `SUPPORT_EMAIL` | — | Email branding / support |
| `CLIENT_URL` / `SUPPLIER_DASHBOARD_URL` / `PRODUCTION_API_URL` / `API_BASE_URL` | local ports | Frontend + API origins |
| `ALLOWED_ORIGINS` | — | Comma-separated CORS + Socket.IO allowlist |
| `SENTRY_DSN` / `LOGTAIL_TOKEN` / `LOGTAIL_HOST` | — | Monitoring & structured logs |
| `NODE_ENV` / `PORT` / `API_VERSION` | `development` / `5000` | Runtime settings |
| `RATELIMIT_*` | built-in defaults | Per-route rate-limit tuning |

> If `RESEND_API_KEY` or other optional keys are unset the app still boots; email delivery and the affected features are skipped with clear log messages.

---

## Supplier Registration & Verification

Suppliers register by **type** and every document is verified individually before they can operate. This enforces the platform rule: *no supplier, guide, or vehicle can be advertised or booked until the required documentation has been reviewed and approved.*

### Supplier types

`TOUR_GUIDE` · `TOUR_COMPANY` · `ACCOMMODATION_PROVIDER` · `TRANSPORTATION_PROVIDER` · `VEHICLE_OPERATOR` · `OTHER_SERVICE_PROVIDER`

Each type maps to its own required document set (e.g. Ghana Card, tour guide licence, driver's licence for guides; business certificate + GTA certificate for companies; registration/ownership/roadworthiness/insurance per vehicle).

### Data model

- `SupplierProfile` — application status (`PENDING → UNDER_REVIEW → APPROVED → ACTIVE`, plus `SUSPENDED` / `REJECTED` / `EXPIRED`), `supplierType`.
- `SupplierDocument` — one row per uploaded file with `PENDING / APPROVED / REJECTED / REPLACEMENT_REQUESTED / EXPIRED`, expiry date, review note, reviewer + review timestamp.
- `Vehicle` / `Guide` — company fleet and guides, each with its own verification status.
- `VerificationEvent` — immutable history of *what was verified, when, when it expires, and who approved it*.

### Expiry automation

A daily scheduler (`expire-supplier-documents`, `plan-doc-expiry-reminders`) sends **60 / 30 / 7-day** reminders, then on expiry automatically flips the document to `EXPIRED`, moves the supplier to `EXPIRED` (hiding their tours), and emails both the supplier and the admins. Renewing + approving the document reactivates the account automatically.

### Admin review API

`GET /suppliers/admin/qc-dashboard`, `GET /suppliers/admin/:id/verification`, `PATCH /suppliers/admin/documents/:docId`, `PATCH /suppliers/admin/vehicles/:vehicleId`, `PATCH /suppliers/admin/guides/:guideId` — all permission-gated (`suppliers.view` / `suppliers.approve`). Suppliers **cannot self-approve**; only admin role accounts can.

### Seeds & backfill

```bash
# Test data across every status/type (8 suppliers, docs, vehicles, guides)
npm run seed:verification

# Convert legacy suppliers' businessDocuments JSON into granular records
node scripts/backfill-supplier-documents.js   # idempotent, run once in prod
```

---

## Scripts & Commands

| Command | Description |
|---|---|
| `npm run dev` | Start with auto-reload (nodemon) |
| `npm start` | Start in production mode |
| `npm run migrate` | Apply pending migrations (`prisma migrate deploy`) |
| `npm run seed` | Seed roles, permissions, sample data |
| `npm run seed:perf` / `seed:blogs` / `seed:verification` | Specialized seeds |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run test` | Jest unit + API suites |
| `npm run test:unit` / `test:api` / `test:e2e` / `test:all` | Targeted Jest suites |
| `npm run test:concurrency` | Concurrency tests |
| `npm run test:perf:smoke` / `:listing` / `:checkout` / `:mixed` | k6 load tests |
| `npx prisma studio` | Database GUI |

### Testing

- **Unit** — `__tests__/unit/` (controllers, helpers, middleware, schema validation).
- **API** — `__tests__/api/` (route integration with mocked prisma/queue/cache).
- **E2E / concurrency / performance** — `__tests__/e2e`, `__tests__/concurrency`, `__tests__/performance` (k6).
- Coverage thresholds are enforced globally (branches 45%, functions 50%, lines 60%, statements 60%).

```bash
npm run test          # fast feedback (unit + API)
npm run test:all      # everything
npm run test:perf:smoke
```

---

## Deployment (Hetzner)

Production runs on a Hetzner Cloud VPS (Ubuntu 22.04, Node 22, PostgreSQL 18.6, Redis 8.0.5).

**Infrastructure:** Nginx reverse proxy → PM2 → Node.js app on port 5000. Domain: `apiv1.travioafrica.com`.

**CI/CD:** Pushing to `main` triggers `.github/workflows/ci.yml`, which runs all test suites and then auto-deploys via SSH:

```bash
ssh deploy@<hetzner-host>
cd /home/deploy/Expedition-Go-Backend-v2
git pull origin main
npm install --omit=dev
npx prisma generate
npx prisma migrate deploy
pm2 restart all
```

Database migrations are applied automatically on every deploy. For existing suppliers created before the verification feature shipped, run the backfill once after the first deploy:

```bash
node scripts/backfill-supplier-documents.js
```

---

## Project Structure

```
Backendv2/
├── prisma/                 # Schema, migrations, seed scripts (incl. seedVerification.js)
├── routes/                 # Express route definitions
├── controllers/            # Request handlers (supplier, tour, booking, admin, ...)
├── middleware/             # Auth, RBAC, team-role, rate limiting, uploads (Cloudinary)
├── utils/                  # email, queue, cache, scheduler jobs, audit, verification helpers
├── config/                 # Firebase, Cloudinary, JWT, Swagger, rate-limit config
├── providers/              # External service adapters
├── queues/                 # Queue definitions
├── email-templates/        # Email template sources
├── sendgrid-templates/     # Compiled template set used by emailRenderer
├── generated/              # Generated Prisma artifacts (not hand-edited)
├── docs/                   # Additional documentation
├── scripts/                # One-off admin / backfill scripts
├── __tests__/              # unit / api / e2e / concurrency / performance
├── app.js                  # Express app
├── server.js               # Entry point: HTTP + Socket.IO + workers + scheduler
└── docker-compose.yml      # Local PostgreSQL (PostGIS) + Redis
```

---

## Security

- JWT access tokens with rotating refresh tokens; per-route RBAC via admin roles/permissions.
- Suppliers cannot approve their own application or documents — review is admin-only.
- All uploads are validated as Cloudinary URLs and recorded in the `Media` table; replaced files are purged from Cloudinary.
- Global + per-route rate limiting (see `RATELIMIT_*` env vars).
- Tamper-evident audit log with per-entry hash chaining and a verification endpoint.
