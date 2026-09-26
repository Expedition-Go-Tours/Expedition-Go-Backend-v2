const fs = require('fs');
const path = require('path');

/**
 * The supplier route tables are the permission model's enforcement point, and
 * nothing else tests them: a dropped `requireTeamPermission(...)` is invisible
 * until a support member can read a supplier's payouts. These tests read the
 * route files and assert the shape of every statement.
 *
 * Two rules:
 *   1. every WRITE needs an explicit guard;
 *   2. every MONEY read needs `payouts.view` (or a stricter key).
 *
 * Reads of the business's own profile/tax/booking-rules are deliberately open
 * to every member — they work for that business, and the WRITE is what decides
 * who may change it.
 */

/**
 * The supplier route tables: every route in these files acts on one supplier
 * account, so the write rule below covers all of them.
 */
const SUPPLIER_ROUTE_FILES = [
  'routes/supplierRoutes.js',
  'routes/specialOfferRoutes.js',
  'routes/refundClaimRoutes.js',
  'routes/disputeRoutes.js',
  'src/brands/ghana/supplierRoutes.js',
  'src/brands/africa/supplierRoutes.js',
];

/**
 * The storefront routers are mostly PUBLIC (contact form, newsletter, checkout
 * maths) and mostly the CUSTOMER's own account, so the write rule does not apply
 * to them. They are audited for the supplier-scoped rules instead, because they
 * also carry the supplier's bookings endpoints: both dashboards rewrite
 * /bookings/supplier/* into a brand namespace, so these are the routes the
 * Bookings page actually calls.
 */
const STOREFRONT_ROUTE_FILES = [
  'src/brands/ghana/routes.js',
  'src/brands/africa/routes.js',
  'src/brands/expedition/routes.js',
];

const ROUTE_FILES = [...SUPPLIER_ROUTE_FILES, ...STOREFRONT_ROUTE_FILES];

const GUARDS = [
  'requireTeamPermission',
  'requireTeamRole',
  'requirePermission',
  'restrictTo',
  'protect',
  'uploadSupplier',
  'uploadKyc',
];

/**
 * Statements that are guarded by design rather than by middleware, each with
 * the reason it is safe. Keep this list short: an entry here is a promise that
 * the controller itself cannot be abused.
 */
const ALLOWED_WITHOUT_GUARD = [
  // The application form runs BEFORE anyone is a supplier: the file's
  // `router.use(protect)` authenticates the applicant and there is no supplier
  // profile yet to authorise against — that is the point of the endpoint.
  { path: '/apply', reason: 'pre-membership: authenticated, nothing to scope to' },
  // Pre-membership: the token in the URL is the secret and the controller
  // checks the signed-in email matches the invitation.
  { path: '/settings/team/invite/:token/accept', reason: 'token-authorised' },
  { path: '/settings/team/invite/:token/decline', reason: 'token-authorised' },
  // Per-account notifications: the controller scopes every statement to
  // req.user.id, so a member only ever touches their own inbox.
  { path: '/notifications/:id/read', reason: 'per-account' },
  { path: '/notifications/mark-all-read', reason: 'per-account' },
  { path: '/notifications/:id', reason: 'per-account' },
];

/** Reads that hand out money, and the key that must be on them. */
const MONEY_READS = [
  { path: '/earnings', key: 'payouts.view' },
  { path: '/payouts', key: 'payouts.view' },
  { path: '/finance/summary', key: 'payouts.view' },
  { path: '/finance/charges', key: 'payouts.view' },
  { path: '/finance/earnings', key: 'payouts.view' },
  { path: '/finance/payouts/requests', key: 'payouts.view' },
  { path: '/finance/disputes', key: 'payouts.view' },
  { path: '/finance/payout-settings', key: 'payouts.view' },
  { path: '/payout-methods', key: 'payout-methods.view' },
];

