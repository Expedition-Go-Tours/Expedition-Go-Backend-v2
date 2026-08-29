const express = require('express');
const { createLimiter } = require('../middleware/dynamicRateLimiter');
const { protect } = require('../middleware/authMiddleware');
const { restrictTo } = require('../middleware/authMiddleware');
const travioGhanaController = require('../controllers/travioGhanaController');
const travioGhanaHomepageController = require('../controllers/travioGhanaHomepageController');
const validate = require('../middleware/validate');
const {
  getToursSchema,
  contactSchema,
  trackClickSchema,
  calculateCheckoutSchema,
  confirmBookingSchema,
  tourIdParamSchema,
  searchToursSchema,
  getAdminToursSchema,
  addTourSchema,
  updateTourSchema,
  removeTourSchema,
  refreshCacheSchema,
  subscribeSchema,
  availabilityCalendarSchema,
  slugParamSchema,
  getTourReviewsSchema,
  getBookingsSchema,
  bookingIdParamSchema,
  cancelBookingSchema,
  createReviewSchema,
  getSupplierBookingsSchema,
  updateBookingStatusSchema,
  analyticsOverviewSchema,
  analyticsRevenueTrendSchema,
  analyticsFunnelSchema,
} = require('../utils/travioGhanaValidation');

const router = express.Router();

// Rate limiter for contact form (5 submissions per 15 min per IP, configurable via ratelimit.contact)
const contactLimiter = createLimiter({
  name: 'contact',
  defaultMax: 5,
  defaultWindowMs: 15 * 60 * 1000,
  message: {
    status: 'fail',
    message: 'Too many submissions from this IP, please try again later.',
  },
});

// ================================
// PUBLIC ROUTES
// ================================

/**
 * @swagger
 * /api/travioghana/tours:
 *   get:
 *     summary: List Travio Ghana tours
 *     description: |
 *       Returns paginated, filtered list of active Travio Ghana tours.
 *       Supports text search, category/city/country/price filters, and sorting.
 *       Results are ordered by `displayOrder` then `createdAt` descending.
 *       Cached in Redis for 300 seconds.
 *     tags: [Travio Ghana]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 50, default: 12 }
 *         description: Items per page
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Full-text search across title, description, city, country, category
 *       - in: query
 *         name: category
 *         schema: { type: string }
 *         description: Filter by tour category (e.g. Adventure, Cultural, Nature)
 *       - in: query
 *         name: city
 *         schema: { type: string }
 *         description: Filter by city
 *       - in: query
 *         name: country
 *         schema: { type: string }
 *         description: Filter by country
 *       - in: query
 *         name: minPrice
 *         schema: { type: number, minimum: 0 }
 *         description: Minimum starting price filter
 *       - in: query
 *         name: maxPrice
 *         schema: { type: number, minimum: 0 }
 *         description: Maximum starting price filter
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, enum: [price_asc, price_desc, rating, newest, popular] }
 *         description: Sort order
 *     responses:
 *       200:
 *         description: Paginated list of Travio Ghana tours
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 *                 results:
 *                   type: integer
 *                   example: 10
 *                 pagination:
 *                   $ref: '#/components/schemas/Pagination'
 *                 data:
 *                   type: object
 *                   properties:
 *                     tours:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/TravioGhanaTourListing'
 *       500:
 *         description: Server error
 */
// Homepage — Ghana-scoped sections, mirroring the shared /homepage/* routes
// (per-section endpoints + unified payload with all 9 section keys)
router.get('/homepage/sell-out', travioGhanaHomepageController.getSellOut);
router.get('/homepage/top-rated', travioGhanaHomepageController.getTopRated);
router.get('/homepage/trending', travioGhanaHomepageController.getTrending);
router.get('/homepage/recommended', travioGhanaHomepageController.getRecommended);
router.get('/homepage/new', travioGhanaHomepageController.getNew);
router.get('/homepage/attractions', travioGhanaHomepageController.getAttractions);
router.get('/homepage/attractions/tours', travioGhanaHomepageController.getAttractionTours);
router.get('/homepage/mood', travioGhanaHomepageController.getMood);
router.get('/homepage/destinations', travioGhanaHomepageController.getDestinations);
router.get('/homepage/offers', travioGhanaHomepageController.getOffers);
router.get('/homepage', travioGhanaHomepageController.getGhanaHomepage);

router.get('/tours', validate(getToursSchema), travioGhanaController.getTours);
router.get('/tours/badges', travioGhanaController.getTourBadges);

