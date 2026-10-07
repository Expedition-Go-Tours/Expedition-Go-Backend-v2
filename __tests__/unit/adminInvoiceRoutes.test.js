/**
 * The admin invoice route table on every mount surface.
 *
 * The admin Invoices tab never calls the core /api/admin/finance router — the
 * frontend axios rewrite sends /admin/* to /travioghana/admin/* and
 * /travioafrica/admin/*, i.e. the BRAND routers. When those routers were never
 * given the invoice routes, every queue request 404'd while CI stayed green:
 * nothing exercised the brand-scoped path. This test walks the real Express
 * router stacks, so a dropped or unguarded invoice route fails here first.
 *
 * For each surface it asserts:
 *   1. all four endpoints are registered (list, detail, approve, mark-paid);
 *   2. the first middleware on every one of them is a permission gate —
 *      with no user on the request it answers 401, never the controller;
 *   3. the write routes sit behind `payouts.approve`, reads behind
 *      `payouts.view` (checked against the source, since the key list is
 *      closed over by the middleware).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

const ROUTE_SURFACES = [
  { name: 'core /api/admin/finance', file: 'routes/adminFinanceRoutes.js', prefix: '' },
  { name: 'Ghana brand /api/travioghana/admin', file: 'src/brands/ghana/adminRoutes.js', prefix: '/finance' },
  { name: 'Africa brand /api/travioafrica/admin', file: 'src/brands/africa/adminRoutes.js', prefix: '/finance' },
];

const ENDPOINTS = [
  { method: 'get', path: '/invoices', controller: 'getInvoices', write: false },
  { method: 'get', path: '/invoices/:id', controller: 'getInvoiceById', write: false },
  { method: 'patch', path: '/invoices/:id/approve', controller: 'approveInvoice', write: true },
  { method: 'patch', path: '/invoices/:id/mark-paid', controller: 'markInvoicePaid', write: true },
];

/** All route layers (skip router.use middleware), keyed "METHOD /path". */
function routeTable(router) {
  const table = new Map();
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const [method, on] of Object.entries(layer.route.methods)) {
      if (on) table.set(`${method.toUpperCase()} ${layer.route.path}`, layer.route);
    }
  }
  return table;
}

describe.each(ROUTE_SURFACES)('invoice routes on $name', (surface) => {
  const router = require(path.join(ROOT, surface.file));
  const source = fs.readFileSync(path.join(ROOT, surface.file), 'utf8');

  it.each(ENDPOINTS)('registers $method $path and gates it first', (endpoint) => {
    const table = routeTable(router);
    const key = `${endpoint.method.toUpperCase()} ${surface.prefix}${endpoint.path}`;
    const route = table.get(key);

    expect(route).toBeDefined(); // missing route == the 404 this guards against

    // The permission gate must be FIRST: with no user the controller never runs.
    const first = route.stack[0].handle;
    const next = jest.fn();
    const done = first({}, {}, next);
    if (done && typeof done.then === 'function') return done.then(() => {
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    });
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    return undefined;
  });

  it.each(ENDPOINTS)('wires $controller behind its permission key', (endpoint) => {
    // The statement for this controller must sit right behind its guard:
    // payouts.approve for writes, payouts.view for reads.
    const key = endpoint.write ? 'payouts\\.approve' : 'payouts\\.view';
    const statement = new RegExp(
      `requirePermission\\(('${key}'|'${key}',\\s*'[^']*')\\)[\\s\\S]{0,120}adminFinanceController\\.${endpoint.controller}\\b`
    );
    expect(source).toMatch(statement);
  });
});
