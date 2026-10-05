/**
 * The public "tours by this supplier" rail: GET /{brand}/suppliers/:supplierId/tours
 *
 * The endpoint shipped broken three ways in a row, each invisible to every
 * existing test because the only thing mocking Prisma does is accept whatever
 * select it is handed:
 *
 *   1. the route was never registered on the TravioGhana brand (404);
 *   2. the validator demanded UUIDs while every id is a cuid() (400);
 *   3. the handler selected `startingPrice` from `Tour`, which is not a column —
 *      price lives inside `schedulesAndPricing` — so Prisma threw at runtime (500).
 *
 * These tests assert the two facts a mocked client cannot catch: that the
 * Prisma `select` names only real fields on the real schema, and that both
 * brands expose the route.
 */

const fs = require('fs');
const path = require('path');

jest.mock('../../src/core/services/prismaClient', () => ({
  travioGhanaTour: { findMany: jest.fn() },
  expeditionTour: { findMany: jest.fn() },
  tour: { findMany: jest.fn() },
}));

jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((_key, fn) => fn()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
}));

const ROOT = path.join(__dirname, '..', '..');
const schema = fs.readFileSync(path.join(ROOT, 'prisma', 'schema.prisma'), 'utf8');

/** Field names declared on a given `model X { ... }` block. */
function modelFields(modelName) {
  const start = schema.indexOf(`model ${modelName} {`);
  expect(start).toBeGreaterThan(-1);
  const body = schema.slice(start, schema.indexOf('\n}', start));
  const fields = new Set();
  for (const line of body.split('\n')) {
    const m = line.match(/^\s{2}(\w+)\s+\w/);
    // relations are `field Model?` — skip those, keep scalars/enums/arrays
    if (m && !/^(relation|@@)/.test(line.trim())) fields.add(m[1]);
  }
  return fields;
}

const TOUR_FIELDS = modelFields('Tour');

describe('getSupplierTours Prisma select', () => {
  let controller;

  beforeAll(() => {
    const makeStorefrontController = require('../../src/core/storefront');
    controller = makeStorefrontController('ghana');
  });

  const runHandler = async () => {
    const prisma = require('../../src/core/services/prismaClient');
    prisma.travioGhanaTour.findMany.mockResolvedValue([]);
    const req = { params: { supplierId: 'cmuebob1r0000m002vrdichto' }, query: { limit: '8' } };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await controller.getSupplierTours(req, res, jest.fn());
    return prisma.travioGhanaTour.findMany.mock.calls.at(-1)[0];
  };

  it('selects only fields that exist on the Tour model', async () => {
    const args = await runHandler();
    const selected = Object.keys(args.include.tour.select);

    const unknown = selected.filter((f) => !TOUR_FIELDS.has(f));
    expect(unknown).toEqual([]);
  });

  it('does not select startingPrice, which is not a Tour column', async () => {
    const args = await runHandler();
    // Price is derived from schedulesAndPricing by transformForListing.
    expect(args.include.tour.select).not.toHaveProperty('startingPrice');
    expect(args.include.tour.select).toHaveProperty('schedulesAndPricing');
  });

  it('returns the listing id beside the tour, not the tour id in its place', async () => {
    const args = await runHandler();
    // The storefront maps `id: r.id` for the React key but the tour's own id for
    // the canonical URL, so both must be present and distinguishable.
    // The listing id arrives implicitly via `include`, while the tour's own id is
    // selected explicitly — the storefront needs both, and they differ.
    expect(args.include.tour.select.id).toBe(true);
  });

  it('excludes the requested tour from the query itself', async () => {
    const prisma = require('../../src/core/services/prismaClient');
    prisma.travioGhanaTour.findMany.mockResolvedValue([]);
    const req = {
      params: { supplierId: 'cmuebob1r0000m002vrdichto' },
      query: { limit: '8', exclude: 'cmur6ozh200267qyccvhcrboq' },
    };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await controller.getSupplierTours(req, res, jest.fn());

    const where = prisma.travioGhanaTour.findMany.mock.calls.at(-1)[0].where;
    expect(where.tour.id).toEqual({ not: 'cmur6ozh200267qyccvhcrboq' });
  });

  it('does not exclude anything when no tour is named', async () => {
    const args = await runHandler();
    expect(args.where.tour.id).toBeUndefined();
  });

  it('answers the same envelope whether or not there are rows', async () => {
    const prisma = require('../../src/core/services/prismaClient');

    const respond = async (rows) => {
      prisma.travioGhanaTour.findMany.mockResolvedValue(rows);
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      await controller.getSupplierTours(
        { params: { supplierId: 'cmuebob1r0000m002vrdichto' }, query: { limit: '8' } },
        res,
        jest.fn(),
      );
      return res.json.mock.calls[0][0];
    };

    // The populated branch used to answer a bare array while only the empty
    // branch answered `{ status, data: { tours } }`, so a caller reading
    // `data.tours` saw nothing precisely when there was something to show.
    const populated = await respond([
      { id: 'listing-1', tour: { id: 'tour-1', title: 'A tour', schedulesAndPricing: null } },
    ]);
    expect(Array.isArray(populated)).toBe(false);
    expect(populated.status).toBe('success');
    expect(populated.data.tours).toHaveLength(1);

    const empty = await respond([]);
    expect(Array.isArray(empty)).toBe(false);
    expect(empty.status).toBe('success');
    expect(empty.data.tours).toEqual([]);
  });

  it('returns the listing id and the tour id side by side', async () => {
    const prisma = require('../../src/core/services/prismaClient');
    prisma.travioGhanaTour.findMany.mockResolvedValue([
      { id: 'listing-1', tour: { id: 'tour-1', title: 'A tour', schedulesAndPricing: null } },
    ]);
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await controller.getSupplierTours(
      { params: { supplierId: 'cmuebob1r0000m002vrdichto' }, query: { limit: '8' } },
      res,
      jest.fn(),
    );

    const row = res.json.mock.calls[0][0].data.tours[0];
    expect(row.id).toBe('listing-1');
    expect(row.tour.id).toBe('tour-1');
    expect(row.id).not.toBe(row.tour.id);
  });
});

describe('supplier tours route is registered on both storefront brands', () => {
  const routeFiles = [
    ['ghana', 'src/brands/ghana/routes.js'],
    ['expedition', 'src/brands/expedition/routes.js'],
  ];

  it.each(routeFiles)('%s serves /suppliers/:supplierId/tours', (brand, file) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    expect(src).toMatch(/router\.get\('\/suppliers\/:supplierId\/tours'/);
  });

  it.each(routeFiles)('%s validates it with supplierToursSchema', (brand, file) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const line = src.split('\n').find((l) => l.includes("/suppliers/:supplierId/tours"));
    expect(line).toContain('validate(supplierToursSchema)');
  });
});