/**
 * @swagger
 * /api/travioghana/tours/featured:
 *   get:
 *     summary: Get featured Travio Ghana tours
 *     description: |
 *       Returns up to 8 tours marked as featured (`isFeatured: true`) and active,
 *       ordered by `displayOrder` ascending. Designed for hero/carousel sections.
 *       Cached in Redis for 300 seconds.
 *     tags: [Travio Ghana]
 *     responses:
 *       200:
 *         description: Featured tours list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 *                 data:
 *                   type: object
 *                   properties:
 *                     tours:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/TravioGhanaTourListing'
 */
router.get('/tours/featured', travioGhanaController.getFeaturedTours);

/**
 * @swagger
 * /api/travioghana/tours/sitemap:
 *   get:
 *     summary: Get Travio Ghana sitemap data
 *     description: |
 *       Returns an array of { slug, updatedAt } for all active Travio Ghana tours.
 *       Used by the frontend to generate a `sitemap.xml` for SEO.
 *       Cached in Redis for 3600 seconds.
 *     tags: [Travio Ghana]
 *     responses:
 *       200:
 *         description: Sitemap entries
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 *                 data:
 *                   type: object
 *                   properties:
 *                     tours:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/TravioGhanaSitemapEntry'
 */
router.get('/tours/sitemap', travioGhanaController.getSitemap);

/**
 * @swagger
 * /api/travioghana/tours/{slug}/reviews:
 *   get:
 *     summary: Get tour reviews
 *     description: |
 *       Returns paginated, approved reviews for a specific Travio Ghana tour.
 *       Includes customer name and photo for each review.
 *       Supports sorting by newest, highest rating, or lowest rating.
 *     tags: [Travio Ghana]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema: { type: string }
 *         description: Tour URL slug
 *         example: amazing-central-park-walking-tour
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 50, default: 10 }
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, enum: [newest, highest, lowest], default: newest }
 *     responses:
 *       200:
 *         description: Paginated reviews
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 *                 data:
 *                   type: object
 *                   properties:
 *                     reviews:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/TravioGhanaReview'
 *                     averageRating:
 *                       type: number
 *                       nullable: true
 *                       example: 4.5
 *                     totalCount:
 *                       type: integer
 *                       example: 15
 *                 pagination:
 *                   $ref: '#/components/schemas/Pagination'
 *       404:
 *         description: Tour not found
 */
router.get('/tours/:slug/reviews', validate(getTourReviewsSchema), travioGhanaController.getTourReviews);

/**
 * @swagger
 * /api/travioghana/tours/{slug}/similar:
 *   get:
 *     summary: Get similar tours
 *     description: |
 *       Returns up to 4 similar tours in the same category as the specified tour.
 *       Excludes the current tour. Useful for detail page "You may also like" sections.
 *     tags: [Travio Ghana]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema: { type: string }
 *         description: Tour URL slug
 *         example: amazing-central-park-walking-tour
 *     responses:
 *       200:
 *         description: Similar tours
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 *                 data:
 *                   type: object
 *                   properties:
 *                     tours:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/TravioGhanaTourListing'
 *       404:
 *         description: Tour not found
 */
router.get('/tours/:slug/similar', validate(slugParamSchema), travioGhanaController.getSimilarTours);

/**
 * @swagger
 * /api/travioghana/tours/{slug}/availability:
 *   get:
 *     summary: Get tour availability calendar
 *     description: |
 *       Returns a day-by-day availability calendar for a given Travio Ghana tour and date range.
 *       Max range of 31 days. Each day shows status (AVAILABLE, LIMITED, FULL, BLOCKED),
 *       remaining spots, and time slot info.
 *       Does not require authentication.
 *     tags: [Travio Ghana]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema: { type: string }
 *         description: Tour URL slug
 *       - in: query
 *         name: startDate
 *         required: true
 *         schema: { type: string, format: date }
 *         description: Start date (YYYY-MM-DD)
 *         example: '2026-08-01'
 *       - in: query
 *         name: endDate
 *         required: true
 *         schema: { type: string, format: date }
 *         description: End date (YYYY-MM-DD)
 *         example: '2026-08-31'
 *     responses:
 *       200:
 *         description: Availability calendar
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 *                 data:
 *                   type: object
 *                   properties:
 *                     tour:
 *                       type: object
 *                       properties:
 *                         id: { type: string }
 *                         title: { type: string }
 *                     startDate: { type: string }
 *                     endDate: { type: string }
 *                     calendar:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/TravioGhanaCalendarDay'
 *       400:
 *         description: Invalid date range
 *       404:
 *         description: Tour not found
 */
