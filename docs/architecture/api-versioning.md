# API versioning: `/api/v1` with `/api` aliases

## Contract

Both prefixes are live, and both reach the **same router instance**:

```
/api/...        legacy alias — every existing integration uses it
/api/v1/...     canonical
```

There is no forked controller, no duplicated permission map and no second copy
of the route table. `mountPrefixRoutes(app, prefix, limiters)` is called once per
prefix and mounts the identical router objects; `mountStaysRoutes` does the same
for the Stays app.

Every response carries:

```
X-API-Version: v1        # when served from /api/v1
X-API-Version: legacy    # when served from /api
```

The header is set before the rate limiter, so a `429` and a `200` both state
which contract answered. That makes a gradual client migration observable in
logs and in network traces without guessing from the URL.

## Why not duplicate the routers

Mounting the same object twice means:

- a route added to `routes/tourRoutes.js` appears on both prefixes with no extra
  step;
- a guard added inside a router protects both prefixes automatically;
- it is impossible for `/api/v1` to drift from `/api` in handler behaviour,
  because there is only one handler.

The risk of dual mounting is *middleware mounted outside the router*: anything
registered on a concrete path (`/api/auth`) does not match `/api/v1/auth`. That
is the part this document audits.

## Middleware audit

### Mounted once, prefix-wide

| Middleware | Mount | Why once |
| --- | --- | --- |
| `tagApiVersion` | `/api` | Express prefix matching covers `/api/v1`; stamping twice would be redundant |
| Global rate limiter | `/api` | Mounting per prefix would charge a canonical request twice (halving the real budget) |
| Maintenance mode | `/api` | One evaluation per request; the module normalises the `v1` segment itself |
| Helmet, HPP, compression, CORS, correlation ID, HTTP logging, Passport, cookie parser, JSON body parsers | app root | Not path-specific; apply to probes and both prefixes alike |

### Mounted per prefix

Registered for `LEGACY_API_PREFIX` and `VERSIONED_API_PREFIX` in the same loop:

| Middleware | Paths | Risk if it were legacy-only |
| --- | --- | --- |
| Prerender limiter | `/prerender` | Canonical bot traffic unbounded |
| Auth limiter | `/auth` | Credential stuffing via `/api/v1/auth` |
| Places limiter | `/places` | Geocoder quota exhaustion via the new prefix |
| Upload limiter | `/users/updateMe`, `POST/PATCH /tours`, `POST/PATCH /reviews`, `POST/PATCH /suppliers`, `POST /chat`, `/blog/admin/upload` | Unlimited multipart uploads |
| SSO limiter | `/sso` | Unlimited handoff minting |
| Raw body parser | `/webhooks/stripe`, `/webhooks/paypal`, `/webhooks/resend` | Signature verification fails (silently, and in the worst direction) |
| Routers | every platform router | `/api/v1` would 404 |
| Supplier → Stays router | `/suppliers/...` chain | Stays unreachable on the canonical prefix |

The SSO limiter deserves a note: it is now created once in `createLimiters()`
and shared by both prefixes. It previously lived inside `mountPrefixRoutes`,
which meant each prefix got its own counter — twice the intended budget for the
same person. The route-scoped limiters that *are* created once (auth, places,
upload) already behaved correctly; this brings SSO in line.

### Authorization

Authorization is not part of the prefix audit because it does not live on a
prefix. It lives inside the routers:

```
protect                 middleware/authMiddleware.js
resolveSupplier         middleware/teamRoleMiddleware.js
requireTeamPermission   middleware/teamRoleMiddleware.js
```

`/api/v1` cannot bypass them for the same reason `/api` cannot: the guards are
inside the mounted router, and both prefixes mount the same router. The supplier
router applies `protect` and `resolveSupplier` to everything beneath it,
including `/suppliers/travioghana/stays`; the Stays app repeats that exact chain
in `mountStaysRoutes`.

The Stays app never reads `X-User-Id` or `X-Supplier-Id`. `protect` derives the
user from a verified JWT (Bearer header first, then the `accessToken` cookie),
and `resolveSupplier` derives the supplier from the database — owner profile or
accepted team membership.

## Maintenance mode

`middleware/maintenanceMode.js` stores one flag for the whole platform. Because
it is mounted at `/api`, it sees `/v1/admin/...` as `/v1/admin/...` and would
wrongly lock operators out during an incident. It therefore normalises the path
relative to the API mount before deciding:

```js
function isExempt(req) {
  const path = normalizeWithinApi(req.path);
  return path.startsWith('/admin') || path.startsWith('/webhooks');
}
```

So `/api/v1/admin/*` and `/api/v1/webhooks/*` are exempt exactly like their
legacy spellings. Payment webhooks stay reachable during maintenance: Stripe and
PayPal cannot retry around a 503 they were never told to expect.

## Version helpers

`middleware/apiVersion.js` exports:

| Export | Meaning |
| --- | --- |
| `LEGACY_API_PREFIX` | `/api` |
| `VERSIONED_API_PREFIX` | `/api/v1` |
| `API_MAJOR_VERSION` | `v1` |
| `API_VERSION_HEADER` | `X-API-Version` |
| `normalizeWithinApi(path)` | `/v1/tours` → `/tours`; `/v10/...` unchanged |
| `isVersionedPath(path)` | true only for an absolute `/api/v1` path |
| `tagApiVersion` | middleware; reads `req.originalUrl`, not `req.path` |

`tagApiVersion` reads `req.originalUrl` because it is mounted at `/api`: Express
rewrites `req.path` relative to the mount point, so `req.path` there is
`/v1/tours` and an absolute comparison would never match.

`normalizeWithinApi` only strips exactly `/v1`, so `/v10` and `/v1foo` are not
mistaken for version segments.

## Tested guarantees

`__tests__/api/apiVersioning.test.js`:

| Assertion | Proves |
| --- | --- |
| Protected route returns identical 401 on both prefixes | Same guard, same body |
| `X-API-Version` is `legacy` / `v1` | Version is observable |
| Unknown route 404s on both | Route table mounted twice |
| Stripe webhook path behaves identically | Raw body parser mounted twice |
| Maintenance blocks both prefixes | No `/v1` bypass |
| Admin and webhooks exempt on both | Operator access preserved on both |
| Global budget `max=2`: legacy, v1, legacy → 401, 401, 429 | One shared limiter, not two, not double-charged |
| Upload budget `max=1`: legacy then v1 → second is 429 | One shared upload guard across spellings |

`__tests__/api/staysInventory.test.js` adds prefix parity for the Stays app:
identical 401s, identical property payloads, and no Tours routes.

## Client guidance

- New integrations should use `/api/v1/...`.
- Existing integrations need no change; `/api` is not deprecated by date, only
  by contract.
- Do not assume the header means success: a `429` from `/api/v1` is still a
  `429`. The header describes the contract, not the outcome.

## Future sunset (not scheduled)

The legacy prefix should be removed only when:

1. access logs show no meaningful `/api/` (non-`v1`) traffic for a full
   business cycle;
2. the supplier dashboard and storefronts ship against `/api/v1`;
3. a deprecation response (`410 Gone` plus `Link: </api/v1/...>; rel="successor-version"`)
   has been deployed long enough for integrators to react.

No sunset date is set. Removing `/api` today would break every existing client
for no operational gain.
