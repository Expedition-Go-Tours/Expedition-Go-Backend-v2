/**
 * Supplier-created bookings: the financial boundaries.
 *
 * The feature is only trustworthy if four things stay true, and each has a
 * test here:
 *
 *  1. OFFLINE MONEY IS NOT PLATFORM MONEY. A supplier who says "she paid cash"
 *     must never turn `paymentStatus` into SUCCEEDED — that value is what the
 *     payout pipeline trusts.
 *  2. IT NEVER ENTERS PAYOUT ELIGIBILITY. The supplier already holds the cash;
 *     paying it out again would pay them twice.
 *  3. RETRIES CANNOT DOUBLE-COUNT. The same idempotency key = one booking, one
 *     collection, one commission charge.
 *  4. COMMISSION IS THE PLATFORM'S DECISION, not the supplier's, and it
 *     follows money actually collected — never an unpaid reservation.
 */
jest.mock('../../src/core/services/prismaClient', () => ({
  tour: { findUnique: jest.fn() },
  booking: { create: jest.fn(), findUnique: jest.fn() },
  bookingGuest: { create: jest.fn() },
  bookingCollection: { create: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  bookingIdempotencyKey: { findUnique: jest.fn(), upsert: jest.fn() },
  supplierCharge: { create: jest.fn() },
  bookingCounter: { upsert: jest.fn() },
  $transaction: jest.fn((fn) => fn(globalThis.__tx)),
  $queryRawUnsafe: jest.fn(),
}));
jest.mock('../../src/core/services/tourHelpers', () => ({
  calculateTourPrice: jest.fn(),
}));
jest.mock('../../src/core/services/stripeHelpers', () => ({
  calculateCommission: jest.fn(),
}));
jest.mock('../../src/core/services/availabilityCore', () => ({
  evaluateBookingAvailability: jest.fn(),
}));
jest.mock('../../src/core/services/bookingHelpers', () => ({
  generateBookingNumber: jest.fn(),
}));
jest.mock('../../src/core/services/getConfig', () => jest.fn());
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/queue', () => ({
  enqueueEmail: jest.fn(() => Promise.resolve()),
  enqueueNotification: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const prisma = require('../../src/core/services/prismaClient');
const { calculateTourPrice } = require('../../src/core/services/tourHelpers');
const { calculateCommission } = require('../../src/core/services/stripeHelpers');
const { evaluateBookingAvailability } = require('../../src/core/services/availabilityCore');
const { generateBookingNumber } = require('../../src/core/services/bookingHelpers');
const getConfig = require('../../src/core/services/getConfig');
const { logActivity } = require('../../src/core/services/auditLogger');
const supplierBookingService = require('../../src/core/services/supplierBookingService');

const SUPPLIER = 'supplier-1';
const ACTOR = 'actor-1';

const tour = {
  id: 'tour-1',
  supplierId: SUPPLIER,
  title: 'Shai Hills Safari',
  schedulesAndPricing: { pricingSchedules: { currency: 'USD' } },
  supplier: { id: SUPPLIER, name: 'Expedition Go' },
};

const baseInput = {
  supplierId: SUPPLIER,
  actorId: ACTOR,
  brandKey: 'ghana',
  tourId: 'tour-1',
  travelDate: '2026-11-04',
  selectedTime: '09:00',
  travelers: { adults: 2 },
  guest: { name: 'Kwame Mensah', phone: '+233201111111', email: 'kwame@example.com' },
  idempotencyKey: 'idem-key-0001',
};

beforeEach(() => {
  jest.clearAllMocks();
  globalThis.__tx = {
    tour: { findUnique: jest.fn().mockResolvedValue(tour) },
    booking: prisma.booking,
    bookingGuest: prisma.bookingGuest,
    bookingCollection: prisma.bookingCollection,
    bookingIdempotencyKey: prisma.bookingIdempotencyKey,
    supplierCharge: prisma.supplierCharge,
    bookingCounter: prisma.bookingCounter,
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 'tour-1' }]),
  };
  getConfig.mockImplementation(async (key, def) => {
    if (key === 'feature.supplierCreatedBookings.ghana') return 'true';
    return def;
  });
  calculateTourPrice.mockResolvedValue({ success: true, subtotal: 400, discount: 0, total: 400, currency: 'USD' });
  calculateCommission.mockResolvedValue({ rate: 0.15, amount: 60, supplierPayout: 340 });
  evaluateBookingAvailability.mockResolvedValue({ ok: true });
  generateBookingNumber.mockResolvedValue('TRA-1-2026-01');
  prisma.bookingIdempotencyKey.findUnique.mockResolvedValue(null);
  prisma.bookingGuest.create.mockResolvedValue({ id: 'guest-1' });
  prisma.booking.create.mockResolvedValue({ id: 'b-1', bookingNumber: 'TRA-1-2026-01', currency: 'USD', grossAmount: 400 });
});