router.get('/tours/:slug/availability', validate(availabilityCalendarSchema), travioGhanaController.getTourAvailability);

/**
 * @swagger
 * /api/travioghana/tours/{slug}:
 *   get:
 *     summary: Get Travio Ghana tour by slug
 *     description: |
 *       Returns full tour details for a single Travio Ghana tour identified by its URL slug.
 *       Includes embedded JSON-LD structured data for rich search results.
 *       Tracks the view (IP + User-Agent dedup with 30-min cooldown).
 *       Cached in Redis for 300 seconds.
 *     tags: [Travio Ghana]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema: { type: string }
 *         description: Tour URL slug
 *         example: amazing-central-park-walking-tour
 *     responses:
 *       200:
 *         description: Full tour detail with JSON-LD
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 *                 data:
 *                   type: object
 *                   properties:
 *                     tour:
 *                       $ref: '#/components/schemas/Tour'
 *                     jsonLd:
 *                       type: object
 *                       description: Structured data for Google rich results
 *       404:
 *         description: Tour not found or not active
 */
router.get('/tours/:slug', validate(slugParamSchema), travioGhanaController.getTourBySlug);

/**
 * @swagger
 * /api/travioghana/contact:
 *   post:
 *     summary: Submit Travio Ghana contact form
 *     description: |
 *       Sends a contact/inquiry message to the Travio Ghana support team.
 *       Rate-limited to 5 submissions per 15 minutes per IP address.
 *       Sends an email notification to the support team.
 *     tags: [Travio Ghana]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, message]
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 100
 *                 example: Jane Doe
 *               email:
 *                 type: string
 *                 format: email
 *                 example: jane@example.com
 *               phone:
 *                 type: string
 *                 example: '+1-555-123-4567'
 *               subject:
 *                 type: string
 *                 maxLength: 200
 *                 example: Question about Kilimanjaro trek
 *               message:
 *                 type: string
 *                 minLength: 10
 *                 maxLength: 5000
 *                 example: I'd like to know more about the 7-day Kilimanjaro trek. Is accommodation included?
 *     responses:
 *       200:
 *         description: Message sent successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 *                 message: { type: string, example: Thank you for your message. We will get back to you soon! }
 *       429:
 *         description: Too many requests — rate limit exceeded
 */
router.post('/contact', contactLimiter, validate(contactSchema), travioGhanaController.submitContact);

/**
 * @swagger
 * /api/travioghana/subscribe:
 *   post:
 *     summary: Subscribe to Travio Ghana newsletter
 *     description: |
 *       Adds an email to the Travio Ghana newsletter subscriber list.
 *       If the email already exists but is unsubscribed, re-subscribes.
 *       Rate-limited to 10 submissions per minute per IP.
 *       Does not require authentication.
 *     tags: [Travio Ghana]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: jane@example.com
 *               name:
 *                 type: string
 *                 maxLength: 100
 *                 example: Jane Doe
 *     responses:
 *       200:
 *         description: Subscribed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 *                 message: { type: string, example: Thank you for subscribing! }
 *       400:
 *         description: Invalid email
 *       429:
 *         description: Too many requests
 */
const subscribeLimiter = createLimiter({
  name: 'subscribe',
  defaultMax: 10,
  defaultWindowMs: 60 * 1000,
  message: { status: 'fail', message: 'Too many subscription attempts, please try again later.' },
});
router.post('/subscribe', subscribeLimiter, validate(subscribeSchema), travioGhanaController.subscribe);

/**
 * @swagger
 * /api/travioghana/track-click:
 *   post:
 *     summary: Track a click event on Travio Ghana
 *     description: |
 *       Records a click event (e.g. call-to-action, external link) for analytics.
 *       Stores the click with IP, user agent, and optional metadata.
 *       Does not require authentication.
 *     tags: [Travio Ghana]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [event, target]
 *             properties:
 *               event:
 *                 type: string
 *                 description: Click event name
 *                 example: cta_book_now
 *               target:
 *                 type: string
 *                 description: Target identifier (tour slug, URL, etc.)
 *                 example: kilimanjaro-7-day-trek
 *               tourId:
 *                 type: string
 *                 description: Associated tour ID (optional)
 *                 example: cmp2hql3c0001tzv0460pbckm
 *               metadata:
 *                 type: object
 *                 description: Arbitrary extra data
 *     responses:
 *       200:
 *         description: Click recorded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 */
