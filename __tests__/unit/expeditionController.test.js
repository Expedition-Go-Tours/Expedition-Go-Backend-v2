jest.mock('../../utils/prismaClient', () => ({
  expeditionTour: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
  tour: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
  user: { findUnique: jest.fn(), update: jest.fn() },
  wishlistItem: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), delete: jest.fn() },
  booking: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn(), deleteMany: jest.fn() },
  tourDateOverride: { findFirst: jest.fn() },
  review: { findMany: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
  newsletterSubscriber: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  cartItem: { deleteMany: jest.fn() },
  supplierProfile: { findFirst: jest.fn() },
  payout: { create: jest.fn(), updateMany: jest.fn(), findMany: jest.fn() },
  $transaction: jest.fn(),
  $queryRawUnsafe: jest.fn(),
}));

jest.mock('../../utils/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url) => url) }));

jest.mock('../../utils/eventEmitter', () => ({ emit: jest.fn(), emitBatch: jest.fn() }));

jest.mock('../../utils/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../utils/emailService', () => ({ sendEmail: jest.fn(() => Promise.resolve()) }));

jest.mock('../../utils/queue', () => ({
  enqueueEvent: jest.fn(() => Promise.resolve()),
  enqueueEmail: jest.fn(() => Promise.resolve()),
  enqueueNotification: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../utils/bookingHelpers', () => ({
  validateTravelerInfo: jest.fn(),
  generateBookingNumber: jest.fn(),
  evaluateCancellationPolicy: jest.fn(() => ({ allowed: true, refundAmount: 105, refundPercentage: 100, reason: 'Full refund available', windowHours: 24 })),
}));

jest.mock('../../utils/tourHelpers', () => ({
  checkTourAvailability: jest.fn(),
  calculateTourPrice: jest.fn(),
}));

jest.mock('../../utils/stripeHelpers', () => {
  let stripeInstance = null;
  return {
    createPaymentIntent: jest.fn(),
    calculateCommission: jest.fn(),
    createRefund: jest.fn(),
    ensureStripeCustomer: jest.fn(async (user) => user?.stripeCustomerId || null),
    getStripe: jest.fn(() => {
      if (!stripeInstance) {
        stripeInstance = {
          paymentIntents: {
            confirm: jest.fn(),
            retrieve: jest.fn(),
            update: jest.fn(() => Promise.resolve({})),
          },
        };
      }
      return stripeInstance;
    }),
  };
});

jest.mock('../../utils/getConfig', () => jest.fn((key, def) => Promise.resolve(def)));

jest.mock('../../utils/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));

jest.mock('../../utils/availabilityCalendar', () => ({
  buildAvailabilityCalendar: jest.fn(() => Promise.resolve([])),
}));

const prisma = require('../../utils/prismaClient');
const cache = require('../../utils/cacheHelper');
const { sendEmail } = require('../../utils/emailService');
const { enqueueEvent, enqueueNotification } = require('../../utils/queue');
const { validateTravelerInfo, generateBookingNumber, evaluateCancellationPolicy } = require('../../utils/bookingHelpers');
const { checkTourAvailability, calculateTourPrice } = require('../../utils/tourHelpers');
const { createPaymentIntent, calculateCommission, createRefund, getStripe } = require('../../utils/stripeHelpers');
const { logActivity } = require('../../utils/auditLogger');

const controller = require('../../controllers/expeditionController');

const mockTour = {
  id: 'tour-1',
  title: 'Test Tour',
  slug: 'test-tour',
  description: 'A fantastic test tour with lots of amazing sights to see',
  coverPhoto: 'https://res.cloudinary.com/test/tour.jpg',
  photos: ['https://res.cloudinary.com/test/tour1.jpg'],
  category: 'Adventure',
  durationMinutes: 120,
  averageRating: 4.5,
  reviewCount: 10,
  city: 'Cape Town',
  country: 'South Africa',
  schedulesAndPricing: {
    travelerDetails: { pricingModel: 'perPerson', maxTravelersPerBooking: 15, ageGroups: [] },
    pricingSchedules: { currency: 'USD', schedules: [{ startDate: '2026-01-01', endDate: '2026-12-31', prices: [{ ageGroup: 'Adult', retailPrice: 50 }] }] },
  },
  supplier: {
    id: 'supplier-1',
    name: 'Test Supplier',
    photoURL: 'https://res.cloudinary.com/test/supplier.jpg',
    supplierProfile: { status: 'ACTIVE', averageRating: 4.5, totalBookings: 10 },
  },
  supplierId: 'supplier-1',
  status: 'ACTIVE',
};

const mockExpeditionTour = {
  id: 'et-1',
  tourId: 'tour-1',
  displayOrder: 1,
  isFeatured: false,
  isActive: true,
  addedById: 'admin-1',
  tour: mockTour,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('expeditionController', () => {
  let req, res, next;

  beforeEach(() => {
    req = {
      query: {},
      params: {},
      body: {},
      user: { id: 'user-1', roles: ['customer'], stripeCustomerId: 'cus_123' },
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      ip: '127.0.0.1',
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
    };
    next = jest.fn();

    jest.clearAllMocks();

    prisma.expeditionTour.findMany.mockResolvedValue([mockExpeditionTour]);
    prisma.expeditionTour.findUnique.mockResolvedValue(mockExpeditionTour);
    prisma.expeditionTour.findFirst.mockResolvedValue(mockExpeditionTour);
    prisma.expeditionTour.create.mockResolvedValue(mockExpeditionTour);
    prisma.expeditionTour.update.mockResolvedValue(mockExpeditionTour);
    prisma.expeditionTour.delete.mockResolvedValue(mockExpeditionTour);
    prisma.expeditionTour.count.mockResolvedValue(1);
    prisma.expeditionTour.aggregate.mockResolvedValue({ _max: { displayOrder: 0 } });
    prisma.tour.findMany.mockResolvedValue([mockTour]);
    prisma.tour.findFirst.mockResolvedValue(mockTour);
    prisma.tour.findUnique.mockResolvedValue(mockTour);
    prisma.tour.update.mockResolvedValue(mockTour);
    prisma.tour.count.mockResolvedValue(1);
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wishlist: ['tour-1'] });
    prisma.booking.create.mockResolvedValue({ id: 'booking-1', ...mockExpeditionTour, bookingNumber: 'TB00000001ABCD' });
    prisma.cartItem.deleteMany.mockResolvedValue({ count: 0 });
    prisma.$queryRawUnsafe.mockResolvedValue([{ currentBookings: '0' }]);
    prisma.tourDateOverride.findFirst.mockResolvedValue(null);
    prisma.$transaction.mockImplementation(async (cb) => {
      if (typeof cb === 'function') return cb(prisma);
      return cb;
    });
    checkTourAvailability.mockResolvedValue({ available: true, availableSpots: 10 });
    calculateTourPrice.mockResolvedValue({ success: true, currency: 'USD', subtotal: 100, fees: 5, discount: 0, total: 105 });
    validateTravelerInfo.mockReturnValue({ isValid: true, errors: [] });
    generateBookingNumber.mockResolvedValue('TB00000001ABCD');
    createPaymentIntent.mockResolvedValue({ id: 'pi_mock_123' });
    getStripe().paymentIntents.confirm.mockResolvedValue({ id: 'pi_mock_123', status: 'succeeded', client_secret: 'cs_mock_123' });
    getStripe().paymentIntents.retrieve.mockResolvedValue({ id: 'pi_mock_123', status: 'succeeded', client_secret: 'cs_mock_123' });
    prisma.booking.updateMany.mockResolvedValue({ count: 0 });
    calculateCommission.mockResolvedValue({ rate: 0.15, amount: 15.75, supplierPayout: 89.25 });
    cache.getOrSet.mockImplementation((key, fn) => fn());
  });

  describe('getTours', () => {
    it('returns cached list of tours', async () => {
      await controller.getTours(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'success', data: expect.any(Object) })
      );
    });
  });

  describe('getFeaturedTours', () => {
    it('returns featured tours limited to 8', async () => {
      prisma.expeditionTour.findMany.mockResolvedValue([mockExpeditionTour]);

      await controller.getFeaturedTours(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(prisma.expeditionTour.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ isFeatured: true }), take: 8 })
      );
    });
  });

  describe('getTourBySlug', () => {
    it('returns tour detail with JSON-LD', async () => {
      req.params.slug = 'test-tour';
      prisma.expeditionTour.findFirst.mockResolvedValue(mockExpeditionTour);

      await controller.getTourBySlug(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns 404 when tour not found', async () => {
      req.params.slug = 'non-existent';
      prisma.expeditionTour.findFirst.mockResolvedValue(null);

      await controller.getTourBySlug(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  describe('getSitemap', () => {
    it('returns sitemap entries', async () => {
      await controller.getSitemap(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('getTourReviews', () => {
    const mockReview = {
      id: 'review-1',
      rating: 5,
      title: 'Amazing tour',
      comment: 'Best experience ever',
      photos: [],
      travelMonth: 'June',
      companions: ['Family'],
      verified: true,
      helpfulCount: 3,
      createdAt: new Date(),
      customer: { id: 'user-1', name: 'John Doe', photoURL: '/john.jpg' },
    };

    it('returns paginated reviews for a tour', async () => {
      req.params = { slug: 'test-tour' };
      prisma.expeditionTour.findFirst.mockResolvedValue({ tourId: 'tour-1' });
      prisma.review.findMany.mockResolvedValue([mockReview]);
      prisma.review.count.mockResolvedValue(1);
      prisma.review.aggregate.mockResolvedValue({ _avg: { rating: 5 } });

      await controller.getTourReviews(req, res, next);

      expect(prisma.review.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tourId: 'tour-1', status: 'APPROVED' },
        })
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          data: expect.objectContaining({
            reviews: [mockReview],
            averageRating: 5,
            totalCount: 1,
          }),
        })
      );
    });

    it('returns 404 when tour not found', async () => {
      req.params = { slug: 'non-existent' };
      prisma.expeditionTour.findFirst.mockResolvedValue(null);

      await controller.getTourReviews(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns null averageRating when no reviews', async () => {
      req.params = { slug: 'test-tour' };
      prisma.expeditionTour.findFirst.mockResolvedValue({ tourId: 'tour-1' });
      prisma.review.findMany.mockResolvedValue([]);
      prisma.review.count.mockResolvedValue(0);
      prisma.review.aggregate.mockResolvedValue({ _avg: { rating: null } });

      await controller.getTourReviews(req, res, next);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ averageRating: null, totalCount: 0 }),
        })
      );
    });
  });

  describe('getSimilarTours', () => {
    const mockSimilarTour = {
      id: 'et-2',
      tour: { ...mockTour, id: 'tour-2', slug: 'similar-tour', title: 'Similar Tour' },
    };

    it('returns similar tours in same category', async () => {
      req.params = { slug: 'test-tour' };
      prisma.expeditionTour.findFirst.mockResolvedValue({
        tourId: 'tour-1',
        tour: { id: 'tour-1', category: 'Adventure' },
      });
      prisma.expeditionTour.findMany.mockResolvedValue([mockSimilarTour]);

      await controller.getSimilarTours(req, res, next);

      expect(prisma.expeditionTour.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            isActive: true,
            tour: expect.objectContaining({ category: 'Adventure', id: { not: 'tour-1' } }),
          },
          take: 4,
        })
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'success' })
      );
    });

    it('returns 404 when tour not found', async () => {
      req.params = { slug: 'non-existent' };
      prisma.expeditionTour.findFirst.mockResolvedValue(null);

      await controller.getSimilarTours(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns empty array when no similar tours', async () => {
      req.params = { slug: 'test-tour' };
      prisma.expeditionTour.findFirst.mockResolvedValue({
        tourId: 'tour-1',
        tour: { id: 'tour-1', category: 'UniqueCat' },
      });
      prisma.expeditionTour.findMany.mockResolvedValue([]);

      await controller.getSimilarTours(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: { tours: [] } })
      );
    });
  });

  describe('submitContact', () => {
    it('returns 200 on valid submission', async () => {
      req.body = { name: 'John Doe', email: 'john@example.com', message: 'Hello, I have a question about tours.' };

      await controller.submitContact(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(sendEmail).toHaveBeenCalled();
    });

    it('returns 400 when name is missing', async () => {
      req.body = { email: 'john@example.com', message: 'Hello, I have a question about tours.' };

      await controller.submitContact(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 400 on invalid email', async () => {
      req.body = { name: 'John', email: 'not-an-email', message: 'Hello, I have a question about tours.' };

      await controller.submitContact(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 400 on short message', async () => {
      req.body = { name: 'John', email: 'john@example.com', message: 'Hi' };

      await controller.submitContact(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });
  });

  describe('trackClick', () => {
    it('returns 204 on click tracked', async () => {
      req.body = { event: 'cta_book_now', target: 'test-tour' };

      await controller.trackClick(req, res, next);

      expect(res.status).toHaveBeenCalledWith(204);
    });
  });

  describe('subscribe', () => {
    it('creates a new subscriber', async () => {
      req.body = { email: 'test@test.com', name: 'John' };
      prisma.newsletterSubscriber.findUnique.mockResolvedValue(null);

      await controller.subscribe(req, res, next);

      expect(prisma.newsletterSubscriber.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ email: 'test@test.com' }) })
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('resubscribes an existing unsubscribed user', async () => {
      req.body = { email: 'test@test.com' };
      prisma.newsletterSubscriber.findUnique.mockResolvedValue({ email: 'test@test.com', subscribed: false });

      await controller.subscribe(req, res, next);

      expect(prisma.newsletterSubscriber.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: 'test@test.com' }, data: { subscribed: true } })
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns 200 if already subscribed', async () => {
      req.body = { email: 'test@test.com' };
      prisma.newsletterSubscriber.findUnique.mockResolvedValue({ email: 'test@test.com', subscribed: true });

      await controller.subscribe(req, res, next);

      expect(prisma.newsletterSubscriber.create).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('getTourAvailability', () => {
    it('returns calendar for valid tour and date range', async () => {
      req.params = { slug: 'test-tour' };
      req.query = { startDate: '2026-08-01', endDate: '2026-08-07' };
      prisma.expeditionTour.findFirst.mockResolvedValue({ tourId: 'tour-1' });
      prisma.tour.findUnique.mockResolvedValue({ id: 'tour-1', title: 'Test', schedulesAndPricing: {} });

      await controller.getTourAvailability(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'success', data: expect.objectContaining({ calendar: [] }) })
      );
    });

    it('returns 404 when tour not found', async () => {
      req.params = { slug: 'non-existent' };
      req.query = { startDate: '2026-08-01', endDate: '2026-08-07' };
      prisma.expeditionTour.findFirst.mockResolvedValue(null);

      await controller.getTourAvailability(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 400 when range exceeds 31 days', async () => {
      req.params = { slug: 'test-tour' };
      req.query = { startDate: '2026-08-01', endDate: '2026-10-01' };
      prisma.expeditionTour.findFirst.mockResolvedValue({ tourId: 'tour-1' });
      prisma.tour.findUnique.mockResolvedValue({ id: 'tour-1', title: 'Test', schedulesAndPricing: {} });

      await controller.getTourAvailability(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });
  });

  describe('calculateCheckout', () => {
    it('returns pricing breakdown on valid request', async () => {
      req.body = { tourId: 'tour-1', selectedDate: '2026-08-15', travelers: { adults: 2, children: 1 } };

      await controller.calculateCheckout(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          data: expect.objectContaining({
            available: true,
            pricing: expect.objectContaining({ total: 105 }),
          }),
        })
      );
    });

    it('returns 400 when required fields missing', async () => {
      req.body = {};

      await controller.calculateCheckout(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 404 when tour not found', async () => {
      req.body = { tourId: 'non-existent', selectedDate: '2026-08-15', travelers: { adults: 1 } };
      prisma.tour.findFirst.mockResolvedValue(null);

      await controller.calculateCheckout(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 400 when tour is not available on date', async () => {
      req.body = { tourId: 'tour-1', selectedDate: '2026-08-15', travelers: { adults: 1 } };
      checkTourAvailability.mockResolvedValue({ available: false, reason: 'No availability on selected date' });

      await controller.calculateCheckout(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 400 when spots are insufficient', async () => {
      req.body = { tourId: 'tour-1', selectedDate: '2026-08-15', travelers: { adults: 20 } };
      checkTourAvailability.mockResolvedValue({ available: true, availableSpots: 5 });

      await controller.calculateCheckout(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });
  });

  describe('confirmBooking', () => {
    // Booking date must clear the advance-booking cutoff (default 24h) and stay
    // under the max advance window, so derive it from "now" instead of a fixed
    // date that ages out and flakes the suite.
    const bookingDate = () => new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const validBookingBody = {
      tourId: 'tour-1',
      selectedDate: bookingDate(),
      travelers: { adults: 2, children: 1, phoneNumber: '+1-555-123-4567', location: 'Cape Town' },
      paymentMethodId: 'pm_123',
    };

    it('creates booking and returns 201', async () => {
      req.body = validBookingBody;

      await controller.confirmBooking(req, res, next);

      expect(createPaymentIntent).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
      expect(enqueueNotification).toHaveBeenCalled();
      expect(enqueueEvent).toHaveBeenCalled();
    });

    it('returns 400 when required fields missing', async () => {
      req.body = {};

      await controller.confirmBooking(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 400 on traveler validation failure', async () => {
      req.body = validBookingBody;
      validateTravelerInfo.mockReturnValue({ isValid: false, errors: ['Phone number is required'] });

      await controller.confirmBooking(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 404 when tour not found', async () => {
      req.body = validBookingBody;
      prisma.tour.findFirst.mockResolvedValue(null);

      await controller.confirmBooking(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 400 when supplier is not active', async () => {
      req.body = validBookingBody;
      prisma.tour.findFirst.mockResolvedValue({
        ...mockTour,
        supplier: { supplierProfile: { status: 'SUSPENDED' } },
      });

      await controller.confirmBooking(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 400 when payment fails', async () => {
      req.body = validBookingBody;
      createPaymentIntent.mockRejectedValue(new Error('Insufficient funds'));

      await controller.confirmBooking(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 400 on availability conflict', async () => {
      req.body = validBookingBody;
      checkTourAvailability.mockResolvedValue({ available: false, reason: 'Fully booked' });

      await controller.confirmBooking(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('releases the booking with a 400 when the card is declined', async () => {
      req.body = validBookingBody;
      getStripe().paymentIntents.confirm.mockRejectedValue(new Error('Your card was declined.'));
      getStripe().paymentIntents.retrieve.mockResolvedValue({ id: 'pi_mock_123', status: 'requires_payment_method', client_secret: 'cs_mock_123' });
      prisma.booking.updateMany.mockResolvedValue({ count: 1 });

      await controller.confirmBooking(req, res, next);

      expect(prisma.booking.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'PENDING', paymentStatus: 'PENDING', stripePaymentIntentId: 'pi_mock_123' }),
          data: expect.objectContaining({ status: 'CANCELLED', paymentStatus: 'FAILED', cancellationReason: 'Payment declined' }),
        }),
      );
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, message: 'Payment was declined. Please try another card.' }));
      expect(res.status).not.toHaveBeenCalledWith(201);
    });

    it('returns requiresAction with the client secret for a 3DS challenge', async () => {
      req.body = validBookingBody;
      getStripe().paymentIntents.confirm.mockRejectedValue(new Error('authentication_required'));
      getStripe().paymentIntents.retrieve.mockResolvedValue({ id: 'pi_mock_123', status: 'requires_action', client_secret: 'cs_mock_123' });

      await controller.confirmBooking(req, res, next);

      const jsonArg = res.json.mock.calls[0][0];
      expect(res.status).toHaveBeenCalledWith(201);
      expect(jsonArg.data.paymentIntent).toEqual({
        id: 'pi_mock_123',
        clientSecret: 'cs_mock_123',
        status: 'requires_action',
        requiresAction: true,
      });
      expect(prisma.booking.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('getExpeditionWishlist', () => {
    it('returns wishlist tours filtered to Expedition', async () => {
      const added1 = new Date('2026-01-02T10:00:00Z');
      const mockItems = [
        { id: 'wi1', addedAt: added1, tour: { id: 'tour-1', title: 'Tour One', slug: 'tour-one', description: 'A tour', status: 'ACTIVE', coverPhoto: 'a.jpg', photos: [], category: 'Nature', durationMinutes: 120, schedulesAndPricing: {}, averageRating: 4.5, reviewCount: 10, viewCount: 5, city: 'Accra', country: 'Ghana', supplier: { name: 'Supplier 1', photoURL: 's.jpg' } } },
      ];
      prisma.wishlistItem.findMany.mockResolvedValue(mockItems);

      await controller.getExpeditionWishlist(req, res, next);

      expect(prisma.wishlistItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: 'user-1',
            tour: {
              status: { not: 'DRAFT' },
              expeditionTour: { isActive: true },
            },
          }),
          orderBy: { addedAt: 'desc' },
        })
      );
      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.results).toBe(1);
      expect(body.data.tours[0]).toEqual(expect.objectContaining({ id: 'tour-1', addedAt: added1 }));
    });

    it('returns empty array when wishlist is empty', async () => {
      prisma.wishlistItem.findMany.mockResolvedValue([]);

      await controller.getExpeditionWishlist(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ results: 0, data: { tours: [] } })
      );
    });

    it('drops wishlist items whose tour is missing', async () => {
      prisma.wishlistItem.findMany.mockResolvedValue([
        { id: 'wi1', addedAt: new Date(), tour: null },
      ]);

      await controller.getExpeditionWishlist(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.data.tours).toEqual([]);
      expect(body.results).toBe(0);
    });
  });

  describe('toggleExpeditionWishlist', () => {
    it('adds a tour to wishlist', async () => {
      req.params.tourId = 'tour-2';
      prisma.expeditionTour.findFirst.mockResolvedValue(mockExpeditionTour);
      prisma.wishlistItem.findUnique.mockResolvedValue(null);
      prisma.wishlistItem.create.mockResolvedValue({ id: 'wi1' });

      await controller.toggleExpeditionWishlist(req, res, next);

      expect(prisma.expeditionTour.findFirst).toHaveBeenCalledWith({
        where: { tourId: 'tour-2', isActive: true },
        select: { id: true },
      });
      expect(prisma.wishlistItem.create).toHaveBeenCalledWith({
        data: { userId: 'user-1', tourId: 'tour-2' },
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.wishlist_added', metadata: { tourId: 'tour-2', source: 'expedition' } }));
    });

    it('removes a tour from wishlist', async () => {
      req.params.tourId = 'tour-1';
      prisma.expeditionTour.findFirst.mockResolvedValue(mockExpeditionTour);
      prisma.wishlistItem.findUnique.mockResolvedValue({ id: 'wi1' });
      prisma.wishlistItem.delete.mockResolvedValue({ id: 'wi1' });

      await controller.toggleExpeditionWishlist(req, res, next);

      expect(prisma.wishlistItem.delete).toHaveBeenCalledWith({ where: { id: 'wi1' } });
      expect(prisma.wishlistItem.create).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.wishlist_removed' }));
    });

    it('returns 404 when tour not on Expedition', async () => {
      req.params.tourId = 'tour-99';
      prisma.expeditionTour.findFirst.mockResolvedValue(null);

      await controller.toggleExpeditionWishlist(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  describe('searchTours', () => {
    it('searches tours excluding already curated', async () => {
      req.query = { q: 'test' };

      await controller.searchTours(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('getAdminTours', () => {
    it('returns paginated expedition tours', async () => {
      await controller.getAdminTours(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('addTour', () => {
    it('adds a tour to expedition', async () => {
      req.body = { tourId: 'tour-2' };
      prisma.tour.findUnique.mockResolvedValue(mockTour);
      prisma.expeditionTour.findFirst.mockResolvedValue(null);
      prisma.expeditionTour.findUnique.mockResolvedValue(null);

      await controller.addTour(req, res, next);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(cache.invalidateKeys).toHaveBeenCalled();
    });

    it('returns 400 when tourId missing', async () => {
      req.body = {};

      await controller.addTour(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 404 when tour not found', async () => {
      req.body = { tourId: 'non-existent' };
      prisma.tour.findUnique.mockResolvedValue(null);

      await controller.addTour(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 409 when already added', async () => {
      req.body = { tourId: 'tour-1' };
      prisma.tour.findUnique.mockResolvedValue(mockTour);
      prisma.expeditionTour.findFirst.mockResolvedValue(mockExpeditionTour);

      await controller.addTour(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
    });
  });

  describe('updateTour', () => {
    it('updates expedition tour fields', async () => {
      req.params.id = 'et-1';
      req.body = { displayOrder: 2, isFeatured: true };

      await controller.updateTour(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(cache.invalidateKeys).toHaveBeenCalled();
    });

    it('returns 404 when not found', async () => {
      req.params.id = 'non-existent';
      prisma.expeditionTour.findUnique.mockResolvedValue(null);

      await controller.updateTour(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  describe('removeTour', () => {
    it('removes expedition tour and invalidates cache', async () => {
      req.params.id = 'et-1';

      await controller.removeTour(req, res, next);

      expect(res.status).toHaveBeenCalledWith(204);
      expect(cache.invalidateKeys).toHaveBeenCalled();
    });

    it('returns 404 when not found', async () => {
      req.params.id = 'non-existent';
      prisma.expeditionTour.findUnique.mockResolvedValue(null);

      await controller.removeTour(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  describe('refreshCache', () => {
    it('clears all caches', async () => {
      req.params.tourId = 'all';

      await controller.refreshCache(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(cache.invalidateKeys).toHaveBeenCalled();
    });

    it('clears specific tour cache', async () => {
      req.params.tourId = 'et-1';

      await controller.refreshCache(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(cache.invalidateKeys).toHaveBeenCalled();
    });

    it('returns 404 for invalid tour id', async () => {
      req.params.tourId = 'non-existent';
      prisma.expeditionTour.findUnique.mockResolvedValue(null);

      await controller.refreshCache(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  describe('getMyBookings', () => {
    const mockBooking = {
      id: 'booking-1',
      bookingNumber: 'TB00000001ABCD',
      customerId: 'user-1',
      tourId: 'tour-1',
      source: 'EXPEDITION',
      status: 'CONFIRMED',
      paymentStatus: 'SUCCEEDED',
      travelers: { adults: 2, children: 0, infants: 0 },
      selectedDate: new Date('2026-08-15'),
      subtotal: 100,
      taxes: 0,
      fees: 5,
      discounts: 0,
      total: 105,
      currency: 'USD',
      createdAt: new Date(),
      tour: {
        id: 'tour-1',
        title: 'Test Tour',
        slug: 'test-tour',
        coverPhoto: '/test.jpg',
        photos: [],
        category: 'Adventure',
        durationMinutes: 120,
        city: 'Cape Town',
        country: 'South Africa',
        supplier: { id: 'supplier-1', name: 'Test Supplier', photoURL: '/supplier.jpg' },
      },
    };

    it('returns paginated bookings filtered by source EXPEDITION', async () => {
      req.query = { page: '1', limit: '10' };
      prisma.booking.findMany.mockResolvedValue([mockBooking]);
      prisma.booking.count.mockResolvedValue(1);

      await controller.getMyBookings(req, res, next);

      expect(prisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ customerId: 'user-1', source: 'EXPEDITION' }),
          skip: 0,
          take: 10,
        })
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          data: { bookings: [mockBooking] },
          pagination: expect.objectContaining({ currentPage: 1, totalPages: 1, totalCount: 1, limit: 10 }),
        })
      );
    });

    it('filters by status when provided', async () => {
      req.query = { status: 'CONFIRMED' };
      prisma.booking.findMany.mockResolvedValue([mockBooking]);
      prisma.booking.count.mockResolvedValue(1);

      await controller.getMyBookings(req, res, next);

      expect(prisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'CONFIRMED' }),
        })
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns empty array when no bookings', async () => {
      prisma.booking.findMany.mockResolvedValue([]);
      prisma.booking.count.mockResolvedValue(0);

      await controller.getMyBookings(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { bookings: [] },
          pagination: expect.objectContaining({ currentPage: 1, totalPages: 0, totalCount: 0 }),
        })
      );
    });
  });

  describe('getBooking', () => {
    const mockBookingDetail = {
      id: 'booking-1',
      bookingNumber: 'TB00000001ABCD',
      customerId: 'user-1',
      tourId: 'tour-1',
      source: 'EXPEDITION',
      status: 'CONFIRMED',
      paymentStatus: 'SUCCEEDED',
      travelers: { adults: 2 },
      selectedDate: new Date('2026-08-15'),
      total: 105,
      currency: 'USD',
      createdAt: new Date(),
      tour: {
        id: 'tour-1',
        title: 'Test Tour',
        slug: 'test-tour',
        coverPhoto: '/test.jpg',
        photos: [],
        category: 'Adventure',
        durationMinutes: 120,
        city: 'Cape Town',
        country: 'South Africa',
        supplier: { id: 'supplier-1', name: 'Test Supplier', photoURL: '/supplier.jpg', phone: '+123', email: 'test@test.com' },
      },
      review: null,
    };

    it('returns booking detail when found', async () => {
      req.params.id = 'booking-1';
      prisma.booking.findFirst.mockResolvedValue(mockBookingDetail);

      await controller.getBooking(req, res, next);

      expect(prisma.booking.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'booking-1', customerId: 'user-1', source: 'EXPEDITION' } })
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'success', data: { booking: mockBookingDetail } })
      );
    });

    it('returns 404 when booking not found', async () => {
      req.params.id = 'non-existent';
      prisma.booking.findFirst.mockResolvedValue(null);

      await controller.getBooking(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 404 when booking belongs to another user', async () => {
      req.params.id = 'booking-2';
      prisma.booking.findFirst.mockResolvedValue(null);

      await controller.getBooking(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  describe('cancelBooking', () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);

    const cancelBookingData = {
      id: 'booking-1',
      bookingNumber: 'TB00000001ABCD',
      customerId: 'user-1',
      tourId: 'tour-1',
      source: 'EXPEDITION',
      status: 'CONFIRMED',
      paymentStatus: 'SUCCEEDED',
      selectedDate: futureDate,
      total: 105,
      stripePaymentIntentId: 'pi_mock_123',
      tour: {
        id: 'tour-1',
        title: 'Test Tour',
        bookingAndTickets: null,
        supplier: { id: 'supplier-1', name: 'Test Supplier' },
      },
    };

    const updatedCancelBooking = {
      ...cancelBookingData,
      status: 'CANCELLED',
      cancellationReason: 'Change of plans',
      cancelledAt: new Date(),
    };

    it('cancels booking and processes refund', async () => {
      req.params.id = 'booking-1';
      req.body = { reason: 'Change of plans' };
      prisma.booking.findFirst.mockResolvedValue(cancelBookingData);
      prisma.booking.update.mockResolvedValue(updatedCancelBooking);
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));

      await controller.cancelBooking(req, res, next);

      expect(createRefund).toHaveBeenCalledWith('pi_mock_123', 10500);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'success', data: { booking: updatedCancelBooking } })
      );
    });

    it('returns 404 when booking not found', async () => {
      req.params.id = 'non-existent';
      prisma.booking.findFirst.mockResolvedValue(null);

      await controller.cancelBooking(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 404 when booking belongs to another user or is not Expedition', async () => {
      req.params.id = 'booking-2';
      prisma.booking.findFirst.mockResolvedValue(null);

      await controller.cancelBooking(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 400 when within cancellation window', async () => {
      const soonDate = new Date();
      soonDate.setHours(soonDate.getHours() + 1);
      const soonBooking = { ...cancelBookingData, selectedDate: soonDate };
      req.params.id = 'booking-1';
      req.body = {};
      prisma.booking.findFirst.mockResolvedValue(soonBooking);
      evaluateCancellationPolicy.mockReturnValueOnce({
        allowed: false,
        refundAmount: 0,
        refundPercentage: 0,
        reason: 'Cancellation not allowed within 24 hours of tour',
        windowHours: 24,
      });

      await controller.cancelBooking(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('cancels an all-sales-final booking without issuing a refund', async () => {
      const finalSaleBooking = {
        ...cancelBookingData,
        total: 105,
        tour: {
          ...cancelBookingData.tour,
          bookingAndTickets: {
            cancellationPolicy: { type: 'all_sales_final', label: 'No refunds', cancellationWindowHours: 0, refundPercentage: 0 },
          },
        },
      };
      req.params.id = 'booking-1';
      req.body = { reason: 'Change of plans' };
      prisma.booking.findFirst.mockResolvedValue(finalSaleBooking);
      evaluateCancellationPolicy.mockReturnValueOnce({
        allowed: true,
        refundAmount: 0,
        refundPercentage: 0,
        reason: 'No refund - all sales final',
        windowHours: 0,
      });
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma));

      await controller.cancelBooking(req, res, next);

      expect(createRefund).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});