/** Writes that move money: the request key, not the view key. */
const MONEY_WRITES = [
  { path: '/finance/payout/request', method: 'POST', key: 'payouts.request' },
  { path: '/finance/payouts/requests/:id/cancel', method: 'PATCH', key: 'payouts.request' },
  { path: '/finance/payout-settings', method: 'PATCH', key: 'payouts.request' },
  { path: '/payout-methods', method: 'POST', key: 'payout-methods.manage' },
  { path: '/payout-methods/:id', method: 'PATCH', key: 'payout-methods.manage' },
  { path: '/payout-methods/:id', method: 'DELETE', key: 'payout-methods.manage' },
];

const REPO_ROOT = path.resolve(__dirname, '../..');

/** Every permission key a role can actually hold, straight from the model. */
const grantedKeys = (() => {
  const { TEAM_ROLE_PERMISSIONS } = require('../../config/teamPermissions');
  return new Set(Object.values(TEAM_ROLE_PERMISSIONS).flatMap((role) => role.permissions));
})();

/**
 * A `router.use(...)` guard protects every route in its file, and a statement
 * scan cannot see it. Two shapes exist in this codebase: authentication only
 * (`protect`, `router.use(protect)`) and an authorisation chain
 * (`protect, resolveSupplier, requireTeamPermission('x')`). Only the second is
 * accepted as a guard — authentication is not authorisation, which is exactly why
 * `POST /logo` used to be reachable by any member.
 */
function fileGuard(source) {
  const use = source.match(/^router\.use\((.*)\);?\s*$/m);
  if (!use) return null;
  const permission = use[1].match(/requireTeamPermission\('([^']+)'\)/);
  return permission ? permission[1] : null;
}

/**
 * Whether the file resolves the supplier for every route in it, via a
 * file-level `router.use(protect, resolveSupplier)`. The supplier's identity is
 * the OWNER's account — a member's own account owns nothing — so a controller
 * that scopes by `req.supplierId` is correct and one that scopes by
 * `req.user.id` sees an empty business.
 */
function fileResolvesSupplier(source) {
  const use = source.match(/^router\.use\((.*)\);?\s*$/m);
  return Boolean(use && use[1].includes('resolveSupplier'));
}

/** Every `router.<method>('<path>', …)` statement, in file order. */
function routeStatements(file) {
  const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const lines = source.split('\n');
  const statements = [];
  const guard = fileGuard(source);
  const supplierIsFileLevel = fileResolvesSupplier(source);

  lines.forEach((line, index) => {
    const match = line.match(/^router\.(get|post|patch|put|delete)\(\s*'([^']+)'/);
    if (!match) return;

    // A statement can wrap; take it whole so a guard on the next line counts.
    let statement = line;
    let end = index;
    while (!statement.includes(');') && end + 1 < lines.length) {
      end += 1;
      statement += `\n${lines[end]}`;
    }

    statements.push({
      file,
      line: index + 1,
      method: match[1].toUpperCase(),
      path: match[2],
      statement,
      fileGuard: guard,
      supplierIsFileLevel,
      isSupplierRouter: SUPPLIER_ROUTE_FILES.includes(file),
    });
  });

  return statements;
}

const ALL_STATEMENTS = ROUTE_FILES.flatMap(routeStatements);

/** Jest's expect takes one argument, so the location goes in the failure text. */
function expectGuard(statement, guard) {
  const where = `${statement.file}:${statement.line} ${statement.method} ${statement.path}`;
  if (!statement.statement.includes(guard)) {
    throw new Error(`${where} is missing ${guard}`);
  }
}

const find = (routePath, method) =>
  ALL_STATEMENTS.find((s) => s.path === routePath && s.method === method);

const guardsOn = ({ statement }) => GUARDS.filter((guard) => statement.includes(`${guard}(`));

