const request = require('supertest');

jest.mock('../../utils/prismaClient', () => ({
  expeditionTour: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
  tour: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
  user: { findUnique: jest.fn(), update: jest.fn() },
  booking: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn(), deleteMany: jest.fn() },
  review: { findMany: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
  newsletterSubscriber: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  cartItem: { deleteMany: jest.fn() },
  $transaction: jest.fn(),
  $queryRawUnsafe: jest.fn(),
}));

jest.mock('../../utils/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url) => url) }));
jest.mock('../../utils/cacheHelper', () => ({ getOrSet: jest.fn((key, fn) => fn()), invalidateKeys: jest.fn() }));
jest.mock('../../utils/emailService', () => ({ sendEmail: jest.fn(() => Promise.resolve()) }));
jest.mock('../../utils/queue', () => ({ enqueueEvent: jest.fn(() => Promise.resolve()), enqueueEmail: jest.fn(() => Promise.resolve()), enqueueNotification: jest.fn(() => Promise.resolve()) }));
jest.mock('../../utils/bookingHelpers', () => ({ validateTravelerInfo: jest.fn(), generateBookingNumber: jest.fn() }));
jest.mock('../../utils/tourHelpers', () => ({ checkTourAvailability: jest.fn(), calculateTourPrice: jest.fn() }));
jest.mock('../../utils/stripeHelpers', () => ({ createPaymentIntent: jest.fn(), createRefund: jest.fn(), calculateCommission: jest.fn() }));
jest.mock('../../utils/getConfig', () => jest.fn((key, def) => Promise.resolve(def)));
jest.mock('../../utils/availabilityCalendar', () => ({ buildAvailabilityCalendar: jest.fn(() => Promise.resolve([])) }));
jest.mock('../../utils/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));

const app = require('../../app');
const prisma = require('../../utils/prismaClient');
const tourHelpers = require('../../utils/tourHelpers');
const bookingHelpers = require('../../utils/bookingHelpers');
const stripeHelpers = require('../../utils/stripeHelpers');

const mockTour = {
  id: 'tour-1', title: 'Test Tour', slug: 'test-tour',
  description: 'A fantastic test tour',
  coverPhoto: '/test.jpg', photos: [], category: 'Adventure',
  durationMinutes: 120, averageRating: 4.5, reviewCount: 10,
  city: 'Cape Town', country: 'South Africa',
  schedulesAndPricing: {
    travelerDetails: { pricingModel: 'perPerson', maxTravelersPerBooking: 15, ageGroups: [] },
    pricingSchedules: { currency: 'USD', schedules: [{ startDate: '2026-01-01', endDate: '2026-12-31', prices: [{ ageGroup: 'Adult', retailPrice: 50 }] }] },
  },
  supplier: { id: 'supplier-1', name: 'Test', photoURL: '', supplierProfile: { status: 'ACTIVE' } },
  supplierId: 'supplier-1', status: 'ACTIVE',
};

const mockExpeditionTour = {
  id: 'et-1', tourId: 'tour-1', displayOrder: 1, isFeatured: false, isActive: true,
  tour: mockTour, addedBy: { id: 'admin-1', name: 'Admin', email: 'admin@test.com' },
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};

beforeEach(() => {
  jest.clearAllMocks();
  prisma.expeditionTour.findMany.mockResolvedValue([mockExpeditionTour]);
  prisma.expeditionTour.findFirst.mockResolvedValue(mockExpeditionTour);
  prisma.expeditionTour.create.mockResolvedValue(mockExpeditionTour);
  prisma.tour.findFirst.mockResolvedValue(mockTour);
  prisma.tour.findUnique.mockResolvedValue(mockTour);
  prisma.tour.findMany.mockResolvedValue([mockTour]);
  prisma.tour.count.mockResolvedValue(1);
  prisma.user.findUnique.mockResolvedValue({ id: 'user-1', wishlist: ['tour-1'] });
  prisma.user.update.mockResolvedValue({ wishlist: ['tour-1', 'tour-2'] });
  prisma.booking.findMany.mockResolvedValue([]);
  prisma.booking.findFirst.mockResolvedValue(null);
  prisma.booking.update.mockResolvedValue({});
  prisma.booking.count.mockResolvedValue(0);
  prisma.$queryRawUnsafe.mockResolvedValue([{ currentBookings: '0' }]);
  prisma.$transaction.mockImplementation(async (cb) => (typeof cb === 'function' ? cb(prisma) : cb));
  prisma.cartItem.deleteMany.mockResolvedValue({ count: 0 });
  tourHelpers.checkTourAvailability.mockResolvedValue({ available: true, availableSpots: 10 });
  tourHelpers.calculateTourPrice.mockResolvedValue({ success: true, currency: 'USD', subtotal: 100, fees: 5, discount: 0, total: 105 });
  bookingHelpers.validateTravelerInfo.mockReturnValue({ isValid: true, errors: [] });
  bookingHelpers.generateBookingNumber.mockResolvedValue('TB00000001ABCD');
  stripeHelpers.createPaymentIntent.mockResolvedValue({ id: 'pi_mock_123' });
  stripeHelpers.calculateCommission.mockResolvedValue({ rate: 0.15, amount: 15.75, supplierPayout: 89.25 });
});

describe('Expedition API — public endpoints', () => {
  describe('GET /api/expedition/tours', () => {
    it('returns 200 with tour list', async () => {
      const res = await request(app).get('/api/expedition/tours');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });
  });

  describe('GET /api/expedition/tours/featured', () => {
    it('returns 200 with featured tours', async () => {
      const res = await request(app).get('/api/expedition/tours/featured');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });
  });

  describe('POST /api/expedition/contact', () => {
    it('returns 200 on valid submission', async () => {
      const res = await request(app)
        .post('/api/expedition/contact')
        .send({ name: 'John', email: 'john@test.com', message: 'Hello, I have a question about your tours.' });
      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/expedition/track-click', () => {
    it('returns 204', async () => {
      const res = await request(app)
        .post('/api/expedition/track-click')
        .send({ event: 'cta', target: 'test-tour' });
      expect(res.status).toBe(204);
    });
  });

  describe('POST /api/expedition/checkout/calculate', () => {
    it('returns 200 on valid request', async () => {
      const res = await request(app)
        .post('/api/expedition/checkout/calculate')
        .send({ tourId: 'tour-1', selectedDate: '2026-08-15', travelers: { adults: 2 } });
      expect(res.status).toBe(200);
      expect(res.body.data.pricing.total).toBe(105);
    });
  });
});

describe('Expedition API — auth-gated endpoints', () => {
  describe('POST /api/expedition/checkout/confirm', () => {
    it('returns 401 without auth token', async () => {
      const res = await request(app)
        .post('/api/expedition/checkout/confirm')
        .send({ tourId: 'tour-1', selectedDate: '2026-08-15', travelers: { adults: 2, phoneNumber: '+123', location: 'Test' }, paymentMethodId: 'pm_123' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/expedition/wishlist', () => {
    it('returns 401 without auth token', async () => {
      const res = await request(app).get('/api/expedition/wishlist');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/expedition/bookings', () => {
    it('returns 401 without auth token', async () => {
      const res = await request(app).get('/api/expedition/bookings');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/expedition/bookings/:id', () => {
    it('returns 401 without auth token', async () => {
      const res = await request(app).get('/api/expedition/bookings/booking-1');
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /api/expedition/bookings/:id/cancel', () => {
    it('returns 401 without auth token', async () => {
      const res = await request(app).patch('/api/expedition/bookings/booking-1/cancel');
      expect(res.status).toBe(401);
    });
  });
});

describe('Expedition API — newsletter & availability', () => {
  describe('POST /api/expedition/subscribe', () => {
    it('returns 200 on valid email', async () => {
      prisma.newsletterSubscriber.findUnique.mockResolvedValue(null);
      prisma.newsletterSubscriber.create.mockResolvedValue({ id: 's1', email: 'test@test.com' });

      const res = await request(app)
        .post('/api/expedition/subscribe')
        .send({ email: 'test@test.com', name: 'John' });
      expect(res.status).toBe(200);
      expect(res.body.message).toContain('Thank you');
    });

    it('returns 400 on invalid email', async () => {
      const res = await request(app)
        .post('/api/expedition/subscribe')
        .send({ email: 'not-an-email' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/expedition/tours/:slug/availability', () => {
    it('returns 200 with calendar', async () => {
      prisma.expeditionTour.findFirst.mockResolvedValue({ tourId: 'tour-1' });
      prisma.tour.findUnique.mockResolvedValue({ id: 'tour-1', title: 'Test', schedulesAndPricing: {} });

      const res = await request(app)
        .get('/api/expedition/tours/test-tour/availability?startDate=2026-08-01&endDate=2026-08-07');
      expect(res.status).toBe(200);
      expect(res.body.data.calendar).toEqual([]);
    });

    it('returns 404 for non-existent tour', async () => {
      prisma.expeditionTour.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/expedition/tours/non-existent/availability?startDate=2026-08-01&endDate=2026-08-07');
      expect(res.status).toBe(404);
    });
  });
});

describe('Expedition API — discovery endpoints', () => {
  describe('GET /api/expedition/tours/:slug/reviews', () => {
    it('returns 200 with reviews for a valid tour', async () => {
      prisma.expeditionTour.findFirst.mockResolvedValue({ tourId: 'tour-1' });
      prisma.review.findMany.mockResolvedValue([{
        id: 'r1', rating: 5, title: 'Great', comment: 'Wow',
        photos: [], travelMonth: 'June', companions: [], verified: true,
        helpfulCount: 0, createdAt: new Date(),
        customer: { id: 'u1', name: 'John', photoURL: null },
      }]);
      prisma.review.count.mockResolvedValue(1);
      prisma.review.aggregate.mockResolvedValue({ _avg: { rating: 5 } });

      const res = await request(app).get('/api/expedition/tours/test-tour/reviews');
      expect(res.status).toBe(200);
      expect(res.body.data.reviews).toHaveLength(1);
      expect(res.body.data.averageRating).toBe(5);
    });

    it('returns 404 for non-existent tour', async () => {
      prisma.expeditionTour.findFirst.mockResolvedValue(null);

      const res = await request(app).get('/api/expedition/tours/non-existent/reviews');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/expedition/tours/:slug/similar', () => {
    it('returns 200 with similar tours', async () => {
      prisma.expeditionTour.findFirst.mockResolvedValue({
        tourId: 'tour-1',
        tour: { id: 'tour-1', category: 'Adventure' },
      });
      prisma.expeditionTour.findMany.mockResolvedValue([{
        id: 'et-2', tour: { id: 'tour-2', title: 'Similar Tour', slug: 'similar',
          coverPhoto: null, category: 'Adventure', durationMinutes: 120,
          averageRating: 4, reviewCount: 5, city: 'Cape Town', country: 'SA',
          schedulesAndPricing: {}, supplier: { name: 'Test', photoURL: null } },
      }]);

      const res = await request(app).get('/api/expedition/tours/test-tour/similar');
      expect(res.status).toBe(200);
      expect(res.body.data.tours).toHaveLength(1);
    });

    it('returns 404 for non-existent tour', async () => {
      prisma.expeditionTour.findFirst.mockResolvedValue(null);

      const res = await request(app).get('/api/expedition/tours/non-existent/similar');
      expect(res.status).toBe(404);
    });
  });
});
