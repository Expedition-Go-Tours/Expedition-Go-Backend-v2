jest.mock('../../src/core/services/prismaClient', () => ({
  travioGhanaTour: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
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
  specialOffer: { update: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
  payoutRequestItem: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
  payoutRequest: { updateMany: jest.fn().mockResolvedValue({ count: 0 }), update: jest.fn().mockResolvedValue({}) },
  checkoutDraft: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  $transaction: jest.fn(),
  $queryRawUnsafe: jest.fn(),
}));

jest.mock('../../src/core/services/cacheHelper', () => ({
  getOrSet: jest.fn((key, fn) => fn()),
  invalidateKeys: jest.fn(() => Promise.resolve()),
}));
const cache = require('../../src/core/services/cacheHelper');

jest.mock('../../src/core/services/imageOptimizer', () => ({ cloudinaryUrl: jest.fn((url) => url) }));
jest.mock('../../src/core/services/eventEmitter', () => ({ emit: jest.fn(), emitBatch: jest.fn() }));
jest.mock('../../src/core/services/emailService', () => ({
  sendEmail: jest.fn(() => Promise.resolve()),
  // cancelBooking destructures these; a partial mock makes the call throw
  // synchronously rather than reject, which .catch() would not absorb.
  sendSupplierCustomerCancelledFreeEmail: jest.fn(() => Promise.resolve()),
  sendSupplierCustomerCancelledLateEmail: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/discordNotifier', () => ({
  notifyDiscord: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/queue', () => ({
  enqueueEvent: jest.fn(() => Promise.resolve()),
  enqueueEmail: jest.fn(() => Promise.resolve()),
  enqueueNotification: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../src/core/services/bookingHelpers', () => ({
  validateTravelerInfo: jest.fn(),
  generateBookingNumber: jest.fn(),
  evaluateCancellationPolicy: jest.fn(() => ({ allowed: true, refundAmount: 105, refundPercentage: 100, reason: 'Full refund available', windowHours: 24 })),
  evaluateModifyPolicy: jest.fn(() => ({ allowed: true, reason: null, cutoffHours: 24, deadline: null })),
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
  getStripe: jest.fn(() => ({ paymentIntents: { confirm: jest.fn(), retrieve: jest.fn(), update: jest.fn(() => Promise.resolve({})) }, checkout: { sessions: { create: jest.fn(), retrieve: jest.fn() } }, refunds: { create: jest.fn() } })),
}));
jest.mock('../../src/core/services/getConfig', () => jest.fn((key, def) => Promise.resolve(def)));
jest.mock('../../src/core/services/auditLogger', () => ({ logActivity: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/core/services/checkoutHold', () => ({ acquireHold: jest.fn(), releaseHold: jest.fn(), HOLD_MINUTES: 30 }));
jest.mock('../../src/core/services/availabilityCalendar', () => ({ buildAvailabilityCalendar: jest.fn(() => Promise.resolve([])) }));

const prisma = require('../../src/core/services/prismaClient');
const controller = require('../../src/brands/ghana/controller');

const mockTour = {
  id: 'tour-1',
  title: 'Test Tour',
  slug: 'test-tour',
  description: 'A fantastic test tour',
  coverPhoto: 'https://res.cloudinary.com/test/tour.jpg',
  photos: ['https://res.cloudinary.com/test/tour1.jpg'],
  category: 'Adventure',
  durationMinutes: 120,
  averageRating: 4.5,
  reviewCount: 10,
  city: 'Accra',
  country: 'Ghana',
  schedulesAndPricing: { pricingSchedules: { currency: 'USD', schedules: [{ prices: [{ retailPrice: 50 }] }] } },
  supplier: { id: 'supplier-1', name: 'Test Supplier', photoURL: null },
  status: 'ACTIVE',
};

const mockGhanaTour = {
  id: 'gt-1',
  tourId: 'tour-1',
  displayOrder: 1,
  isFeatured: false,
  isActive: true,
  tour: mockTour,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('travioGhanaController (Phase 1b characterization)', () => {
  let req, res;

  beforeEach(() => {
    req = { query: {}, params: {}, body: {}, user: { id: 'user-1', roles: ['customer'] }, headers: {}, ip: '127.0.0.1' };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() };
    jest.clearAllMocks();
    prisma.travioGhanaTour.findMany.mockResolvedValue([mockGhanaTour]);
    prisma.travioGhanaTour.findUnique.mockResolvedValue(mockGhanaTour);
    prisma.travioGhanaTour.findFirst.mockResolvedValue(mockGhanaTour);
    prisma.travioGhanaTour.count.mockResolvedValue(1);
    prisma.tour.findMany.mockResolvedValue([mockTour]);
    prisma.tour.findFirst.mockResolvedValue(mockTour);
  });

  it('exports every function the Ghana storefront routes reference', () => {
    const need = ['calculateCheckout', 'cancelBooking', 'confirmBooking', 'getBooking', 'getBookingBySession', 'getFeaturedTours', 'getMyBookings', 'getSimilarTours', 'getSitemap', 'getSupplierBookings', 'getTourAvailability', 'getTourBadges', 'getTourBySlug', 'getTourReviews', 'getTours', 'getWishlist', 'submitContact', 'subscribe', 'toggleWishlist', 'trackClick', 'updateBookingStatus'];
    for (const name of need) expect(typeof controller[name]).toBe('function');
  });

  it('shared getFeaturedTours queries the Ghana listing model (travioGhanaTour)', async () => {
    await controller.getFeaturedTours(req, res);
    expect(prisma.travioGhanaTour.findMany).toHaveBeenCalled();
    expect(prisma.expeditionTour).toBeUndefined();
  });

  it('shared getSitemap queries the Ghana listing model (travioGhanaTour)', async () => {
    prisma.travioGhanaTour.findMany.mockResolvedValue([{ tour: { slug: 'test-tour' }, updatedAt: new Date() }]);
    await controller.getSitemap(req, res);
    expect(prisma.travioGhanaTour.findMany).toHaveBeenCalled();
  });

  /**
   * `Tour.combinedRating` / `Tour.combinedReviewCount` exist, the nightly sync
   * populates them, and `core/storefront.js` already emits them — but neither
   * Ghana mapper read them, so the API answered `null/0` and the prerenderer's
   * `if (ratingValue && reviewCountValue)` gate never fired. All 32 tour pages
   * therefore published no AggregateRating at all, which is what Search Console
   * was reporting. These pin the wiring at both ends: the query selects the
   * columns, and the row hands them on.
   */
  describe('the combined standing reaches the API', () => {
    // `getTourBySlug` increments the view count and sets a Cache-Control header
    // after it builds the response; the shared harness stubs neither.
    beforeEach(() => {
      res.set = jest.fn().mockReturnThis();
      prisma.tour.update.mockResolvedValue({});
    });

    it('selects combinedRating and combinedReviewCount on the list query', async () => {
      await controller.getTours(req, res);
      const select = prisma.travioGhanaTour.findMany.mock.calls[0][0].include.tour.select;
      expect(select.combinedRating).toBe(true);
      expect(select.combinedReviewCount).toBe(true);
      // Additive, not a replacement: callers reading the internal standing must
      // keep getting it, or the storefront would double-count.
      expect(select.averageRating).toBe(true);
      expect(select.reviewCount).toBe(true);
    });

    it('returns them on a list row beside the untouched internal standing', async () => {
      prisma.travioGhanaTour.findMany.mockResolvedValue([
        { ...mockGhanaTour, tour: { ...mockTour, combinedRating: 4.8, combinedReviewCount: 799 } },
      ]);
      await controller.getTours(req, res);
      const row = res.json.mock.calls[res.json.mock.calls.length - 1][0].data.tours[0].tour;
      expect(row.combinedRating).toBe(4.8);
      expect(row.combinedReviewCount).toBe(799);
      expect(row.averageRating).toBe(4.5);
      expect(row.reviewCount).toBe(10);
    });

    it('reports null and 0 when the database holds no external standing', async () => {
      await controller.getTours(req, res);
      const row = res.json.mock.calls[res.json.mock.calls.length - 1][0].data.tours[0].tour;
      expect(row.combinedRating).toBeNull();
      expect(row.combinedReviewCount).toBe(0);
    });

    it('passes them on the detail the prerenderer reads', async () => {
      req.params.slug = 'test-tour';
      prisma.travioGhanaTour.findFirst.mockResolvedValue({
        ...mockGhanaTour,
        tour: { ...mockTour, combinedRating: 4.7, combinedReviewCount: 211, _count: { reviews: 0 } },
      });
      await controller.getTourBySlug(req, res);
      const tour = res.json.mock.calls[res.json.mock.calls.length - 1][0].data.tour.tour;
      expect(tour.combinedRating).toBe(4.7);
      expect(tour.combinedReviewCount).toBe(211);
    });

    it('gives the tour schema the combined standing, not the internal one', async () => {
      req.params.slug = 'test-tour';
      prisma.travioGhanaTour.findFirst.mockResolvedValue({
        ...mockGhanaTour,
        tour: { ...mockTour, combinedRating: 4.7, combinedReviewCount: 211, _count: { reviews: 0 } },
      });
      await controller.getTourBySlug(req, res);
      const schema = res.json.mock.calls[res.json.mock.calls.length - 1][0].data.tour.tourSchema;
      expect(schema.aggregateRating.ratingValue).toBe(4.7);
      expect(schema.aggregateRating.reviewCount).toBe(211);
    });
  });

  // Ghana's getTourBySlug is a hand-rolled override of the shared storefront
  // handler, and it used to match on `slug` alone. Both storefronts publish
  // /tour/{id}/{slug} and their detail pages pass the id straight through, so
  // every tour page view on expeditiongotours.com and travioghana.com fired a
  // 404 against /api/travioghana/tours/{id} and silently fell back to the
  // generic /api/tours/{id} endpoint, losing the curated `options` payload.
  // /reviews, /similar and /availability resolve the same id correctly, which
  // is what made the detail endpoint the odd one out.
  describe('getTourBySlug resolves a tour by slug or by id', () => {
    const ID = 'cmt8hjkii00bo646phdiznmrr';
    let next;

    beforeEach(() => {
      res.set = jest.fn().mockReturnThis();
      prisma.tour.update.mockResolvedValue({});
      // Declared in the outer beforeEach; reassigned per test so the
      // not-called assertion below can't be satisfied by a stale reference.
      next = jest.fn();
    });

    it('matches the param against the slug OR the id, not the slug alone', async () => {
      req.params.slug = ID;
      await controller.getTourBySlug(req, res, next);
      const tour = prisma.travioGhanaTour.findFirst.mock.calls[0][0].where.tour;
      expect(tour.OR).toEqual([{ slug: ID }, { id: ID }]);
      // The rest of the visibility gate must survive the spread.
      expect(tour.status).toBe('ACTIVE');
      expect(tour.supplier).toEqual({ supplierProfile: { status: 'ACTIVE' } });
    });

    // The prisma mock returns whatever it is told, so a where-clause bug is
    // invisible unless the mock honours it. Make findFirst respect the OR the
    // way the real query would: the row only comes back when the param matches
    // its slug OR its id. A slug-only where clause then reproduces the live
    // 404 exactly, which is what made this worth pinning.
    const honourWhere = () => {
      // The tour row carries the id under test, so the mock can only match it
      // through the id branch of the OR. When the handler passes a bare
      // `tour: { slug }` instead, the mock must fall back to slug-only
      // matching — which is exactly what Prisma would do, and what makes this
      // reproduce the live 404 rather than passing on a mock that agrees with
      // whatever it is handed.
      const row = { ...mockGhanaTour, tour: { ...mockTour, id: ID } };
      prisma.travioGhanaTour.findFirst.mockImplementation(({ where }) => {
        const t = where?.tour || {};
        const matches = t.OR
          ? t.OR.some((c) => c.slug === row.tour.slug || c.id === row.tour.id)
          : t.slug === row.tour.slug;
        return Promise.resolve(matches ? row : null);
      });
      return row;
    };

    it('serves the id-based request instead of 404ing', async () => {
      const row = honourWhere();
      req.params.slug = ID;
      await controller.getTourBySlug(req, res, next);
      expect(next).not.toHaveBeenCalled();
      const body = res.json.mock.calls[res.json.mock.calls.length - 1][0];
      expect(body.status).toBe('success');
      expect(body.data.tour.tour.id).toBe(row.tour.id);
    });

    it('serves the slug-based request the same way', async () => {
      honourWhere();
      req.params.slug = mockTour.slug;
      await controller.getTourBySlug(req, res, next);
      expect(next).not.toHaveBeenCalled();
      const body = res.json.mock.calls[res.json.mock.calls.length - 1][0];
      expect(body.status).toBe('success');
    });

    it('still resolves the slug', async () => {
      req.params.slug = 'test-tour';
      await controller.getTourBySlug(req, res, next);
      const tour = prisma.travioGhanaTour.findFirst.mock.calls[0][0].where.tour;
      expect(tour.OR).toEqual([{ slug: 'test-tour' }, { id: 'test-tour' }]);
    });

    it('404s a genuinely unknown id', async () => {
      req.params.slug = ID;
      prisma.travioGhanaTour.findFirst.mockResolvedValue(null);
      await controller.getTourBySlug(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    // invalidateCaches() only purges the slug-keyed entry, so an id-keyed
    // cached copy would survive a supplier's edit until its TTL expired —
    // exactly the staleness the storefront's `cache: 'no-store'` detail fetch
    // exists to prevent.
    it('caches a slug request but never caches an id request', async () => {
      req.params.slug = 'test-tour';
      await controller.getTourBySlug(req, res, next);
      expect(cache.getOrSet).toHaveBeenCalledWith(expect.stringContaining('detail:test-tour'), expect.any(Function), 300);

      jest.clearAllMocks();
      prisma.travioGhanaTour.findFirst.mockResolvedValue(mockGhanaTour);

      req.params.slug = ID;
      await controller.getTourBySlug(req, res, next);
      expect(cache.getOrSet).not.toHaveBeenCalled();
      expect(prisma.travioGhanaTour.findFirst).toHaveBeenCalledTimes(1);
    });
  });
});

// The offer round-trip had never been proven end to end. The INCREMENT on
// checkout is covered by stripeHelpers.test.js, but nothing anywhere asserted
// that cancelling gives the capacity back — a leak there strands a capped
// offer at "sold out" forever, and production shows 0 bookings have ever
// applied an offer, so no live traffic would have revealed it either.
describe('cancelBooking gives back the offer capacity it consumed', () => {
  const offerBooking = {
    id: 'b-1',
    bookingNumber: 'TRG-0001-2026',
    customerId: 'user-1',
    status: 'CONFIRMED',
    paymentStatus: 'PENDING',
    refundStatus: null,
    grossAmount: 300,
    currency: 'USD',
    source: 'GHANA',
    leadTravelerName: 'Ama',
    appliedOfferId: 'offer-9',
    travelers: { adults: 2, children: 1, infants: 1 },
    tour: { id: 'tour-1', title: 'Safari', supplierId: 'sup-1', supplier: { id: 'sup-1' } },
  };

  let req, res, tx;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { params: { id: 'b-1' }, body: { reason: 'changed my mind' }, query: {}, user: { id: 'user-1' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() };
    tx = {
      booking: { update: jest.fn().mockResolvedValue({ ...offerBooking, cancelledAt: new Date() }) },
      payout: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      specialOffer: { update: jest.fn().mockResolvedValue({}) },
      payoutRequestItem: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        delete: jest.fn().mockResolvedValue({}),
      },
      payoutRequest: { updateMany: jest.fn().mockResolvedValue({ count: 0 }), update: jest.fn().mockResolvedValue({}) },
    };
    prisma.$transaction.mockImplementation(async (fn) => fn(tx));
    prisma.booking.findFirst.mockResolvedValue(offerBooking);
    prisma.booking.update.mockResolvedValue({});
    prisma.specialOffer.update.mockResolvedValue({});
  });

  it('releases one spot per traveller when an offer was applied', async () => {
    await controller.cancelBooking(req, res);

    expect(tx.specialOffer.update).toHaveBeenCalledWith({
      where: { id: 'offer-9' },
      data: { spotsSold: { decrement: 4 } },
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('leaves the offer untouched when the booking never applied one', async () => {
    prisma.booking.findFirst.mockResolvedValue({ ...offerBooking, appliedOfferId: null });

    await controller.cancelBooking(req, res);

    expect(tx.specialOffer.update).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