router.post('/track-click', validate(trackClickSchema), travioGhanaController.trackClick);

/**
 * @swagger
 * /api/travioghana/checkout/calculate:
 *   post:
 *     summary: Calculate checkout pricing
 *     description: |
 *       Public endpoint that returns a pricing breakdown for a given tour, date, and traveler composition.
 *       Checks availability and validates traveler count against remaining spots.
 *       Does NOT require authentication — usable before login.
 *     tags: [Travio Ghana]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tourId, travelDate, travelers]
 *             properties:
 *               tourId:
 *                 type: string
 *                 description: ID of the tour
 *                 example: cmp2hql3c0001tzv0460pbckm
 *               travelDate:
 *                 type: string
 *                 format: date
 *                 description: Desired tour date (YYYY-MM-DD)
 *                 example: '2026-08-15'
 *               travelers:
 *                 type: object
 *                 description: Traveler composition
 *                 required: [adults]
 *                 properties:
 *                   adults: { type: integer, minimum: 1, maximum: 50, example: 2 }
 *                   children: { type: integer, minimum: 0, maximum: 50, example: 1 }
 *                   infants: { type: integer, minimum: 0, maximum: 50, example: 0 }
 *     responses:
 *       200:
 *         description: Pricing breakdown with availability
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 *                 data:
 *                   $ref: '#/components/schemas/TravioGhanaCheckoutPricing'
 *       400:
 *         description: Invalid input or tour not available
 *       404:
 *         description: Tour not found
 */
const calculateLimiter = createLimiter({
  name: 'checkout-calculate',
  defaultMax: 30,
  defaultWindowMs: 60 * 1000,
  message: { status: 'fail', message: 'Too many pricing requests, please try again later.' },
});

const confirmLimiter = createLimiter({
  name: 'checkout-confirm',
  defaultMax: 10,
  defaultWindowMs: 60 * 1000,
  message: { status: 'fail', message: 'Too many booking attempts, please try again later.' },
});

router.post('/checkout/calculate', calculateLimiter, validate(calculateCheckoutSchema), travioGhanaController.calculateCheckout);

/**
 * @swagger
 * /api/travioghana/checkout/confirm:
 *   post:
 *     summary: Confirm a Travio Ghana booking
 *     description: |
 *       Authenticated endpoint that creates a booking with Stripe payment.
 *       Validates traveler info, checks availability with row-level locking,
 *       creates a Stripe PaymentIntent, and creates the booking record with `source: 'EXPEDITION'`.
 *       Sends a Travio Ghana-branded confirmation email and notifies the supplier.
 *     tags: [Travio Ghana]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tourId, travelDate, travelers, paymentMethodId]
 *             properties:
 *               tourId:
 *                 type: string
 *                 description: ID of the tour to book
 *                 example: cmp2hql3c0001tzv0460pbckm
 *               travelDate:
 *                 type: string
 *                 format: date
 *                 description: Tour date (YYYY-MM-DD)
 *                 example: '2026-08-15'
 *               travelers:
 *                 type: object
 *                 description: Traveler composition with contact info
 *                 required: [adults, phoneNumber, location]
 *                 properties:
 *                   adults: { type: integer, minimum: 1, example: 2 }
 *                   children: { type: integer, minimum: 0, example: 1 }
 *                   infants: { type: integer, minimum: 0, example: 0 }
 *                   phoneNumber: { type: string, example: '+1-555-123-4567' }
 *                   location: { type: string, example: 'New York, USA' }
 *                   details: { type: array, description: 'Per-traveler details', items: { type: object, properties: { name: { type: string }, age: { type: integer }, ageGroup: { type: string }, specialRequests: { type: string } } } }
 *               paymentMethodId:
 *                 type: string
 *                 description: Stripe PaymentMethod ID (tokenized card)
 *                 example: pm_1234567890abcdef
 *               specialRequests:
 *                 type: string
 *                 maxLength: 1000
 *                 example: Please arrange vegetarian meals for 2 travelers
 *     responses:
 *       201:
 *         description: Booking confirmed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 *                 data:
 *                   $ref: '#/components/schemas/TravioGhanaBookingResult'
 *       400:
 *         description: Validation error, availability conflict, or payment failure
 *       401:
 *         description: Authentication required
 *       404:
 *         description: Tour not found
 */
router.post('/checkout/confirm', confirmLimiter, protect, restrictTo('customer'), validate(confirmBookingSchema), travioGhanaController.confirmBooking);

