/**
 * The supplier bookings query (`GET /api/travioghana/supplier/bookings`).
 *
 * The page is the supplier's highest-frequency workflow, and its filters used
 * to be decorative: `search` and the two date ranges were filtered in the
 * browser over whichever rows the current page happened to hold, so a match on
 * page 2 looked like it did not exist and the date pickers wrote to state the
 * request never read. Everything now travels to the database, and the stat
 * cards come back as server-side counts over the WHOLE result set rather than
 * the 25 rows on screen.
 *
 * These tests assert the `where` clause the controller builds and the summary
 * it returns — the two things a mocked-enough-to-be-useless test cannot see.
 */
jest.mock('../../src/core/services/prismaClient', () => ({
  booking: {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({}),
    count: jest.fn().mockResolvedValue(0),
    aggregate: jest.fn().mockResolvedValue({ _sum: { grossAmount: 0, supplierPayout: 0 }, _count: 0 }),
    groupBy: jest.fn().mockResolvedValue([]),
  },
  supplierProfile: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) },
}));

jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/queue', () => ({
  enqueueEvent: jest.fn(() => Promise.resolve()),
  enqueueEmail: jest.fn(() => Promise.resolve()),
  enqueueNotification: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/emailService', () => ({
  sendEmail: jest.fn(() => Promise.resolve()),
  resolveEmailBrand: jest.fn(() => 'ghana'),
  sendSupplierCustomerCancelledFreeEmail: jest.fn(() => Promise.resolve()),
  sendSupplierCustomerCancelledLateEmail: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/discordNotifier', () => ({ notifyDiscord: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/bookingHelpers', () => ({
  validateTravelerInfo: jest.fn(),
  generateBookingNumber: jest.fn(),
  evaluateCancellationPolicy: jest.fn(() => ({ allowed: true, refundAmount: 0 })),
  isValidEmail: jest.fn(() => true),
}));
jest.mock('../../src/core/services/tourHelpers', () => ({
  checkTourAvailability: jest.fn(),
  calculateTourPrice: jest.fn(),
  cheapestRetailPrice: jest.fn(() => 50),
}));
jest.mock('../../src/core/services/stripeHelpers', () => ({
  createPaymentIntent: jest.fn(),
  createCheckoutSession: jest.fn(),
  createCustomCheckoutPaymentIntent: jest.fn(),
  createCustomerSession: jest.fn(),
  calculateCommission: jest.fn(),
  createRefund: jest.fn(),
  ensureStripeCustomer: jest.fn(async (user) => user?.stripeCustomerId || null),
  getStripe: jest.fn(() => ({})),
}));
jest.mock('../../src/core/services/getConfig', () => jest.fn((key, def) => Promise.resolve(def)));
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/checkoutHold', () => ({ acquireHold: jest.fn(), releaseHold: jest.fn(), HOLD_MINUTES: 30 }));
jest.mock('../../src/core/services/cancellationRequestService', () => ({
  pendingRequestsForBookingIds: jest.fn(async () => new Map()),
}));

const prisma = require('../../src/core/services/prismaClient');
const controller = require('../../src/brands/ghana/controller');

async function invoke(query = {}) {
  const req = { supplierId: 'supplier-1', query, user: { id: 'user-1' } };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  await controller.getSupplierBookings(req, res, next);
  return {
    next,
    status: res.status.mock.calls[0]?.[0],
    payload: res.json.mock.calls[0]?.[0]?.data,
  };
}

const whereUsed = () => prisma.booking.findMany.mock.calls[0][0].where;

beforeEach(() => {
  jest.clearAllMocks();
  prisma.booking.findMany.mockResolvedValue([]);
  prisma.booking.count.mockResolvedValue(0);
  prisma.booking.aggregate.mockResolvedValue({ _sum: { grossAmount: 0, supplierPayout: 0 }, _count: 0 });
  prisma.booking.groupBy.mockResolvedValue([]);
  prisma.supplierProfile.findUnique.mockResolvedValue({ status: 'ACTIVE' });
});