describe('the feature flag is a BACKEND control', () => {
  it('refuses creation when disabled, whatever the client sent', async () => {
    getConfig.mockImplementation(async (key, def) =>
      key === 'feature.supplierCreatedBookings.ghana' ? 'false' : def,
    );

    await expect(supplierBookingService.createBooking(baseInput)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });
});

describe('offline money is not platform money', () => {
  it('never sets paymentStatus to SUCCEEDED for a cash booking', async () => {
    await supplierBookingService.createBooking({
      ...baseInput,
      collection: { amount: 400, method: 'CASH' },
    });

    const data = prisma.booking.create.mock.calls[0][0].data;
    expect(data.paymentStatus).toBe('PENDING');
    expect(data.origin).toBe('SUPPLIER_CREATED');
    // The platform collected nothing; its payment fields stay untouched.
    expect(data.stripePaymentIntentId).toBeUndefined();
    expect(data.payoutStatus).toBeUndefined();
  });

  it('records the collection in its own ledger, not on the payment fields', async () => {
    await supplierBookingService.createBooking({
      ...baseInput,
      collection: { amount: 400, method: 'MOBILE_MONEY', externalRef: 'MM-123' },
    });

    const collection = prisma.bookingCollection.create.mock.calls[0][0].data;
    expect(collection.method).toBe('MOBILE_MONEY');
    expect(collection.externalRef).toBe('MM-123');
    expect(Number(collection.amount)).toBe(400);
  });

  it('an unpaid reservation creates no collection at all', async () => {
    await supplierBookingService.createBooking(baseInput);

    expect(prisma.bookingCollection.create).not.toHaveBeenCalled();
    expect(prisma.supplierCharge.create).not.toHaveBeenCalled();
  });
});

describe('idempotency', () => {
  it('replays the original booking for a repeated key and body', async () => {
    const prior = { id: 'b-1', bookingNumber: 'TRA-1-2026-01' };
    // First call: nothing stored yet. The service computes the canonical hash
    // and writes it; the second call replays against that same hash.
    prisma.bookingIdempotencyKey.findUnique.mockResolvedValueOnce(null);
    const first = await supplierBookingService.createBooking(baseInput);
    const hash = prisma.bookingIdempotencyKey.upsert.mock.calls[0][0].create.requestHash;

    prisma.bookingIdempotencyKey.findUnique.mockResolvedValueOnce({
      id: 'idem-1',
      requestHash: hash,
      bookingId: 'b-1',
    });
    prisma.booking.findUnique.mockResolvedValueOnce(prior);

    const second = await supplierBookingService.createBooking(baseInput);

    expect(second.id).toBe('b-1');
    expect(prisma.booking.create).toHaveBeenCalledTimes(1);
  });

  it('conflicts when the same key carries a different request', async () => {
    prisma.bookingIdempotencyKey.findUnique.mockResolvedValue({
      id: 'idem-1',
      requestHash: 'a-different-hash',
      bookingId: 'b-1',
    });

    await expect(supplierBookingService.createBooking(baseInput)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  it('requires a key at all — button disabling is not enough', async () => {
    await expect(
      supplierBookingService.createBooking({ ...baseInput, idempotencyKey: '' }),
    ).rejects.toThrow(/idempotency key/i);
  });
});

describe('guest identity', () => {
  it('creates a guest row for a walk-in and never a user', async () => {
    await supplierBookingService.createBooking(baseInput);

    const guest = prisma.bookingGuest.create.mock.calls[0][0].data;
    expect(guest.name).toBe('Kwame Mensah');
    expect(prisma.booking.create.mock.calls[0][0].data.customerId).toBeNull();
  });

  it('does not attach a booking to an account just because an email matches', async () => {
    await supplierBookingService.createBooking(baseInput);

    // No lookup or upsert of User anywhere: the guest row is the guest row.
    expect(prisma.booking.create.mock.calls[0][0].data.guestId).toBe('guest-1');
    expect(prisma.booking.create.mock.calls[0][0].data.customerId).toBeNull();
  });

  it('requires a name for a walk-in', async () => {
    await expect(
      supplierBookingService.createBooking({ ...baseInput, guest: { name: '' } }),
    ).rejects.toThrow(/guest name/i);
  });
});

describe('commission', () => {
  it('is raised on money actually COLLECTED, not on the booking value', async () => {
    await supplierBookingService.createBooking({
      ...baseInput,
      collection: { amount: 100, method: 'CASH' }, // partial collection
    });

    // The charge is computed from the collection, not from grossAmount.
    expect(calculateCommission).toHaveBeenLastCalledWith(100);
    const charge = prisma.supplierCharge.create.mock.calls[0][0].data;
    expect(charge.reason).toBe('SUPPLIER_COMMISSION');
    expect(charge.status).toBe('OPEN'); // netted off the next payout request
    expect(Number(charge.amount)).toBe(60);
  });

  it('raises no charge for an unpaid reservation', async () => {
    await supplierBookingService.createBooking(baseInput);

    expect(prisma.supplierCharge.create).not.toHaveBeenCalled();
  });

  it('records a waiver instead of a charge when policy says WAIVE', async () => {
    getConfig.mockImplementation(async (key, def) => {
      if (key === 'feature.supplierCreatedBookings.ghana') return 'true';
      if (key === 'feature.supplierCreatedCommissionPolicy') return 'WAIVE';
      return def;
    });

    await supplierBookingService.createBooking({
      ...baseInput,
      collection: { amount: 400, method: 'CASH' },
    });

    const data = prisma.booking.create.mock.calls[0][0].data;
    expect(data.platformCommission).toBe(0);
    expect(data.supplierPayout).toBe(400);
    expect(prisma.supplierCharge.create).not.toHaveBeenCalled();
    // The waiver is part of the audit trail, not silent.
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ commissionPolicy: 'WAIVE' }) }),
    );
  });

  it('never lets the client choose the rate', async () => {
    await supplierBookingService.createBooking({
      ...baseInput,
      collection: { amount: 400, method: 'CASH' },
      commissionRate: 0, // ignored
    });

    expect(calculateCommission).toHaveBeenCalled();
    expect(prisma.supplierCharge.create.mock.calls[0][0].data.amount).toBe(60);
  });
});