/**
 * @swagger
 * /api/travioghana/wishlist:
 *   get:
 *     summary: Get Travio Ghana wishlist
 *     description: |
 *       Returns the authenticated user's wishlisted tours, filtered to only include
 *       tours that are available on Travio Ghana (`travioGhanaTours.some: { isActive: true }`).
 *       Tours are returned in the order they were added to the wishlist.
 *     tags: [Travio Ghana]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Wishlist tours filtered for Travio Ghana
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 *                 results: { type: integer, example: 3 }
 *                 data:
 *                   type: object
 *                   properties:
 *                     tours:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/TravioGhanaWishlistEntry'
 *       401:
 *         description: Authentication required
 */
router.get('/wishlist', protect, restrictTo('customer'), travioGhanaController.getExpeditionWishlist);

/**
 * @swagger
 * /api/travioghana/wishlist/{tourId}:
 *   patch:
 *     summary: Toggle tour in Travio Ghana wishlist
 *     description: |
 *       Add or remove a tour from the user's wishlist.
 *       Only works for tours that exist on Travio Ghana (active TravioGhanaTour record).
 *       If the tour is already wishlisted, it is removed; otherwise it is added.
 *     tags: [Travio Ghana]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: tourId
 *         required: true
 *         schema: { type: string }
 *         description: ID of the tour to toggle
 *         example: cmp2hql3c0001tzv0460pbckm
 *     responses:
 *       200:
 *         description: Wishlist toggled
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 *                 data:
 *                   type: object
 *                   properties:
 *                     wishlist:
 *                       type: array
 *                       items: { type: string }
 *                       description: Updated full wishlist array (all tour IDs, not just Travio Ghana)
 *                       example: ['cmp2hql3c0001tzv0460pbckm', 'cmp2hql3c0001tzv0460pbckn']
 *                     isWishlisted:
 *                       type: boolean
 *                       description: Whether the toggled tour is now in the wishlist
 *                       example: true
 *       401:
 *         description: Authentication required
 *       404:
 *         description: Tour not available on Travio Ghana
 */
router.patch('/wishlist/:tourId', protect, restrictTo('customer'), validate(tourIdParamSchema), travioGhanaController.toggleExpeditionWishlist);

/**
 * @swagger
 * /api/travioghana/bookings:
 *   get:
 *     summary: Get my Travio Ghana bookings
 *     description: |
 *       Returns the authenticated user's bookings placed through Travio Ghana (`source: EXPEDITION`).
 *       Paginated and sorted by most recent. Optionally filter by status.
 *     tags: [Travio Ghana]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 10 }
 *         description: Items per page
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [PENDING, CONFIRMED, CANCELLED, REFUNDED, COMPLETED, NO_SHOW] }
 *         description: Filter by booking status
 *     responses:
 *       200:
 *         description: Paginated list of user's Travio Ghana bookings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 *                 data:
 *                   type: object
 *                   properties:
 *                     bookings:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/TravioGhanaBookingSummary'
 *                 pagination:
 *                   $ref: '#/components/schemas/Pagination'
 *       401:
 *         description: Authentication required
 */
router.get('/bookings', protect, restrictTo('customer'), validate(getBookingsSchema), travioGhanaController.getMyBookings);

/**
 * @swagger
 * /api/travioghana/bookings/by-session/{sessionId}:
 *   get:
 *     summary: Get checkout status by Stripe session id
 *     description: |
 *       Returns the checkout draft status (HOLDING / PAID / EXPIRED / REFUNDED)
 *       for a pay-now session. The frontend polls this endpoint after Stripe
 *       redirects back until the webhook materializes a Booking.
 *     tags: [Travio Ghana]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *         description: Stripe Checkout Session id
 *     responses:
 *       200:
 *         description: Checkout status
 *       404:
 *         description: Session not found
 */
router.get('/bookings/by-session/:sessionId', protect, restrictTo('customer'), travioGhanaController.getBookingBySession);

/**
 * @swagger
 * /api/travioghana/bookings/{id}:
 *   get:
 *     summary: Get Travio Ghana booking detail
 *     description: |
 *       Returns full details for a single Travio Ghana booking.
 *       Only the booking owner can view it.
 *     tags: [Travio Ghana]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Booking ID
 *     responses:
 *       200:
 *         description: Booking details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 *                 data:
 *                   type: object
 *                   properties:
 *                     booking:
 *                       $ref: '#/components/schemas/TravioGhanaBookingDetail'
 *       401:
 *         description: Authentication required
 *       404:
 *         description: Booking not found
 */
