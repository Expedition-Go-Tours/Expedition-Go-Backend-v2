/**
 * Guards every Prisma query the finance controllers build against the real
 * schema. See __tests__/helpers/prismaQueryGuard.js for why.
 *
 * The short version: the rest of this suite mocks Prisma, so it can prove what
 * a controller *does* with rows but never that the query it wrote is one
 * Prisma accepts. That is how `imageCover` — a field that has never existed on
 * `Tour` (it is `coverPhoto`) — shipped on the invoice detail and PDF
 * endpoints and 500'd every supplier who opened an invoice in production.
 *
 * These tests do not care about the *rows*. They drive the real controllers
 * against a recording Prisma stub and then validate the shape of every query
 * that was issued. Row-shaped fixtures would only add noise here; the
 * controller issues its queries before it ever reads a result.
 */
jest.mock('../../src/core/services/prismaClient', () => {
  // A recording stand-in: every call is captured for later validation, and
  // returns a value permissive enough for the controller to run to completion.
  const queries = [];
  const MODEL_NAMES = [
    'Invoice', 'InvoiceItem', 'Booking', 'PayoutRequest', 'PayoutRequestItem',
    'Payout', 'PayoutMethod', 'SupplierProfile', 'SupplierCharge', 'Dispute',
    'Tour', 'User', 'Notification',
  ];
  const client = { __queries: queries };
  for (const name of MODEL_NAMES) {
    const key = name[0].toLowerCase() + name.slice(1);
    client[key] = {};
    for (const method of ['findMany', 'findFirst', 'findUnique', 'aggregate', 'count', 'groupBy', 'create', 'update']) {
      client[key][method] = jest.fn(async (args) => {
        queries.push({ model: name, method, args });
        if (method === 'findMany' || method === 'groupBy') return [];
        if (method === 'count') return 0;
        if (method === 'aggregate') return { _sum: {}, _avg: {}, _count: 0 };
        return null;
      });
    }
  }
  client.$transaction = jest.fn(async (fn) => (Array.isArray(fn) ? [] : fn(client)));
  return client;
});

jest.mock('../../src/core/services/getConfig', () => jest.fn());
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/core/services/queue', () => ({
  enqueueNotification: jest.fn().mockResolvedValue(undefined),
  enqueueEmail: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/core/services/adminNotificationService', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../../src/core/services/discordNotifier', () => ({ notifyDiscord: jest.fn() }));
