# Module ownership and dependency rules

The split only stays honest if it is obvious which code belongs to which
application. This document defines that boundary and the direction dependencies
are allowed to flow.

## Three layers

```
┌──────────────────────────────────────────────────────────────┐
│ Domain                                                       │
│   Platform: routes/, providers/, src/core/domain/,           │
│             src/brands/**/ (non-stays controllers)           │
│   Stays:    src/brands/ghana/stays*.js,                      │
│             src/core/services/staysValidation.js             │
└──────────────────────────────┬───────────────────────────────┘
                               │ may use
┌──────────────────────────────▼───────────────────────────────┐
│ Shared capabilities                                          │
│   middleware/  config/  src/core/services/  prisma/          │
│   apps/shared/  package.json  Dockerfile                     │
└──────────────────────────────┬───────────────────────────────┘
                               │ used by
┌──────────────────────────────▼───────────────────────────────┐
│ Composition roots                                            │
│   apps/platform-api/app.js + server.js                       │
│   apps/stays-api/app.js + server.js                          │
└──────────────────────────────────────────────────────────────┘
```

Dependencies point **downward only**. A shared module must never import a
composition root, and must never assume which process is running it. A domain
module may use shared capabilities. Composition roots may use both.

## The Stays surface

Exactly these files are Stays-owned:

| File | Lines | Responsibility |
| --- | ---: | --- |
| `src/brands/ghana/staysController.js` | 697 | property CRUD, builder payload, room/rate-plan assembly |
| `src/brands/ghana/staysBookingsController.js` | 516 | supplier-created reservations, status transitions, cancellation reporting |
| `src/brands/ghana/staysFinanceController.js` | 596 | payout summary, payout requests, invoices, refunds, disputes |
| `src/brands/ghana/staysOffersController.js` | 255 | offers and review targets |
| `src/brands/ghana/staysAnalyticsController.js` | 239 | supplier analytics |
| `src/brands/ghana/staysVerificationController.js` | 239 | accommodation verification documents |
| `src/brands/ghana/staysShared.js` | 208 | status maps, date helpers, serializers |
| `src/brands/ghana/staysRoutes.js` | 187 | route table + permission mapping (54 handlers) |
| `src/core/services/staysValidation.js` | 145 | payload validation |

`staysBookingsController.js` grew by ~180 lines with the inventory transaction
fix described in `stays-inventory.md`; the total is ~3,080 lines, not the
~2,900 it was before that change.

These files may import:

- `src/core/services/*` — Prisma, errors, booking numbers, commission, finance
  domain services
- `middleware/*` — auth, permissions, uploads, validation
- `config/*` — JWT, Cloudinary
- `src/brands/ghana/staysShared.js` — their own helpers

They must **not** import:

- `apps/platform-api/*`
- `socket.io`, `src/core/services/queue` at module load, `aiCronFallback`,
  `chatEmailIngest`, `bm25Index`
- any router outside the Stays vertical

The last rule is what keeps a Stays-only process from accidentally starting a
queue consumer. `queue.js` creates `Queue` handles lazily and only constructs a
`Worker` inside `registerWorkers`, which the Stays entry never calls.
`staysBootstrap.test.js` asserts that.

## Platform-owned code that Stays must not reach

| Path | Why |
| --- | --- |
| `routes/` | Tours, stores, admin, auth, chat, webhooks |
| `src/core/domain/` | Booking/payment/refund controllers that assume Tours |
| `src/core/storefront.js`, `src/core/supplier.js`, `src/core/admin.js` | Tours projections |
| `providers/` | Payment/external providers wired for Tours |

There is one intentional exception: Stays finance imports
`src/core/domain/financeController.js` and
`src/core/domain/payoutMethodController.js`, both of which are
domain-agnostic money operations (payout methods, invoices) and are reached
through `/api/.../stays/finance/...` and `/api/.../stays/payout-methods`. They
are listed here so that a future reader does not "clean up" the import and
break supplier payouts.

## Shared modules are shared, not owned

`middleware/`, `config/`, `src/core/services/` and `prisma/` affect **both**
images. That is why the CI map (`ci/dependency-map.json`) routes any change
under those trees to both builds. Editing `middleware/authMiddleware.js` while
rebuilding only Stays would produce two containers built from different auth
implementations.

The intended workflow for a shared change:

1. Change the shared module.
2. Run the full suite (both apps use it).
3. Release both images, even if only one app needs the behaviour today.

## Adding a Stays capability

1. Put domain logic in a `stays*.js` file (or extend one).
2. Add the route to `staysRoutes.js` with an explicit
   `requireTeamPermission('stays.*')` entry. Do not rely on the supplier guard
   alone for a write.
3. Add a unit test and, if it touches inventory or money, a database test.
4. Nothing else is required: `apps/stays-api/app.js` mounts `staysRoutes`, so
   the endpoint appears under both prefixes automatically.

No change to `apps/platform-api/*` is needed, and none should be made. If a
Stays feature seems to require a Platform change, that is a signal that the
logic belongs in a shared service instead.

## Adding a shared capability

1. Put it in the appropriate shared directory.
2. Never read `process.env.SERVICE_NAME` to alter behaviour between apps; if
   the two must differ, pass a parameter from the composition root.
3. Wire it in **both** `apps/platform-api/app.js` and `apps/stays-api/app.js`,
   or in neither. A capability wired into one app only is a silent behavioural
   fork.

## Enforcement today

| Rule | Enforced by |
| --- | --- |
| Stays starts no workers/schedules | `__tests__/unit/staysBootstrap.test.js` |
| Stays serves no Tours routes | `staysBootstrap.test.js`, `staysInventory.test.js` |
| Both prefixes reach the same logic | `__tests__/api/apiVersioning.test.js` |
| Shared changes rebuild both images | `__tests__/unit/ciDependencyMap.test.js` |
| Root shims export the Platform app | require identity check in the release validation |

There is no ESLint `no-restricted-imports` rule for the boundary yet. That is a
deliberate gap: the import graph is still small enough to review, and a premature
rule would have to allow-list the finance exception and the shared services.
If the Stays surface grows past ~20 files, add the rule.