router.get('/bookings/:id', protect, restrictTo('customer'), validate(bookingIdParamSchema), travioGhanaController.getBooking);

/**
 * @swagger
 * /api/travioghana/bookings/{id}/cancel:
 *   patch:
 *     summary: Cancel a Travio Ghana booking
 *     description: |
 *       Cancels a PENDING or CONFIRMED Travio Ghana booking.
 *       Processes a full refund via Stripe if payment was successful.
 *       Only the booking owner can cancel.
 *       Returns 400 if within the cancellation window (default 24 hours before tour).
 *     tags: [Travio Ghana]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Booking ID
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *                 maxLength: 500
 *                 description: Optional cancellation reason
 *                 example: 'Change of plans'
 *     responses:
 *       200:
 *         description: Booking cancelled
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 *                 data:
 *                   type: object
 *                   properties:
 *                     booking:
 *                       $ref: '#/components/schemas/TravioGhanaBookingCancelResult'
 *       400:
 *         description: Cannot cancel — within window or invalid status
 *       401:
 *         description: Authentication required
 *       404:
 *         description: Booking not found
 */
router.patch('/bookings/:id/cancel', protect, restrictTo('customer'), validate(cancelBookingSchema), travioGhanaController.cancelBooking);

/**
 * @swagger
 * /api/travioghana/reviews:
 *   post:
 *     summary: Submit a review for a completed Travio Ghana booking
 *     description: |
 *       Authenticated customer endpoint to submit a review for a completed booking.
 *       One review per booking. Reviews require admin approval before appearing publicly.
 *     tags: [Travio Ghana]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bookingId, rating, comment]
 *             properties:
 *               bookingId:
 *                 type: string
 *                 description: ID of the completed booking
 *               rating:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 5
 *                 example: 5
 *               title:
 *                 type: string
 *                 maxLength: 200
 *                 example: Amazing experience!
 *               comment:
 *                 type: string
 *                 minLength: 10
 *                 maxLength: 5000
 *                 example: The tour was absolutely incredible. The guide was knowledgeable and friendly.
 *     responses:
 *       201:
 *         description: Review submitted
 *       400:
 *         description: Booking not completed or already reviewed
 *       404:
 *         description: Booking not found
 */
router.post('/reviews', protect, restrictTo('customer'), validate(createReviewSchema), travioGhanaController.createReview);

// ================================
// SUPPLIER ROUTES (protected)
// ================================

/**
 * @swagger
 * /api/travioghana/supplier/bookings:
 *   get:
 *     summary: Get Travio Ghana bookings for my tours
 *     description: |
 *       Returns paginated bookings for the authenticated supplier's tours
 *       that were made through Travio Ghana. Optionally filter by status.
 *     tags: [Travio Ghana Supplier]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10 }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [PENDING, CONFIRMED, COMPLETED, CANCELLED, REFUNDED, NO_SHOW] }
 *     responses:
 *       200:
 *         description: Paginated bookings list
 *       401:
 *         description: Authentication required
 *       404:
 *         description: Supplier profile not found
 */
router.get('/supplier/bookings', protect, restrictTo('supplier'), validate(getSupplierBookingsSchema), travioGhanaController.getSupplierBookings);

/**
 * @swagger
 * /api/travioghana/supplier/bookings/{id}/status:
 *   patch:
 *     summary: Update Travio Ghana booking status
 *     description: |
 *       Allows a supplier to transition a booking status.
 *       Valid transitions: PENDING→CONFIRMED/CANCELLED, CONFIRMED→COMPLETED/CANCELLED/NO_SHOW.
 *       Notifies the customer of the status change.
 *     tags: [Travio Ghana Supplier]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [CONFIRMED, COMPLETED, CANCELLED, NO_SHOW]
 *               reason:
 *                 type: string
 *                 maxLength: 500
 *                 description: Required if cancelling
 *     responses:
 *       200:
 *         description: Status updated
 *       400:
 *         description: Invalid transition
 *       404:
 *         description: Booking not found
 */
router.patch('/supplier/bookings/:id/status', protect, restrictTo('supplier'), validate(updateBookingStatusSchema), travioGhanaController.updateBookingStatus);

// ================================
// ADMIN ROUTES → moved to travioGhanaAdminRoutes.js
// Mounted at /api/travioghana/admin/*
// ================================

module.exports = router;
