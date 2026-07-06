# Testing

## Test Suites

| Suite | Path | Type | Count | Dependencies |
|---|---|---|---|---|
| Unit | `__tests__/unit/` | Mocked (Prisma, Stripe, Redis) | 64 | None |
| API (integration) | `__tests__/api/` | SuperTest + Prisma mock | 18 | Prisma schema |
| E2E | `__tests__/e2e/` | SuperTest + Prisma mock | 6 | Prisma schema |
| Jest load | `__tests__/performance/` | Mocked concurrency | 3 | None |
| Concurrency | `__tests__/concurrency/` | — | — | — |
| k6 smoke | `__tests__/performance/k6/scenarios/smoke.js` | Real HTTP, 7 endpoints | 1 vu × 1 iter | Running app |
| k6 tourListing | `__tests__/performance/k6/scenarios/tourListing.js` | Real HTTP, 30s→2m→30s ramp | 20 VUs peak | Running app |
| k6 checkoutFlow | `__tests__/performance/k6/scenarios/checkoutFlow.js` | Real HTTP, 30s→2m→30s ramp | 10 VUs peak | Running app |
| k6 mixed | `__tests__/performance/k6/scenarios/mixed.js` | 60% listing, 25% detail+calc, 15% calc | 20→50 VUs | Running app |

**Total: 48 suites, 989 tests.**

## Local Setup

### Prerequisites

- **Node.js** 20+
- **Services** (via Docker): `docker-compose up -d`
  - PostgreSQL (PostGIS) on **5433**
  - Redis on **6379**
- **Environment**: copy `.env.example` → `.env`

### Install

```bash
npm install
npx prisma generate
npx prisma migrate deploy
```

### Seed

```bash
# Main seed (roles, permissions)
npm run seed

# Performance test seed (deterministic users, tour, ExpeditionTour link)
npm run seed:perf
```

The perf seed creates:

| Entity | ID (deterministic) | Credentials |
|---|---|---|
| Supplier | `perf-supplier` (MD5 → UUID) | `perf-supplier@test.com` / `Password123!` |
| Customer | `perf-customer` (MD5 → UUID) | `perf-customer@test.com` / `Password123!` |
| Admin | `perf-admin` (MD5 → UUID) | `perf-admin@test.com` / `Password123!` |
| Tour | `9b55dcd5-5b1d-4a3e-ac87-3d3c443e9d93` | slug: `perf-safari-adventure` |

The tour is linked as an Expedition tour (featured, active). All users have `authProvider: 'local'` so they can log in via `/api/auth/login`.

To re-seed the performance database (e.g., after a migration reset):

```bash
npx prisma migrate deploy   # ensure schema is current
npm run seed                 # roles + permissions (must run first)
npm run seed:perf            # deterministic test data
```

**Important**: `seed:perf` depends on the `super_admin` role from `seed.js`. Always run `npm run seed` first.

## Running Tests

### Unit Tests (fastest — no DB needed)

```bash
npm run test:unit        # or: npx jest __tests__/unit/ --no-coverage --forceExit
```

All external services (Prisma, Stripe, Redis, cache, queue, availability calendar) are mocked via `jest.mock()`. These execute in <15s.

### API Integration Tests

```bash
npm run test:api         # or: npx jest __tests__/api/ --no-coverage --forceExit
```

Uses SuperTest + Prisma mock. Validates route wiring, validation, auth middleware, and response shapes. No real DB needed.

### E2E Tests

```bash
npm run test:e2e         # or: npx jest __tests__/e2e/ --no-coverage --forceExit
```

Full booking lifecycle: calculate → confirm → webhook idempotency. Prisma still mocked, but the flows are end-to-end through `confirmBooking` → `processStripeWebhook`.

### All Non-Performance Tests

```bash
npm test                 # excludes performance, concurrency, e2e
npm run test:ci          # same but with --forceExit (CI-safe)
npm run test:all         # everything (including performance)
```

### Jest Load Tests

```bash
npm run test:load        # runs __tests__/performance/
```

These require `stripeEvent` on `mockTx` (see `__tests__/performance/stripeLoad.test.js:108`).

### k6 Performance Tests

**Requires a running app** with seeded data.

