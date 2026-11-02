/**
 * Supplier refund requests — the money rules.
 *
 * Four things must never be wrong here: the refundable ceiling, the amount
 * charged to the supplier, the fact that a full refund only charges when the
 * payout already left, and the rule that a booking collected outside the
 * platform is never refunded through it.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  $transaction: jest.fn(),
  $queryRawUnsafe: jest.fn(),
  booking: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), aggregate: jest.fn() },
  supplierRefundRequest: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  supplierCharge: { create: jest.fn(), aggregate: jest.fn() },
}));

jest.mock('../../src/core/services/payments', () => ({
  refundBookingPayment: jest.fn(),
}));

jest.mock('../../src/core/services/auditLogger', () => ({
  logActivity: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/emailService', () => ({
  sendSupplierRefundRequestedEmail: jest.fn(() => Promise.resolve()),
  sendSupplierRefundDecisionEmail: jest.fn(() => Promise.resolve()),
  sendRefundCompletedEmail: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/core/services/ga4Measurement', () => ({
  sendRefund: jest.fn(() => Promise.resolve({ ok: true })),
}));

jest.mock('../../src/core/services/financeHelpers', () => ({
  eligibleBookingsWhere: jest.fn(() => ({ payoutStatus: 'ELIGIBLE' })),
}));

const prisma = require('../../src/core/services/prismaClient');
const { refundBookingPayment } = require('../../src/core/services/payments');
const service = require('../../src/core/services/supplierRefundRequest');

const past = new Date(Date.now() - 48 * 3600 * 1000);
const future = new Date(Date.now() + 48 * 3600 * 1000);

const booking = (overrides = {}) => ({
  id: 'b1',
  bookingNumber: 'TRG-1',
  status: 'COMPLETED',
  origin: 'MARKETPLACE',
  travelDate: past,
  paymentStatus: 'SUCCEEDED',
  payoutStatus: 'ELIGIBLE',
  currency: 'USD',
  grossAmount: 151.22,
  refundAmount: null,
  supplierPayout: 120.98,
  stripePaymentIntentId: 'pi_1',
  paypalCaptureId: null,
  ...overrides,
});

const payload = (overrides = {}) => ({
  operated: true,
  attended: true,
  reasonCode: 'SERVICE_QUALITY',
  refundType: 'PERCENT',
  value: 100,
  ...overrides,
});

describe('computePreview — the money', () => {
  it('charges nothing on a full refund the supplier was never paid for', () => {
    // A full refund drops the booking out of payout eligibility, so the
    // supplier already loses their whole share. Charging again would double it.
    const p = service.computePreview(booking(), payload({ value: 100 }));
    expect(p.proposed).toBe(151.22);
    expect(p.isFull).toBe(true);
    expect(p.charge).toBe(0);
  });

  it('recovers the supplier share on a full refund whose payout already left', () => {
    const p = service.computePreview(booking({ payoutStatus: 'PAID' }), payload({ value: 100 }));
    expect(p.isFull).toBe(true);
    expect(p.charge).toBe(120.98);
  });

  it('treats INVOICED and REQUESTED as already settled too', () => {
    for (const s of ['INVOICED', 'REQUESTED']) {
      const p = service.computePreview(booking({ payoutStatus: s }), payload({ value: 100 }));
      expect(p.charge).toBe(120.98);
    }
  });

  it('charges the proportional share on a partial refund', () => {
    // Half the booking refunded → the supplier keeps half of their payout.
    const p = service.computePreview(booking(), payload({ value: 50 }));
    expect(p.proposed).toBe(75.61);
    expect(p.isFull).toBe(false);
    expect(p.charge).toBe(60.49);
  });

  it('keeps a specific amount exact', () => {
    const p = service.computePreview(booking(), payload({ refundType: 'AMOUNT', value: 30 }));
    expect(p.proposed).toBe(30);
    expect(p.charge).toBe(24);
  });

  it('caps a percentage at what is actually left to refund', () => {
    // 100% of a booking already refunded by 100 only lets 51.22 through.
    const p = service.computePreview(booking({ refundAmount: 100 }), payload({ value: 100 }));
    expect(p.refundable).toBe(51.22);
    expect(p.proposed).toBe(51.22);
    expect(p.isFull).toBe(false);
  });

  it('refuses amounts above the ceiling', () => {
    expect(() => service.computePreview(booking(), payload({ refundType: 'AMOUNT', value: 200 })))
      .toThrow(/cannot exceed the refundable balance/i);
  });

  it('refuses a percentage above 100 and a non-positive amount', () => {
    expect(() => service.computePreview(booking(), payload({ value: 120 }))).toThrow(/cannot exceed 100/i);
    expect(() => service.computePreview(booking(), payload({ value: 0 }))).toThrow(/greater than zero/i);
    expect(() => service.computePreview(booking(), payload({ refundType: 'AMOUNT', value: -5 })))
      .toThrow(/greater than zero/i);
  });

  it('refuses an unknown refund type', () => {
    expect(() => service.computePreview(booking(), payload({ refundType: 'FREE' })))
      .toThrow(/refund type/i);
  });
});

describe('eligibility', () => {
  it('accepts a paid, past, platform booking', () => {
    expect(service.eligibilityError(booking())).toBeNull();
  });

  it('never refunds a booking the platform did not collect', () => {
    // Offline money lives in the collections ledger; a platform refund here
    // would invent a payment that never existed.
    expect(service.eligibilityError(booking({ origin: 'SUPPLIER_CREATED' })))
      .toMatch(/collected outside the platform/i);
  });

  it('refuses a booking whose date has not passed', () => {
    expect(service.eligibilityError(booking({ travelDate: future })))
      .toMatch(/only a completed trip/i);
  });

  it('refuses an unpaid booking', () => {
    expect(service.eligibilityError(booking({ paymentStatus: 'PENDING' })))
      .toMatch(/fully paid/i);
  });

  it('refuses a booking that has not reached a terminal post-trip state', () => {
    for (const status of ['PENDING', 'CONFIRMED', 'CANCELLED']) {
      expect(service.eligibilityError(booking({ status })))
        .toMatch(/completed or no-show/i);
    }
  });

  it('refuses a booking with nothing left to refund', () => {
    expect(service.eligibilityError(booking({ refundAmount: 151.22 })))
      .toMatch(/already been fully refunded/i);
  });

  it('refuses a booking with no platform payment to refund', () => {
    expect(service.eligibilityError(booking({ stripePaymentIntentId: null, paypalCaptureId: null })))
      .toMatch(/no platform payment/i);
  });
});

describe('createRefundRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.booking.findFirst.mockResolvedValue(booking());
    prisma.supplierRefundRequest.findFirst.mockResolvedValue(null);
    prisma.supplierRefundRequest.create.mockResolvedValue({ id: 'r1', requestNumber: 'SR-1' });
    prisma.supplierRefundRequest.findUnique.mockResolvedValue({
      id: 'r1',
      requestNumber: 'SR-1',
      status: 'PENDING_APPROVAL',
      payload: payload(),
      preview: { proposed: 151.22, charge: 0, currency: 'USD' },
      booking: { id: 'b1', bookingNumber: 'TRG-1', tour: { title: 'Tour' } },
    });
  });

  it('rejects a booking that is not eligible', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ origin: 'SUPPLIER_CREATED' }));
    await expect(service.createRefundRequest({
      bookingId: 'b1', supplierId: 's1', payload: payload(), actor: { id: 'u1', email: 'a@b.com' },
    })).rejects.toThrow(/collected outside the platform/i);
    expect(prisma.supplierRefundRequest.create).not.toHaveBeenCalled();
  });

  it('rejects a reason outside the allow-list', async () => {
    await expect(service.createRefundRequest({
      bookingId: 'b1', supplierId: 's1', payload: payload({ reasonCode: 'BECAUSE' }), actor: { id: 'u1' },
    })).rejects.toThrow(/reason/i);
  });

  it('infers "did not attend" when the tour did not operate', async () => {
    // The modal hides the second question in this case; the server must not
    // leave the field to chance, and must record that it was inferred.
    await service.createRefundRequest({
      bookingId: 'b1', supplierId: 's1', actor: { id: 'u1' },
      payload: { operated: false, reasonCode: 'WEATHER_DISRUPTION', refundType: 'PERCENT', value: 100 },
    });
    const data = prisma.supplierRefundRequest.create.mock.calls[0][0].data;
    expect(data.payload.attended).toBe(false);
    expect(data.payload.attendedInferred).toBe(true);
  });

  it('ignores attended=true when the tour did not operate', async () => {
    // A hand-crafted request cannot claim both.
    await service.createRefundRequest({
      bookingId: 'b1', supplierId: 's1', actor: { id: 'u1' },
      payload: { operated: false, attended: true, reasonCode: 'WEATHER_DISRUPTION', refundType: 'PERCENT', value: 100 },
    });
    const data = prisma.supplierRefundRequest.create.mock.calls[0][0].data;
    expect(data.payload.attended).toBe(false);
  });

  it('still requires the customer answer when the tour operated', async () => {
    await expect(service.createRefundRequest({
      bookingId: 'b1', supplierId: 's1', actor: { id: 'u1' },
      payload: { operated: true, reasonCode: 'SERVICE_QUALITY', refundType: 'PERCENT', value: 50 },
    })).rejects.toThrow(/customer went on this tour/i);
  });

  it('requires the two attestation answers', async () => {
    await expect(service.createRefundRequest({
      bookingId: 'b1', supplierId: 's1', payload: { reasonCode: 'OTHER', refundType: 'AMOUNT', value: 10 }, actor: { id: 'u1' },
    })).rejects.toThrow(/whether the tour operated/i);
  });

  it('turns a duplicate open request into a 409', async () => {
    prisma.supplierRefundRequest.create.mockRejectedValue({ code: 'P2002' });
    await expect(service.createRefundRequest({
      bookingId: 'b1', supplierId: 's1', payload: payload(), actor: { id: 'u1', email: 'a@b.com' },
    })).rejects.toThrow(/already has a refund request/i);
  });

  it('blocks a new request while an earlier one is still active', async () => {
    prisma.supplierRefundRequest.findFirst.mockResolvedValue({
      id: 'r0', requestNumber: 'SR-0', status: 'EXECUTING',
    });
    await expect(service.createRefundRequest({
      bookingId: 'b1', supplierId: 's1', payload: payload(), actor: { id: 'u1' },
    })).rejects.toThrow(/already has a refund request in progress/i);
    expect(prisma.supplierRefundRequest.create).not.toHaveBeenCalled();
  });

  it('replays the first request for a repeated idempotency key', async () => {
    prisma.supplierRefundRequest.findUnique.mockResolvedValue({
      id: 'r1', requestNumber: 'SR-1', supplierId: 's1', status: 'PENDING_APPROVAL',
      payload: payload(), preview: { proposed: 151.22, charge: 0, currency: 'USD' },
      booking: { id: 'b1', bookingNumber: 'TRG-1', tour: { title: 'Tour' } },
    });
    const data = await service.createRefundRequest({
      bookingId: 'b1', supplierId: 's1', payload: payload(), actor: { id: 'u1' },
      idempotencyKey: 'retry-key-1',
    });
    expect(data.requestNumber).toBe('SR-1');
    expect(prisma.supplierRefundRequest.create).not.toHaveBeenCalled();
  });

  it('requires a note when the reason is Other', async () => {
    await expect(service.createRefundRequest({
      bookingId: 'b1', supplierId: 's1', actor: { id: 'u1' },
      payload: { operated: true, attended: true, reasonCode: 'OTHER', refundType: 'AMOUNT', value: 10 },
    })).rejects.toThrow(/explain.*other/i);
  });

  it('stores the server-computed preview, not the request body', async () => {
    // The client cannot smuggle an amount in: only refundType + value are read,
    // and both are re-derived against the booking.
    await service.createRefundRequest({
      bookingId: 'b1',
      supplierId: 's1',
      payload: { ...payload({ refundType: 'AMOUNT', value: 10 }), proposed: 9999, charge: 0 },
      actor: { id: 'u1', email: 'a@b.com' },
    });
    const data = prisma.supplierRefundRequest.create.mock.calls[0][0].data;
    expect(data.preview.proposed).toBe(10);
    expect(data.preview.charge).toBe(8);
    expect(data.payload.proposed).toBeUndefined();
  });
});

describe('quoteRefund', () => {
  it('returns the currency-scoped balance and blocks a duplicate active request', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ currency: 'GHS' }));
    prisma.supplierRefundRequest.findFirst.mockResolvedValue({
      id: 'r0', requestNumber: 'SR-0', status: 'PENDING_APPROVAL',
    });
    prisma.booking.aggregate.mockResolvedValue({ _sum: { supplierPayout: 500 } });
    prisma.supplierCharge.aggregate.mockResolvedValue({ _sum: { amount: 75 } });

    const data = await service.quoteRefund({ bookingId: 'b1', supplierId: 's1' });

    expect(data.eligible).toBe(false);
    expect(data.openRequest).toEqual(expect.objectContaining({ requestNumber: 'SR-0' }));
    expect(data.reason).toMatch(/already in progress/i);
    expect(data.supplierBalance).toEqual({ earnings: 500, openCharges: 75, available: 425 });
    expect(prisma.booking.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ currency: 'GHS' }) }),
    );
  });
});

describe('openBalance', () => {
  it('filters earnings and charges to the booking currency', async () => {
    prisma.booking.aggregate.mockResolvedValue({ _sum: { supplierPayout: 500 } });
    prisma.supplierCharge.aggregate.mockResolvedValue({ _sum: { amount: 75 } });

    const balance = await service.openBalance('s1', 'GHS');

    expect(prisma.booking.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ currency: 'GHS' }) }),
    );
    expect(prisma.supplierCharge.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ currency: 'GHS', status: 'OPEN' }) }),
    );
    expect(balance).toEqual({ earnings: 500, openCharges: 75, available: 425 });
  });
});

describe('approveRefundRequest', () => {
  const pending = () => ({
    id: 'r1',
    requestNumber: 'SR-1',
    bookingId: 'b1',
    supplierId: 's1',
    status: 'PENDING_APPROVAL',
    payload: payload({ value: 100 }),
    preview: {},
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
    prisma.$queryRawUnsafe.mockResolvedValue([{ id: 'r1' }]);
    prisma.supplierRefundRequest.findUnique.mockResolvedValue(pending());
    prisma.booking.findUnique.mockResolvedValue(booking());
    prisma.booking.update.mockResolvedValue({});
    prisma.supplierCharge.create.mockResolvedValue({ id: 'c1' });
    prisma.supplierRefundRequest.update.mockImplementation(async ({ data }) => ({
      ...pending(),
      ...data,
      booking: { id: 'b1', bookingNumber: 'TRG-1', tour: { title: 'Tour' } },
    }));
    refundBookingPayment.mockResolvedValue({ id: 're_1', status: 'succeeded' });
  });

  it('refuses a second decision on the same request', async () => {
    prisma.supplierRefundRequest.findUnique.mockResolvedValue({ ...pending(), status: 'COMPLETED' });
    await expect(service.approveRefundRequest({ requestId: 'r1', adminUser: { id: 'a1' } }))
      .rejects.toThrow(/not awaiting a decision/i);
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });

  it('refunds, marks the booking terminal, and completes the request', async () => {
    await service.approveRefundRequest({ requestId: 'r1', adminUser: { id: 'a1' } });

    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'b1' }),
      15122,
      expect.objectContaining({ metadata: expect.objectContaining({ reason: 'supplier_refund_request' }) }),
    );
    // Full refund → terminal for revenue reporting and payout eligibility.
    expect(prisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'REFUNDED', paymentStatus: 'REFUNDED', refundAmount: 151.22 }),
      }),
    );
    expect(prisma.supplierRefundRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED', refundedAmount: 151.22 }) }),
    );
  });

  it('raises no charge when the supplier was never paid', async () => {
    await service.approveRefundRequest({ requestId: 'r1', adminUser: { id: 'a1' } });
    expect(prisma.supplierCharge.create).not.toHaveBeenCalled();
  });

  it('raises the supplier charge when the payout already left', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking({ payoutStatus: 'PAID' }));
    await service.approveRefundRequest({ requestId: 'r1', adminUser: { id: 'a1' } });

    const data = prisma.supplierCharge.create.mock.calls[0][0].data;
    expect(data.amount).toBe(120.98);
    expect(data.reason).toBe('SUPPLIER_REFUND');
    expect(data.status).toBe('OPEN');
  });

  it('passes an idempotency key derived from the request', async () => {
    await service.approveRefundRequest({ requestId: 'r1', adminUser: { id: 'a1' } });
    expect(refundBookingPayment.mock.calls[0][2].idempotencyKey).toBe('supplier-refund-r1');
  });

  it('blocks approval when the booking became ineligible after filing', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking({ refundAmount: 151.22 }));
    await expect(service.approveRefundRequest({ requestId: 'r1', adminUser: { id: 'a1' } }))
      .rejects.toThrow(/already been fully refunded/i);
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });
});

describe('rejectRefundRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.supplierRefundRequest.updateMany.mockResolvedValue({ count: 1 });
    prisma.supplierRefundRequest.findUnique.mockResolvedValue({
      id: 'r1', requestNumber: 'SR-1', status: 'REJECTED', bookingId: 'b1', supplierId: 's1', payload: payload(),
      booking: { id: 'b1', tour: { title: 'Tour' } },
    });
  });

  it('requires a reason', async () => {
    await expect(service.rejectRefundRequest({ requestId: 'r1', adminUser: { id: 'a1' }, note: '  ' }))
      .rejects.toThrow(/reason is required/i);
    expect(prisma.supplierRefundRequest.update).not.toHaveBeenCalled();
  });

  it('records the decision and the note only when still pending', async () => {
    await service.rejectRefundRequest({ requestId: 'r1', adminUser: { id: 'a1' }, note: 'No evidence provided' });
    expect(prisma.supplierRefundRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', status: 'PENDING_APPROVAL' },
      data: expect.objectContaining({ status: 'REJECTED', decisionNote: 'No evidence provided', decidedBy: 'a1' }),
    });
    expect(prisma.supplierRefundRequest.update).not.toHaveBeenCalled();
  });

  it('cannot overwrite a request that was approved concurrently', async () => {
    prisma.supplierRefundRequest.updateMany.mockResolvedValue({ count: 0 });
    prisma.supplierRefundRequest.findUnique.mockResolvedValue({ status: 'COMPLETED' });
    await expect(service.rejectRefundRequest({
      requestId: 'r1', adminUser: { id: 'a1' }, note: 'Late rejection',
    })).rejects.toThrow(/not awaiting a decision.*COMPLETED/i);
  });
});
