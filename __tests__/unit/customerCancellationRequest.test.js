/**
 * Same-day customer cancellation requests.
 *
 * The policy is narrow on purpose: only on the activity date, only before the
 * activity starts, only when the normal policy refuses. Approval cancels with
 * no refund and no supplier fee; decline leaves the booking active.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  booking: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  payout: { updateMany: jest.fn() },
  specialOffer: { update: jest.fn() },
  $transaction: jest.fn(),
}));
jest.mock('../../src/core/services/bookingHelpers', () => {
  const actual = jest.requireActual('../../src/core/services/bookingHelpers');
  return { ...actual, activityStart: jest.fn(), evaluateCancellationPolicy: jest.fn() };
});
jest.mock('../../src/core/services/financeHelpers', () => ({
  detachBookingFromActiveRequests: jest.fn(),
}));
jest.mock('../../src/core/services/invoiceService', () => ({
  detachBookingFromInvoices: jest.fn(),
}));
jest.mock('../../src/core/services/queue', () => ({
  enqueueEmail: jest.fn(),
  enqueueNotification: jest.fn(),
}));
jest.mock('../../src/core/services/auditLogger', () => ({
  logActivity: jest.fn(),
}));
jest.mock('../../src/core/services/emailService', () => ({
  resolveEmailBrand: jest.fn(() => 'ghana'),
  sendEmail: jest.fn(),
}));

const prisma = require('../../src/core/services/prismaClient');
const { activityStart, evaluateCancellationPolicy } = require('../../src/core/services/bookingHelpers');
const { enqueueEmail, enqueueNotification } = require('../../src/core/services/queue');
const { logActivity } = require('../../src/core/services/auditLogger');
const { sendEmail } = require('../../src/core/services/emailService');
const service = require('../../src/core/services/customerCancellationRequest');

const booking = (over = {}) => ({
  id: 'b-1',
  bookingNumber: 'TRG-1',
  status: 'CONFIRMED',
  paymentStatus: 'SUCCEEDED',
  grossAmount: 100,
  currency: 'USD',
  travelDate: new Date(),
  selectedTime: '12:00',
  customerId: 'cust-1',
  customer: { id: 'cust-1', name: 'Ama', email: 'ama@example.com' },
  leadTravelerName: 'Ama',
  leadTravelerEmail: 'ama@example.com',
  travelers: { adults: 1, children: 0, infants: 0 },
  appliedOfferId: null,
  customerCancellationStatus: null,
  tour: { id: 't-1', title: 'Shai Hills', supplierId: 'sup-1', supplier: { id: 'sup-1', name: 'Accra Walks', email: 'ops@example.com', roles: ['supplier'] } },
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  activityStart.mockReturnValue(new Date(Date.now() + 60 * 60 * 1000));
  evaluateCancellationPolicy.mockReturnValue({ allowed: false, refundAmount: 0, reason: 'No refund (less than 24 hours)' });
  prisma.booking.update.mockImplementation(async ({ data }) => ({ ...booking(), ...data }));
  prisma.booking.updateMany.mockResolvedValue({ count: 1 });
  prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
  prisma.payout.updateMany.mockResolvedValue({ count: 0 });
  prisma.specialOffer.update.mockResolvedValue({});
  prisma.booking.findUnique.mockResolvedValue(booking({ customerCancellationStatus: 'APPROVED' }));
  enqueueEmail.mockResolvedValue(undefined);
  enqueueNotification.mockResolvedValue(undefined);
  logActivity.mockResolvedValue(undefined);
  sendEmail.mockResolvedValue(undefined);
});

describe('requestCustomerCancellation', () => {
  it('stores a pending request and notifies the supplier', async () => {
    const updated = await service.requestCustomerCancellation({
      booking: booking(),
      customerId: 'cust-1',
      reason: 'SCHEDULE_CHANGED',
      note: 'Flight moved',
    });

    expect(prisma.booking.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'b-1' },
      data: expect.objectContaining({
        customerCancellationStatus: 'PENDING',
        customerCancellationReason: 'My schedule changed',
        customerCancellationNote: 'Flight moved',
      }),
    }));
    expect(updated.customerCancellationStatus).toBe('PENDING');
    expect(enqueueNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'sup-1',
      type: 'CUSTOMER_CANCELLATION_REQUESTED',
      sendEmail: true,
    }));
  });

  it('rejects a request that is not on the activity date', async () => {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

    await expect(service.requestCustomerCancellation({
      booking: booking({ travelDate: tomorrow }),
      customerId: 'cust-1',
    })).rejects.toThrow(/only available on the activity date/i);
  });

  it('rejects a request after the activity has started', async () => {
    activityStart.mockReturnValue(new Date(Date.now() - 60 * 60 * 1000));

    await expect(service.requestCustomerCancellation({
      booking: booking(),
      customerId: 'cust-1',
    })).rejects.toThrow(/already started/i);
  });

  it('rejects when the normal cancellation policy still allows cancelling', async () => {
    evaluateCancellationPolicy.mockReturnValue({ allowed: true, refundAmount: 100 });

    await expect(service.requestCustomerCancellation({
      booking: booking(),
      customerId: 'cust-1',
    })).rejects.toThrow(/cancelled normally/i);
  });

  it('rejects a second request while one is pending', async () => {
    await expect(service.requestCustomerCancellation({
      booking: booking({ customerCancellationStatus: 'PENDING' }),
      customerId: 'cust-1',
    })).rejects.toThrow(/already awaiting/i);
  });

  it('rejects someone else’s booking', async () => {
    await expect(service.requestCustomerCancellation({
      booking: booking(),
      customerId: 'other',
    })).rejects.toThrow(/not found/i);
  });

  it('accepts a guest booking with no customer account', async () => {
    const updated = await service.requestCustomerCancellation({
      booking: booking({
        customerId: null,
        customer: null,
        leadTravelerEmail: 'guest@example.com',
      }),
      customerId: null,
      reason: 'SCHEDULE_CHANGED',
    });

    expect(prisma.booking.update).toHaveBeenCalled();
    expect(updated.customerCancellationStatus).toBe('PENDING');
  });
});

describe('decideCustomerCancellation', () => {
  it('approves as a customer-origin, non-refundable cancellation with no fee', async () => {
    const result = await service.decideCustomerCancellation({
      booking: booking({ customerCancellationStatus: 'PENDING', customerCancellationReason: 'SCHEDULE_CHANGED' }),
      supplierId: 'sup-1',
      approve: true,
      note: 'Sorry to lose you',
    });

    expect(prisma.booking.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'b-1', customerCancellationStatus: 'PENDING' }),
      data: expect.objectContaining({
        status: 'CANCELLED',
        cancellationOrigin: 'CUSTOMER',
        cancellationCategory: 'CUSTOMER_REQUESTED',
        cancellationCode: 'CUSTOMER_REQUESTED_CANCEL',
        countsTowardRate: false,
        refundStatus: 'NOT_APPLICABLE',
        refundAmount: null,
        cancellationFee: null,
        customerCancellationStatus: 'APPROVED',
      }),
    }));
    expect(prisma.payout.updateMany).toHaveBeenCalled();
    expect(enqueueEmail).toHaveBeenCalledWith(expect.objectContaining({ type: 'customer-cancelled-no-refund' }));
    expect(enqueueEmail).toHaveBeenCalledWith(expect.objectContaining({ type: 'supplier-customer-cancelled-late' }));
    expect(result.customerCancellationStatus).toBe('APPROVED');
  });

  it('uses the unpaid emails when no money was captured', async () => {
    await service.decideCustomerCancellation({
      booking: booking({ customerCancellationStatus: 'PENDING', paymentStatus: 'PENDING' }),
      supplierId: 'sup-1',
      approve: true,
    });

    expect(enqueueEmail).toHaveBeenCalledWith(expect.objectContaining({ type: 'customer-cancelled-unpaid' }));
    expect(enqueueEmail).toHaveBeenCalledWith(expect.objectContaining({ type: 'supplier-customer-cancelled-unpaid' }));
  });

  it('declines without touching the booking status', async () => {
    await service.decideCustomerCancellation({
      booking: booking({ customerCancellationStatus: 'PENDING' }),
      supplierId: 'sup-1',
      approve: false,
      note: 'We can still run the tour',
    });

    expect(prisma.booking.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        customerCancellationStatus: 'DECLINED',
        customerCancellationDecisionNote: 'We can still run the tour',
      }),
    }));
    expect(prisma.booking.updateMany.mock.calls[0][0].data.status).toBeUndefined();
    expect(enqueueNotification).toHaveBeenCalledWith(expect.objectContaining({
      type: 'CUSTOMER_CANCELLATION_DECLINED',
    }));
  });

  it('rejects a decision when nothing is pending', async () => {
    await expect(service.decideCustomerCancellation({
      booking: booking({ customerCancellationStatus: null }),
      supplierId: 'sup-1',
      approve: true,
    })).rejects.toThrow(/no pending cancellation request/i);
  });

  it('rejects a concurrent second decision', async () => {
    prisma.booking.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.decideCustomerCancellation({
      booking: booking({ customerCancellationStatus: 'PENDING' }),
      supplierId: 'sup-1',
      approve: true,
    })).rejects.toThrow(/already been decided/i);
  });
});

describe('activityCutoff', () => {
  it('uses the time slot when present', () => {
    const start = new Date(Date.now() + 60 * 60 * 1000);
    activityStart.mockReturnValue(start);

    expect(service.activityCutoff(booking()).getTime()).toBe(start.getTime());
  });

  it('falls back to the end of the travel day when there is no time slot', () => {
    activityStart.mockReturnValue(new Date(Date.UTC(2026, 10, 9)));

    const cutoff = service.activityCutoff(booking({ selectedTime: null }));
    expect(cutoff.toISOString()).toBe('2026-11-09T23:59:59.999Z');
  });
});
