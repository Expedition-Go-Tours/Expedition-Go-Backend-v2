/**
 * Pay-later "Complete payment now" hosted-checkout redirects.
 *
 * The Ghana storefront manages bookings inside /dashboard/bookings, not the
 * legacy /booking/:id page. A Ghana pay-later booking that hits 3DS must come
 * back to a route that actually exists after Stripe Checkout, otherwise the
 * customer pays and lands on a 404.
 */
jest.mock('../../src/core/services/prismaClient', () => ({
  booking: {
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
}));

jest.mock('../../src/core/services/stripeHelpers', () => ({
  createCheckoutSession: jest.fn(),
  getStripe: jest.fn(),
}));

const prisma = require('../../src/core/services/prismaClient');
const { createCheckoutSession, getStripe } = require('../../src/core/services/stripeHelpers');
const { startPayNow } = require('../../src/core/domain/payLaterPaymentController');

const originalClientUrl = process.env.CLIENT_URL;
const originalAllowedOrigins = process.env.ALLOWED_ORIGINS;

afterAll(() => {
  if (originalClientUrl === undefined) delete process.env.CLIENT_URL;
  else process.env.CLIENT_URL = originalClientUrl;
  if (originalAllowedOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
  else process.env.ALLOWED_ORIGINS = originalAllowedOrigins;
});

function booking(overrides = {}) {
  return {
    id: 'booking_1',
    bookingNumber: 'TRG-123-2026-1',
    status: 'PENDING',
    paymentTiming: 'later',
    paymentStatus: 'PENDING',
    travelDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    grossAmount: '90',
    currency: 'USD',
    source: 'GHANA',
    clientOrigin: 'https://www.travioghana.com',
    tour: { id: 'tour_1', title: 'Cape Coast Tour' },
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    params: { id: 'booking_1' },
    user: { id: 'user_1', email: 'customer@example.com', stripeCustomerId: 'cus_1' },
    headers: { origin: 'https://www.travioghana.com' },
    ...overrides,
  };
}

describe('payLaterPaymentController.startPayNow', () => {
  let res;
  let next;

  beforeEach(() => {
    process.env.CLIENT_URL = 'https://travioafrica.com';
    process.env.ALLOWED_ORIGINS = 'https://www.travioghana.com,https://expeditiongotours.com';
    jest.clearAllMocks();
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();
    prisma.booking.update.mockResolvedValue({});
    prisma.booking.updateMany.mockResolvedValue({ count: 1 });
    createCheckoutSession.mockResolvedValue({
      id: 'cs_test_1',
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
    });
  });

  it('returns Ghana bookings to the dashboard booking workspace after payment', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking());

    await startPayNow(request(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
      amount: 9000,
      currency: 'USD',
      bookingId: 'booking_1',
      clientUrl: 'https://www.travioghana.com',
      successPath: '/dashboard/bookings?booking=booking_1&paid=1',
      source: 'ghana',
    }));
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'success',
      data: expect.objectContaining({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' }),
    }));
  });

  it('returns a distinct error when the booking is already paid', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ paymentStatus: 'SUCCEEDED' }));

    await startPayNow(request(), res, next);

    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 409,
      errorCode: 'BOOKING_ALREADY_PAID',
      reasonCode: 'PAYMENT_ALREADY_SETTLED',
    }));
  });

  it('resumes an existing open hosted session instead of creating a second one', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({
      paymentLinkHoldAt: new Date(),
      stripeCheckoutSessionId: 'cs_existing',
    }));
    getStripe.mockReturnValue({
      checkout: {
        sessions: {
          retrieve: jest.fn().mockResolvedValue({
            id: 'cs_existing',
            status: 'open',
            url: 'https://checkout.stripe.com/c/pay/cs_existing',
          }),
        },
      },
    });

    await startPayNow(request(), res, next);

    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Resuming your secure payment page.',
      data: expect.objectContaining({ url: 'https://checkout.stripe.com/c/pay/cs_existing' }),
    }));
  });

  it('does not create a second session while an existing one is completing', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({
      paymentLinkHoldAt: new Date(),
      stripeCheckoutSessionId: 'cs_existing',
    }));
    getStripe.mockReturnValue({
      checkout: {
        sessions: { retrieve: jest.fn().mockResolvedValue({ id: 'cs_existing', status: 'complete' }) },
      },
    });

    await startPayNow(request(), res, next);

    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 409,
      errorCode: 'PAYMENT_LINK_COMPLETION_IN_PROGRESS',
    }));
  });

  it('keeps the legacy /booking/:id return path for TravioAfrica bookings', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({
      source: 'TRAVIO',
      clientOrigin: 'https://travioafrica.com',
    }));

    await startPayNow(
      request({ headers: { origin: 'https://travioafrica.com' } }),
      res,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
      clientUrl: 'https://travioafrica.com',
      successPath: '/booking/booking_1?paid=1',
    }));
  });
});