jest.mock('../../src/core/services/channelEmbeds', () => ({
  approvalPayoutRequest: jest.fn(() => ({ content: 'embed', opts: {} })),
}));
jest.mock('../../src/core/services/invoicePdf', () => ({ renderInvoicePdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4')) }));
jest.mock('../../src/core/services/payoutCycles', () => ({
  getRequestWindow: jest.fn(),
  getCurrentCycle: jest.fn(() => ({ start: new Date(2026, 9, 1), end: new Date(2026, 9, 15), label: 'Oct 1–15' })),
  getClearanceBufferDays: jest.fn(() => 7),
  formatCycleLabel: jest.fn(() => 'Oct 1–15'),
}));
jest.mock('../../src/core/services/payoutRuns', () => ({
  getSupplierPayoutPlan: jest.fn(),
  getSupplierRequestWindow: jest.fn(),
  resolvePayoutMethod: jest.fn(),
  selectEligibleBookings: jest.fn(),
  createRequestsForBookings: jest.fn(),
  notifyPayoutRequestsCreated: jest.fn().mockResolvedValue(undefined),
}));

const prisma = require('../../src/core/services/prismaClient');
const supplier = require('../../src/core/domain/financeController');
const admin = require('../../src/core/domain/adminFinanceController');
const { assertQueryShape, PrismaQueryShapeError } = require('../helpers/prismaQueryGuard');

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn(), setHeader: jest.fn(), send: jest.fn(), end: jest.fn() };
}

/** Drain the recorder, validate every query, reset it for the next call. */
function assertRecordedQueriesValid(label) {
  const captured = [...prisma.__queries];
  prisma.__queries.length = 0;
  const failures = [];
  for (const q of captured) {
    try {
      assertQueryShape(q.model, q.args, `${q.model}.${q.method}`);
    } catch (err) {
      if (err instanceof PrismaQueryShapeError) failures.push(err.message);
      else throw err;
    }
  }
  if (failures.length) {
    throw new Error(`${label} issued invalid Prisma queries:\n  - ${failures.join('\n  - ')}`);
  }
  return captured.length;
}

beforeEach(() => {
  jest.clearAllMocks();
  prisma.__queries.length = 0;
});

describe('finance controllers — every Prisma query matches the real schema', () => {
  const supplierReq = (extra = {}) => ({ supplierId: 'sup1', query: {}, params: {}, body: {}, ...extra });

  it('getMyInvoices — unfiltered', async () => {
    await supplier.getMyInvoices(supplierReq(), makeRes(), jest.fn());
    expect(assertRecordedQueriesValid('getMyInvoices')).toBeGreaterThan(0);
  });

  it.each(['INVOICED', 'APPROVED', 'PAID', 'CANCELLED'])('getMyInvoices — status=%s', async (status) => {
    await supplier.getMyInvoices(supplierReq({ query: { status } }), makeRes(), jest.fn());
    assertRecordedQueriesValid(`getMyInvoices(status=${status})`);
  });

  it('getMyInvoices — pagination and sort', async () => {
    await supplier.getMyInvoices(supplierReq({ query: { page: '2', limit: '50', sortBy: 'invoicedAt', sortOrder: 'asc' } }), makeRes(), jest.fn());
    assertRecordedQueriesValid('getMyInvoices(paged)');
  });

  it('getInvoiceById — the query that 500’d in production', async () => {
    // This is the exact shape that failed: nested tour select under the
    // invoice's line items. It used to name `imageCover`, which does not
    // exist on Tour.
    await supplier.getInvoiceById(supplierReq({ params: { id: 'inv1' } }), makeRes(), jest.fn());
    assertRecordedQueriesValid('getInvoiceById');
  });

  it('downloadInvoicePdf — same include shape as the detail endpoint', async () => {
    await supplier.downloadInvoicePdf(supplierReq({ params: { id: 'inv1' } }), makeRes(), jest.fn());
    assertRecordedQueriesValid('downloadInvoicePdf');
  });

  it('getEarnings — with every filter combination the page can build', async () => {
    for (const query of [
      {},
      { page: '3', limit: '100' },
      { payoutStatus: 'ELIGIBLE,PENDING' },
      { currency: 'USD' },
      { payoutStatus: 'REQUESTED', currency: 'GHS', page: '1' },
    ]) {
      prisma.__queries.length = 0;
      await supplier.getEarnings(supplierReq({ query }), makeRes(), jest.fn());
      assertRecordedQueriesValid(`getEarnings(${JSON.stringify(query)})`);
    }
  });

  it('getFinanceSummary', async () => {
    await supplier.getFinanceSummary(supplierReq(), makeRes(), jest.fn());
    assertRecordedQueriesValid('getFinanceSummary');
  });

  it('getDisputes — with and without a status filter', async () => {
    await supplier.getDisputes(supplierReq(), makeRes(), jest.fn());
    assertRecordedQueriesValid('getDisputes');
    await supplier.getDisputes(supplierReq({ query: { status: 'OPEN' } }), makeRes(), jest.fn());
    assertRecordedQueriesValid('getDisputes(status)');
  });

  it('getSupplierCharges', async () => {
    await supplier.getSupplierCharges(supplierReq(), makeRes(), jest.fn());
    assertRecordedQueriesValid('getSupplierCharges');
  });

  it('getPayoutRequests — with and without a status filter', async () => {
    await supplier.getPayoutRequests(supplierReq(), makeRes(), jest.fn());
    assertRecordedQueriesValid('getPayoutRequests');
    await supplier.getPayoutRequests(supplierReq({ query: { status: 'PENDING' } }), makeRes(), jest.fn());
    assertRecordedQueriesValid('getPayoutRequests(status)');
  });

  it('getPayoutRequestById', async () => {
    await supplier.getPayoutRequestById(supplierReq(), makeRes(), jest.fn());
    assertRecordedQueriesValid('getPayoutRequestById');
  });

  it('getPayoutSettings', async () => {
    await supplier.getPayoutSettings(supplierReq(), makeRes(), jest.fn());
    assertRecordedQueriesValid('getPayoutSettings');
  });
});

describe('admin finance controllers — every Prisma query matches the real schema', () => {
  const adminReq = (extra = {}) => ({ supplierId: 'sup1', query: {}, params: { id: 'inv1' }, body: {}, user: { id: 'admin1', email: 'a@b.c' }, ...extra });

  it('getInvoices — the admin invoice queue, unfiltered', async () => {
    await admin.getInvoices(adminReq(), makeRes(), jest.fn());
    assertRecordedQueriesValid('admin.getInvoices');
  });

  it.each(['INVOICED', 'APPROVED', 'PAID', 'CANCELLED'])('getInvoices — status=%s', async (status) => {
    await admin.getInvoices(adminReq({ query: { status } }), makeRes(), jest.fn());
    assertRecordedQueriesValid(`admin.getInvoices(status=${status})`);
  });

  it('getInvoices — sorting by each sortable column', async () => {
    for (const sortBy of ['invoicedAt', 'netTotal', 'status', 'invoiceNumber']) {
      prisma.__queries.length = 0;
      await admin.getInvoices(adminReq({ query: { sortBy, sortOrder: 'asc' } }), makeRes(), jest.fn());
      assertRecordedQueriesValid(`admin.getInvoices(sortBy=${sortBy})`);
    }
  });

  it('getInvoiceById', async () => {
    await admin.getInvoiceById(adminReq(), makeRes(), jest.fn());
    assertRecordedQueriesValid('admin.getInvoiceById');
  });

  it('approveInvoice', async () => {
    await admin.approveInvoice(adminReq(), makeRes(), jest.fn());
    assertRecordedQueriesValid('admin.approveInvoice');
  });

  it('markInvoicePaid', async () => {
    await admin.markInvoicePaid(adminReq({ body: { reference: 'REF-1' } }), makeRes(), jest.fn());
    assertRecordedQueriesValid('admin.markInvoicePaid');
  });
});

describe('the guard itself', () => {
  it('rejects a select on a field Tour has never had', () => {
    expect(() =>
      assertQueryShape('Invoice', {
        include: { items: { include: { booking: { select: { tour: { select: { imageCover: true } } } } } } },
      }, 'regression')
    ).toThrow(/unknown field `imageCover`.*Tour/s);
  });

  it('accepts the corrected field name', () => {
    expect(() =>
      assertQueryShape('Invoice', {
        include: { items: { include: { booking: { select: { tour: { select: { id: true, title: true, coverPhoto: true } } } } } } },
      }, 'regression')
    ).not.toThrow();
  });

  it('reports the full path to the bad field', () => {
    expect(() =>
      assertQueryShape('Invoice', {
        include: { items: { include: { booking: { select: { tour: { select: { imageCover: true } } } } } } },
      }, 'detail')
    ).toThrow(/include\.items\.include\.booking\.select\.tour\.select\.imageCover/);
  });

  it('rejects an unknown field in where', () => {
    expect(() => assertQueryShape('Invoice', { where: { notAField: 1 } }, 'w'))
      .toThrow(/unknown field `notAField` in where/);
  });

  it('rejects an unknown field in orderBy', () => {
    expect(() => assertQueryShape('Invoice', { orderBy: { notAField: 'asc' } }, 'o'))
      .toThrow(/unknown field `notAField` in orderBy/);
  });

  it('accepts a relation filter without treating operator keys as fields', () => {
    expect(() =>
      assertQueryShape('Booking', { where: { tour: { is: { supplierId: 's1' } } }, include: { tour: true } }, 'rel')
    ).not.toThrow();
  });

  it('accepts an aggregate with _count select', () => {
    expect(() =>
      assertQueryShape('Invoice', { select: { id: true, _count: { select: { items: true } } } }, 'agg')
    ).not.toThrow();
  });
});
