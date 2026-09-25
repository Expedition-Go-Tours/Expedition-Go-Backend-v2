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

const ROUTE_FILES = [
  'routes/supplierRoutes.js',
  'src/brands/ghana/supplierRoutes.js',
  'src/brands/africa/supplierRoutes.js',
];

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

/** Every `router.<method>('<path>', …)` statement, in file order. */
function routeStatements(file) {
  const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const lines = source.split('\n');
  const statements = [];

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
      .filter((s) => s.method !== 'GET')
      .filter((s) => guardsOn(s).length === 0)
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

  it('never guards a money write with the read key', () => {
    const offenders = ALL_STATEMENTS
      .filter((s) => s.method !== 'GET')
      .filter((s) => /payout|earnings|finance|charge/i.test(s.path))
      .filter((s) => s.statement.includes("requireTeamPermission('payouts.view')"));

    expect(offenders.map((s) => `${s.file}:${s.line} ${s.method} ${s.path}`)).toEqual([]);
  });
});