describe('supplier route guards', () => {
  it('found the route tables it is meant to audit', () => {
    expect(ALL_STATEMENTS.length).toBeGreaterThan(50);
  });

  it('guards every write, unless the statement is on the allowlist', () => {
    const unguarded = ALL_STATEMENTS
      .filter((s) => s.isSupplierRouter)
      .filter((s) => s.method !== 'GET')
      .filter((s) => guardsOn(s).length === 0)
      .filter((s) => !s.fileGuard)
      .filter((s) => !ALLOWED_WITHOUT_GUARD.some((a) => a.path === s.path));

    expect(unguarded.map((s) => `${s.file}:${s.line} ${s.method} ${s.path}`)).toEqual([]);
  });

  it('keeps every allowlisted write justified', () => {
    const unjustified = ALLOWED_WITHOUT_GUARD.filter((entry) => !entry.reason).map((e) => e.path);
    expect(unjustified).toEqual([]);
  });

  it.each(MONEY_READS)('requires $key on the money read $path', ({ path: routePath, key }) => {
    // Africa does not proxy every finance endpoint; only assert what it serves.
    const statement = find(routePath, 'GET');
    if (!statement) return;

    expectGuard(statement, `requireTeamPermission('${key}')`);
  });

  it.each(MONEY_WRITES)('requires $key on the money write $method $path', ({ path: routePath, method, key }) => {
    const statement = find(routePath, method.toUpperCase());
    if (!statement) return;

    expectGuard(statement, `requireTeamPermission('${key}')`);
  });

  it('never authorises a supplier route by the caller\'s own roles', () => {
    // `restrictTo('supplier')` reads req.user.roles, and a team member's own
    // account carries ['customer'] — the supplier they work for is reached
    // through the membership, not through their roles. The Bookings page is
    // rewritten into these brand namespaces by BOTH dashboards, so this made the
    // page an empty screen with a "You do not have permission" toast, for every
    // member, on both brands: indistinguishable from "this supplier has no
    // bookings", which is how it survived a full role audit.
    const offenders = ALL_STATEMENTS
      .filter((s) => /restrictTo\(\s*'supplier'/.test(s.statement))
      .map((s) => `${s.file}:${s.line} ${s.method} ${s.path}`);

    expect(offenders).toEqual([]);
  });

  it('resolves the supplier through the membership on every supplier-scoped route', () => {
    // Without this the route answers 200/404 against the CALLER's own account,
    // which owns no tours: an empty page rather than an error.
    const unresolved = ALL_STATEMENTS
      .filter((s) => /^\/supplier(\/|$)/.test(s.path))
      .filter((s) => !s.supplierIsFileLevel)
      .filter((s) => !/\bresolveSupplier\b/.test(s.statement))
      .map((s) => `${s.file}:${s.line} ${s.method} ${s.path}`);

    expect(unresolved).toEqual([]);
  });

  it.each([
    ['/supplier/bookings', 'GET', 'bookings.view'],
    ['/supplier/bookings/:id/status', 'PATCH', 'bookings.manage'],
  ])('serves %s %s under %s in every brand storefront', (routePath, method, key) => {
    // All three brands serve the supplier's bookings, so a guard that only
    // exists in one of them is a live bug on the other two.
    const statements = ALL_STATEMENTS.filter((s) => s.path === routePath && s.method === method);

    expect(statements.map((s) => s.file).sort()).toEqual([
      'src/brands/africa/routes.js',
      'src/brands/expedition/routes.js',
      'src/brands/ghana/routes.js',
    ]);
    statements.forEach((statement) => expectGuard(statement, `requireTeamPermission('${key}')`));
  });

  it('never gates a whole router on a key no role grants', () => {
    // The Special Offers API was mounted behind requireTeamPermission
    // ('tours.manage') — a key no role has, so the page was unreachable for every
    // member while the dashboards listed it for editors.
    const bogus = ROUTE_FILES
      .map((file) => ({ file, guard: fileGuard(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')) }))
      .filter(({ guard }) => guard && guard !== '*' && !grantedKeys.has(guard))
      .map(({ file, guard }) => `${file} gates every route on '${guard}', which no role grants`);

    expect(bogus).toEqual([]);
  });

  it('never guards a money write with the read key', () => {
    const offenders = ALL_STATEMENTS
      .filter((s) => s.method !== 'GET')
      .filter((s) => /payout|earnings|finance|charge/i.test(s.path))
      .filter((s) => s.statement.includes("requireTeamPermission('payouts.view')"));

    expect(offenders.map((s) => `${s.file}:${s.line} ${s.method} ${s.path}`)).toEqual([]);
  });
});