describe('server-side filters', () => {
  it('scopes every query to the acting supplier and hides simulated rows', async () => {
    await invoke();

    expect(whereUsed()).toMatchObject({
      tour: { supplierId: 'supplier-1' },
      isSimulated: false,
    });
  });

  it('searches booking number, customer name, customer email and tour title', async () => {
    await invoke({ search: 'kwa' });

    expect(whereUsed().OR).toEqual([
      { bookingNumber: { contains: 'kwa', mode: 'insensitive' } },
      { customer: { name: { contains: 'kwa', mode: 'insensitive' } } },
      { customer: { email: { contains: 'kwa', mode: 'insensitive' } } },
      { tour: { title: { contains: 'kwa', mode: 'insensitive' } } },
    ]);
  });

  it('applies the purchase-date range to createdAt, whole days inclusive', async () => {
    await invoke({ purchaseFrom: '2026-10-01', purchaseTo: '2026-10-31' });

    const range = whereUsed().createdAt;
    expect(range.gte.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    // The end date is the supplier's whole last day, not midnight of it.
    expect(range.lte.toISOString()).toBe('2026-10-31T23:59:59.999Z');
  });

  it('applies the activity-date range to travelDate', async () => {
    await invoke({ activityFrom: '2026-11-01', activityTo: '2026-11-30' });

    const range = whereUsed().travelDate;
    expect(range.gte.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(range.lte.toISOString()).toBe('2026-11-30T23:59:59.999Z');
  });

  it('rejects a range whose start is after its end', async () => {
    const { next, status } = await invoke({ purchaseFrom: '2026-11-30', purchaseTo: '2026-11-01' });

    expect(status).toBeUndefined();
    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
  });
});

describe('the detail endpoint behind the panel', () => {
  it('404s for a booking on someone else’s tour', async () => {
    prisma.booking.findFirst.mockResolvedValue(null);

    const req = { supplierId: 'supplier-1', params: { id: 'b-foreign' }, user: { id: 'user-1' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    await controller.getSupplierBookingDetail(req, res, next);

    expect(next.mock.calls[0][0].statusCode).toBe(404);
    expect(res.json).not.toHaveBeenCalled();
  });

  it('returns the booking with its offer and review, scoped to the acting supplier', async () => {
    const row = {
      id: 'b-1',
      bookingNumber: 'TRG-1',
      status: 'CONFIRMED',
      grossAmount: 420,
      currency: 'USD',
      customer: { id: 'u-1', name: 'Kwame', email: 'kwame@example.com' },
      tour: { id: 't-1', title: 'Shai Hills Safari' },
      appliedOffer: { id: 'o-1', name: 'Early bird', offerType: 'EARLY_BIRD', discountType: 'PERCENTAGE', discountPercentage: 10 },
      review: { id: 'r-1', rating: 5, comment: 'Brilliant morning' },
    };
    prisma.booking.findFirst.mockResolvedValue(row);

    const req = { supplierId: 'supplier-1', params: { id: 'b-1' }, user: { id: 'user-1' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    await controller.getSupplierBookingDetail(req, res, next);

    expect(next).not.toHaveBeenCalled();
    // Scoped exactly like the list: a supplier can only open their own rows.
    expect(prisma.booking.findFirst.mock.calls[0][0].where).toEqual({
      id: 'b-1',
      tour: { supplierId: 'supplier-1' },
    });
    const payload = res.json.mock.calls[0][0].data.booking;
    expect(payload.review).toMatchObject({ rating: 5, comment: 'Brilliant morning' });
    expect(payload.appliedOffer).toMatchObject({ name: 'Early bird', discountPercentage: 10 });
    // The customer's real inbox never reaches a supplier payload. What comes
    // back is the relay address (or blank when none can be minted) — never
    // the address itself.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('kwame@example.com');
    expect(payload.customer.email === '' || /^c-[0-9a-f]{16}@/.test(payload.customer.email)).toBe(true);
  });
});

describe('the CSV export', () => {
  async function invokeExport(query = {}) {
    const req = { supplierId: 'supplier-1', query, user: { id: 'user-1' } };
    const res = {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      send: jest.fn(),
      json: jest.fn(),
    };
    const next = jest.fn();
    await controller.exportSupplierBookings(req, res, next);
    return { next, res, body: res.send.mock.calls[0]?.[0] || '' };
  }

  it('filters exactly like the list, so the file cannot disagree with the screen', async () => {
    await invoke({ search: 'Ama', status: 'CONFIRMED', activityFrom: '2026-11-01' });

    const where = prisma.booking.findMany.mock.calls[0][0].where;
    expect(where.OR).toBeDefined();
    expect(where.status).toBe('CONFIRMED');
    expect(where.travelDate.gte.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('quotes cells that would break the row', async () => {
    prisma.booking.findMany.mockResolvedValue([
      {
        bookingNumber: 'TRG-1',
        source: 'GHANA',
        status: 'CONFIRMED',
        paymentStatus: 'SUCCEEDED',
        paymentTiming: 'now',
        createdAt: new Date('2026-10-01T09:00:00.000Z'),
        travelDate: new Date('2026-11-04T00:00:00.000Z'),
        selectedTime: '09:00',
        travelers: { adults: 2 },
        leadTravelerName: 'Ama, "Bee"',
        leadTravelerEmail: 'ama@example.test',
        leadTravelerPhone: '',
        subtotal: 420,
        discounts: 20,
        grossAmount: 400,
        currency: 'USD',
        specialRequests: 'Window seat,\nplease',
        supplierNotes: '',
        customer: { name: 'Ama, "Bee"', email: 'ama@example.test', phone: '' },
        tour: { title: 'Shai Hills Safari' },
      },
    ]);
    prisma.booking.count.mockResolvedValue(1);

    const { body } = await invokeExport();

    // A name containing a comma and quotes must not split into two columns.
    expect(body).toContain('"Ama, ""Bee"""');
    expect(body).toContain('"Window seat,\nplease"');
    expect(body).toContain('TRG-1,');
  });

  it('says the file was truncated instead of being silently short', async () => {
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.booking.count.mockResolvedValue(8000);

    const { body } = await invokeExport();

    expect(body).toContain('stopped at 5000 of 8000 matching bookings');
  });

  it('names the file and never caches it', async () => {
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.booking.count.mockResolvedValue(0);

    const { res } = await invokeExport();

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      expect.stringMatching(/attachment; filename="travio-bookings-\d{4}-\d{2}-\d{2}\.csv"/),
    );
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });
});

describe('the summary the stat cards read', () => {
  it('counts statuses over the whole result set, not the current page', async () => {
    prisma.booking.count.mockResolvedValue(812);
    prisma.booking.aggregate.mockResolvedValue({ _sum: { grossAmount: 5400, supplierPayout: 4590 }, _count: 812 });
    prisma.booking.groupBy.mockResolvedValue([
      { status: 'CONFIRMED', _count: { _all: 400 } },
      { status: 'COMPLETED', _count: { _all: 380 } },
      { status: 'CANCELLED', _count: { _all: 32 } },
    ]);

    const { payload } = await invoke({ page: 3, limit: 25 });

    expect(payload.summary.counts).toEqual({ CONFIRMED: 400, COMPLETED: 380, CANCELLED: 32 });
    expect(payload.summary.totalBookings).toBe(812);
    expect(payload.summary.totalRevenue).toBe(5400);
    expect(payload.pagination).toMatchObject({ currentPage: 3, totalCount: 812, limit: 25 });
  });

  it('runs the counts against the same filters as the list', async () => {
    prisma.booking.groupBy.mockResolvedValue([{ status: 'PENDING', _count: { _all: 4 } }]);

    const { payload } = await invoke({ search: 'Ama', status: 'PENDING' });

    const where = prisma.booking.groupBy.mock.calls[0][0].where;
    expect(where.OR).toBeDefined();
    expect(where.status).toBe('PENDING');
    expect(payload.summary.counts).toEqual({ PENDING: 4 });
  });
});
