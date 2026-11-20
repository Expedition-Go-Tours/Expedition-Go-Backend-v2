/**
 * Brand-scoped proof-of-payment route handler.
 *
 * The PDF layout has its own tests; this one covers the wiring that would
 * silently break the feature: brand scoping of the booking lookup, the
 * response headers the browser needs to save a file, the decision to talk to
 * Stripe only for Stripe payments, and graceful degradation when Stripe or the
 * logo fetch fails.
 */

jest.mock('../../src/core/services/prismaClient', () => ({
  booking: { findFirst: jest.fn() },
}));

jest.mock('../../src/core/services/paymentSettlement', () => ({
  getStripeSettlement: jest.fn(),
}));

jest.mock('../../src/core/services/brandAssets', () => ({
  getBrandLogo: jest.fn(),
}));

jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn() }));
jest.mock('../../src/core/services/queue', () => ({ enqueueNotification: jest.fn() }));
jest.mock('../../src/core/services/cacheHelper', () => ({ getOrSet: jest.fn((key, fn) => fn()) }));

const prisma = require('../../src/core/services/prismaClient');
const { getStripeSettlement } = require('../../src/core/services/paymentSettlement');
const { getBrandLogo } = require('../../src/core/services/brandAssets');
const makeAdminController = require('../../src/core/admin');

const BOOKING = {
  id: 'bk_1',
  bookingNumber: 'TRG-86414786-2026-46',
  status: 'COMPLETED',
  paymentStatus: 'SUCCEEDED',
  paymentProvider: 'STRIPE',
  paymentTiming: 'now',
  currency: 'USD',
  subtotal: '540.00',
  taxes: '0.00',
  fees: '0.00',
  discounts: '0.00',
  grossAmount: '540.00',
  createdAt: new Date('2026-10-22T16:26:54.776Z'),
  paidAt: new Date('2026-11-03T00:19:28.604Z'),
  travelDate: new Date('2026-11-04T00:00:00.000Z'),
  travelers: { adults: 6 },
  paymentMethodBrand: 'visa',
  paymentMethodLast4: '1552',
  stripePaymentIntentId: 'pi_3UTOpOCgYMgEuT2o1Dm6PhVa',
  paypalOrderId: null,
  paypalCaptureId: null,
  refundAmount: null,
  collections: [],
  customer: { id: 'cus_1', name: 'Wayne Gibson', email: 'drwgibson@gmail.com', phone: null },
  guest: null,
  tour: {
    id: 'tour_1',
    title: 'Cape Coast Castle, Elmina Castle & Kakum National Park Tour',
    city: 'Cape Coast',
    country: 'Ghana',
    durationMinutes: 660,
    supplier: { id: 'sup_1', name: 'Expedition-Go Tours LTD' },
  },
};

const controller = makeAdminController('ghana');

describe('getBookingProofOfPayment', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { params: { id: 'bk_1' }, user: { id: 'admin-1' }, brandKey: 'ghana' };
    res = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };
    next = jest.fn();

    prisma.booking.findFirst.mockResolvedValue(BOOKING);
    getBrandLogo.mockResolvedValue(null);
    getStripeSettlement.mockResolvedValue(null);
  });

  it('returns 404 for a booking outside the brand', async () => {
    prisma.booking.findFirst.mockResolvedValue(null);

    await controller.getBookingProofOfPayment(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    expect(res.send).not.toHaveBeenCalled();
  });

  it('scopes the lookup to Ghana bookings', async () => {
    await controller.getBookingProofOfPayment(req, res, next);

    const where = prisma.booking.findFirst.mock.calls[0][0].where;
    expect(where.id).toBe('bk_1');
    expect(Array.isArray(where.OR)).toBe(true);
  });

  it('sends a downloadable PDF with the booking reference in the filename', async () => {
    await controller.getBookingProofOfPayment(req, res, next);

    const headers = Object.fromEntries(res.setHeader.mock.calls);
    expect(headers['Content-Type']).toBe('application/pdf');
    expect(headers['Content-Disposition']).toBe(
      'attachment; filename="proof-of-payment-TRG-86414786-2026-46.pdf"',
    );
    expect(headers['Cache-Control']).toBe('no-store');

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.send.mock.calls[0][0];
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(next).not.toHaveBeenCalled();
  });

  it('asks Stripe where the money settled', async () => {
    await controller.getBookingProofOfPayment(req, res, next);

    expect(getStripeSettlement).toHaveBeenCalledWith({
      paymentIntentId: 'pi_3UTOpOCgYMgEuT2o1Dm6PhVa',
    });
  });

  it('does not consult Stripe for a PayPal booking', async () => {
    prisma.booking.findFirst.mockResolvedValue({
      ...BOOKING,
      paymentProvider: 'PAYPAL',
      stripePaymentIntentId: null,
      paypalOrderId: '5O190127TN364715T',
      paypalCaptureId: '3C679366HH908993F',
    });

    await controller.getBookingProofOfPayment(req, res, next);

    expect(getStripeSettlement).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalled();
  });

  it('still returns a document when the logo and Stripe both fail', async () => {
    getBrandLogo.mockRejectedValue(new Error('cloudinary down'));
    getStripeSettlement.mockResolvedValue({ error: 'stripe timeout' });

    await controller.getBookingProofOfPayment(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send.mock.calls[0][0].subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('sanitises the filename for a hostile booking reference', async () => {
    prisma.booking.findFirst.mockResolvedValue({
      ...BOOKING,
      bookingNumber: 'TRG/../../etc/passwd',
    });

    await controller.getBookingProofOfPayment(req, res, next);

    const headers = Object.fromEntries(res.setHeader.mock.calls);
    expect(headers['Content-Disposition']).toBe(
      'attachment; filename="proof-of-payment-TRG_.._.._etc_passwd.pdf"',
    );
  });
});