```bash
# Terminal 1: start the app
npm start

# Terminal 2: run a k6 scenario
npm run test:perf:smoke       # 1 user, 1 iteration, 7 endpoints
npm run test:perf:listing     # 20 VUs ramp over 3 min
npm run test:perf:checkout    # 10 VUs, checkout calculation
npm run test:perf:mixed       # weighted endpoint mix with spike
```

Or pass flags directly:

```bash
k6 run __tests__/performance/k6/scenarios/smoke.js
k6 run __tests__/performance/k6/scenarios/tourListing.js \
  --summary-export k6-output/summary.json \
  --out json=k6-output/report.json
```

### Concurrency Tests

```bash
npm run test:concurrency
```

## Test Architecture

### Mock Strategy

All Jest tests use manual mocks via `jest.mock()` at the top of each test file:

```js
jest.mock('../../config/prisma', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('stripe', () => () => mockStripe);
```

The mocks reset between tests (`beforeEach` → `jest.clearAllMocks()`). The Prisma mock exposes chainable fluent methods (`findUnique`, `create`, `update`, `$transaction`) that return `this` or a resolved promise.

For `$transaction`, the mock captures the callback and invokes it with a `mockTx` object:

```js
mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockTx));
```

E2E checkout tests use a `mockTx` that includes:
- `booking.create`
- `booking.update`
- `stripeEvent.findUnique`
- `stripeEvent.upsert`
- `stripeEvent.update`

### k6 Authentication

k6 scripts use `authenticate()` from `__tests__/performance/k6/helpers.js`:

```js
const token = authenticate(BASE_URL, CUSTOMER_EMAIL, CUSTOMER_PASSWORD);
// Then: http.get(url, authHeaders(token));
```

This POSTs to `/api/auth/login` and returns the `accessToken` from the JSON response.

## CI Workflows

### CI (`ci.yml`) — Every push + PR

Splits into 7 parallel jobs:

| Job | Runs On | Triggers | Services | Cost |
|---|---|---|---|---|
| `lint` | every push | — | None | ~30s |
| `unit-tests` | every push | — | None | ~8s |
| `integration-tests` | every push | — | None | ~15s |
| `startup-check` | PR + main | PostGIS + Redis | App boot + 4 smokes | ~2m |
| `smoke-test` | PR + main | PostGIS + Redis | k6 7-endpoint smoke | ~3m |
| `e2e-tests` | PR + main | — | 6 checkout tests | ~5s |
| `coverage` | PR + main | PostGIS + Redis | Full suite + badge SVG | ~30s |

**Why split?** Lint/unit/integration finish in <15s on every push. Heavier jobs (DB-backed startup, k6, full coverage) only run on PRs and main, keeping push feedback fast.

**JUnit XML**: Test results are published to the GitHub Checks UI via `dorny/test-reporter` — failures appear in the Actions Summary tab with stack traces.

