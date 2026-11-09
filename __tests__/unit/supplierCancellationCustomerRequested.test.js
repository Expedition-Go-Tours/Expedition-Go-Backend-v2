/**
 * Supplier-recorded customer cancellations must behave like customer
 * cancellations: customer origin, no fee, no rate hit, and the customer
 * cancellation emails — never the "supplier cancelled" pair.
 */

jest.mock('../../src/core/services/prismaClient', () => {
  const tx = {
    booking: { update: jest.fn(({ data }) => ({ id: 'b1', ...data })) },
    payout: { updateMany: jest.fn() },
    supplierCharge: { create: jest.fn() },
    specialOffer: { update: jest.fn() },
  };
  return {
    __tx: tx,
    $transaction: jest.fn(async (fn) => fn(tx)),
    booking: { update: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
    payout: { updateMany: jest.fn() },
  };
});
jest.mock('../../src/core/services/payments', () => ({ refundBookingPayment: jest.fn() }));
jest.mock('../../src/core/services/financeHelpers', () => ({
  detachBookingFromActiveRequests: jest.fn(),
}));
jest.mock('../../src/core/services/invoiceService', () => ({
  detachBookingFromInvoices: jest.fn(),
}));
jest.mock('../../src/core/services/queue', () => ({
  enqueueEmail: jest.fn(),
  enqueueNotification: jest.fn(),
  enqueueEvent: jest.fn(),
}));
jest.mock('../../src/core/services/adminNotificationService', () => ({
  notifyAdmin: jest.fn(),
}));
jest.mock('../../src/core/services/auditLogger', () => ({
  logActivity: jest.fn(),
}));

const prisma = require('../../src/core/services/prismaClient');
const { enqueueEmail, enqueueNotification } = require('../../src/core/services/queue');
const { cancelBySupplier } = require('../../src/core/services/supplierCancellation');

const booking = () => ({
  id: 'b1',
  bookingNumber: 'TRG-1',
  customerId: 'c1',
  status: 'CONFIRMED',
  paymentStatus: 'SUCCEEDED',
  grossAmount: '70.40',
  currency: 'USD',
  travelers: { adults: 1, children: 0, infants: 0 },
  appliedOfferId: null,
  tourId: 't1',
  tour: {
    id: 't1',
    title: 'Waterfalls',
    supplierId: 's1',
    bookingAndTickets: { cancellationPolicy: { type: 'all_sales_final' } },
  },
});

const payload = {
  cancellationCode: 'CUSTOMER_REQUESTED_CANCEL',
  cancellationCategory: 'CUSTOMER_REQUESTED',
  customerRefundAgreed: false,
  agreedToTerms: true,
  explanation: 'Customer asked to cancel by phone',
};

beforeEach(() => {
  jest.clearAllMocks();
  enqueueEmail.mockResolvedValue(undefined);
  enqueueNotification.mockResolvedValue(undefined);
  require('../../src/core/services/queue').enqueueEvent.mockResolvedValue(undefined);
  require('../../src/core/services/auditLogger').logActivity.mockResolvedValue(undefined);
});

describe('cancelBySupplier — customer-requested', () => {
  it('records customer origin, no fee and no rate hit', async () => {
    const result = await cancelBySupplier({
      booking: booking(),
      payload,
      supplierId: 's1',
      req: {},
    });

    expect(prisma.__tx.booking.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        cancellationOrigin: 'CUSTOMER',
        cancellationCategory: 'CUSTOMER_REQUESTED',
        countsTowardRate: false,
        cancellationFee: null,
        cancellationReason: 'Customer requested cancellation',
      }),
    }));
    expect(prisma.__tx.supplierCharge.create).not.toHaveBeenCalled();
    expect(result.fee).toBe(0);
  });

  it('sends the customer and supplier cancellation emails, not the supplier-cancelled pair', async () => {
    await cancelBySupplier({ booking: booking(), payload, supplierId: 's1', req: {} });

    const types = enqueueEmail.mock.calls.map(([job]) => job.type);
    expect(types).toEqual(expect.arrayContaining(['booking-cancellation', 'supplier-cancellation']));
    expect(types).not.toContain('supplier-cancelled-booking');

    expect(enqueueNotification).toHaveBeenCalledWith(expect.objectContaining({
      type: 'BOOKING_CANCELLED',
      title: 'Cancellation request approved',
    }));
  });
});