describe('collections', () => {
  const collectionRow = (over = {}) => ({
    id: 'c-1',
    bookingId: 'b-1',
    amount: 200,
    currency: 'USD',
    status: 'RECORDED',
    collectedAt: new Date(),
    ...over,
  });

  beforeEach(() => {
    prisma.booking.findUnique.mockResolvedValue({
      id: 'b-1',
      origin: 'SUPPLIER_CREATED',
      grossAmount: 400,
      currency: 'USD',
      tour: { supplierId: SUPPLIER },
    });
    prisma.bookingCollection.findUnique.mockResolvedValue(null);
    prisma.bookingCollection.findMany.mockResolvedValue([]);
    prisma.bookingCollection.create.mockResolvedValue(collectionRow());
    prisma.bookingCollection.update.mockResolvedValue({ id: 'c-0', status: 'REVERSED' });
  });

  it('accepts a partial collection and reports the outstanding balance', async () => {
    prisma.bookingCollection.findMany.mockResolvedValue([collectionRow({ amount: 250 })]);

    await supplierBookingService.recordCollection({
      bookingId: 'b-1', supplierId: SUPPLIER, actorId: ACTOR,
      amount: 150, method: 'CASH', idempotencyKey: 'coll-key-0001',
    });

    const summary = await supplierBookingService.collectionSummary('b-1');
    expect(summary.collected).toBe(250);
    expect(summary.outstanding).toBe(150);
    expect(summary.state).toBe('PARTIAL');
  });

  it('refuses a collection larger than the outstanding balance', async () => {
    await expect(
      supplierBookingService.recordCollection({
        bookingId: 'b-1', supplierId: SUPPLIER, actorId: ACTOR,
        amount: 500, method: 'CASH', idempotencyKey: 'coll-key-0002',
      }),
    ).rejects.toThrow(/outstanding balance/i);
    expect(prisma.bookingCollection.create).not.toHaveBeenCalled();
  });

  it('refuses a refund larger than what was collected', async () => {
    prisma.bookingCollection.findMany.mockResolvedValue([collectionRow({ amount: 100 })]);

    await expect(
      supplierBookingService.recordCollection({
        bookingId: 'b-1', supplierId: SUPPLIER, actorId: ACTOR,
        amount: -250, method: 'CASH', idempotencyKey: 'coll-key-0003',
      }),
    ).rejects.toThrow(/cannot exceed what was collected/i);
  });

  it('replays the same collection on a repeated key instead of double-counting', async () => {
    const existing = collectionRow();
    prisma.bookingCollection.findUnique.mockResolvedValue(existing);

    const row = await supplierBookingService.recordCollection({
      bookingId: 'b-1', supplierId: SUPPLIER, actorId: ACTOR,
      amount: 200, method: 'CASH', idempotencyKey: 'coll-key-0004',
    });

    expect(row.id).toBe('c-1');
    expect(prisma.bookingCollection.create).not.toHaveBeenCalled();
  });

  it('keeps a correction auditable: the original is reversed, not edited', async () => {
    await supplierBookingService.recordCollection({
      bookingId: 'b-1', supplierId: SUPPLIER, actorId: ACTOR,
      amount: 200, method: 'CASH', idempotencyKey: 'coll-key-0005',
      reversesId: 'c-0',
    });

    expect(prisma.bookingCollection.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c-0' }, data: { status: 'REVERSED' } }),
    );
  });

  it('refuses collections on a marketplace booking', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      id: 'b-2',
      origin: 'MARKETPLACE',
      grossAmount: 400,
      currency: 'USD',
      tour: { supplierId: SUPPLIER },
    });

    await expect(
      supplierBookingService.recordCollection({
        bookingId: 'b-2', supplierId: SUPPLIER, actorId: ACTOR,
        amount: 100, method: 'CASH', idempotencyKey: 'coll-key-0006',
      }),
    ).rejects.toThrow(/supplier-created bookings only/i);
  });

  it('refuses a booking that belongs to another supplier', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      id: 'b-3',
      origin: 'SUPPLIER_CREATED',
      grossAmount: 400,
      currency: 'USD',
      tour: { supplierId: 'someone-else' },
    });

    await expect(
      supplierBookingService.recordCollection({
        bookingId: 'b-3', supplierId: SUPPLIER, actorId: ACTOR,
        amount: 100, method: 'CASH', idempotencyKey: 'coll-key-0007',
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