**Coverage badge**: `scripts/generateBadge.js` reads `coverage/coverage-summary.json` (generated by Jest's `json-summary` reporter) and produces `coverage-badge.svg` with per-category shields (lines, statements, functions, branches).

### Performance (`perf.yml`) — Nightly + manual

- **Schedule**: `0 6 * * *` (daily at 06:00 UTC)
- **Dispatch**: `workflow_dispatch` (manual trigger from GitHub UI)
- **Matrix**: 3 parallel jobs (`tourListing`, `checkoutFlow`, `mixed`)
- Each job: PostGIS + Redis → migrate → seed → app start → k6 → HTML summary → artifact

### Security (`security.yml`) — Nightly + manual

- **Schedule**: `0 7 * * *` (daily at 07:00 UTC)
- **ZAP Baseline Scan**: `zaproxy/action-baseline` against `http://localhost:5000`
- **Artifact**: `report_html.html` uploaded regardless of pass/fail

## k6 Thresholds

| Scenario | Threshold | Meaning |
|---|---|---|
| `smoke` | `p(95)<2000ms` | 95% of requests under 2s |
| `smoke` | `rate<0.01` | <1% failure rate |
| `tourListing` | `p(95)<500ms` | 95% under 500ms |
| `tourListing` | `p(99)<1000ms` | 99% under 1s |
| `checkoutFlow` | `p(95)<800ms` | 95% under 800ms |
| `checkoutFlow` | `p(99)<1500ms` | 99% under 1.5s |
| `mixed` | `p(95)<1000ms` | 95% under 1s |
| `mixed` | `p(99)<2000ms` | 99% under 2s |
| `mixed` | `listing_errors <0.01` | <1% listing errors |
| `mixed` | `detail_errors <0.01` | <1% detail errors |
| `mixed` | `checkout_errors <0.02` | <2% checkout errors |
| All | `http_req_failed <0.01` | <1% total failures |

**How to interpret**: If a threshold is `p(95)<500`, that means 95 out of 100 requests must complete in under 500 milliseconds. If the check fails, the workflow exits with a non-zero code (the step shows ❌ in GitHub Actions).

## Performance Seed Data

The deterministic seed (`prisma/seedPerf.js`) uses MD5 hashes to generate fixed UUIDs so k6 scripts can hardcode IDs without runtime lookup:

```js
const uuid = (seed) => {
  const hex = crypto.createHash('md5').update(seed).digest('hex');
  return `${hex.slice(0,8)}-...`;
};
const TOUR_ID = uuid('perf-tour'); // → 9b55dcd5-5b1d-4a3e-ac87-3d3c443e9d93
```

Key details:
- Supplier has `status: 'ACTIVE'` (required for tour creation)
- Tour: `status: 'ACTIVE'`, 2026–2027 pricing schedule, per-person pricing
- Customer: `emailVerified: true`, `stripeCustomerId: 'cus_perf_customer'`
- ExpeditionTour: `isFeatured: true`, `isActive: true`

## Coverage

### Thresholds

| Metric | Threshold | Current |
|---|---|---|
| Branches | 45% | ~58% |
| Functions | 50% | ~65% |
| Lines | 60% | ~74% |
| Statements | 60% | ~72% |

Thresholds are enforced in `jest.config.js` — coverage jobs fail if they drop below these values.

### Badge

A coverage badge SVG is generated by `scripts/generateBadge.js` during the `coverage` CI job. It reads `coverage/coverage-summary.json` (requires `json-summary` reporter in `jest.config.js`) and outputs `coverage-badge.svg` — uploaded as a CI artifact.

## Rate Limiting

All rate limiters are configurable via environment variables:

```
RATELIMIT_<NAME>_MAX      # max requests
RATELIMIT_<NAME>_WINDOW_MS # window in milliseconds
```

Defaults (when env vars are unset):

| Limiter | Max | Window |
|---|---|---|
| Global | 500 | 1 hour |
| Auth | 20 | 15 min |
| Upload | 20 | 1 hour |
| Contact | 5 | 15 min |
| Subscribe | 10 | 1 min |
| Admin | 200 | 15 min |
| Location | 120 | 1 min |
| Team Invite | 10 | 1 hour |
| Invite Lookup | 30 | 15 min |

See `.env.example` for the full list.

## Common Issues

| Symptom | Cause | Fix |
|---|---|---|
| `prisma migrate deploy` fails | PostGIS not running | `docker-compose up -d` |
| `seed:perf` throws "role not found" | `seed.js` not run first | `npm run seed` before `npm run seed:perf` |
| k6 `authenticate()` returns null | Server not running or wrong port | `npm start` then verify `curl localhost:5000/health` |
| k6 checkout test fails `calculate has pricing` | Tour not seeded or wrong ID | Run `npm run seed:perf`, check TOUR_ID in `config.js` |
| Jest load test 0 throughput | `mockTx` missing `stripeEvent` | Add `stripeEvent: { findUnique: jest.fn().mockResolvedValue(null), upsert: ..., update: ... }` |
| Coverage not generated | `json-summary` reporter missing | Verify `jest.config.js` has `'json-summary'` in `coverageReporters` |
| `JEST_JUNIT_OUTPUT_DIR` not found | Directory doesn't exist | CI workflow creates it via env var; locally you must `mkdir -p reports/junit` |

## Adding a New Test

1. **Unit test**: `__tests__/unit/yourFeature.test.js` — mock all services, test handler logic
2. **API test**: `__tests__/api/yourFeature.test.js` — SuperTest, mock Prisma, test route + validation
3. **E2E test**: `__tests__/e2e/yourFeature.test.js` — mock Prisma, test multi-step flows
4. **k6 scenario**: `__tests__/performance/k6/scenarios/yourScenario.js` — real HTTP against running app
5. **CI**: add a new job in `.github/workflows/ci.yml` or extend an existing matrix
