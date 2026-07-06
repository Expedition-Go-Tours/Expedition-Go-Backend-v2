const express = require('express');
const { createLimiter } = require('../middleware/dynamicRateLimiter');
const { protect } = require('../middleware/authMiddleware');
const { restrictTo } = require('../middleware/authMiddleware');
const expeditionController = require('../controllers/expeditionController');
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
  getTourReviewsSchema,
  getBookingsSchema,
  bookingIdParamSchema,
  cancelBookingSchema,
} = require('../utils/expeditionValidation');

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
 * /api/expedition/tours:
 *   get:
 *     summary: List Expedition tours
 *     description: |
 *       Returns paginated, filtered list of active Expedition tours.
 *       Supports text search, category/city/country/price filters, and sorting.
 *       Results are ordered by `displayOrder` then `createdAt` descending.
 *       Cached in Redis for 300 seconds.
 *     tags: [Expedition]
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
 *         description: Paginated list of Expedition tours
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
 *                         $ref: '#/components/schemas/ExpeditionTourListing'
 *       500:
 *         description: Server error
 */
router.get('/tours', validate(getToursSchema), expeditionController.getTours);

/**
 * @swagger
 * /api/expedition/tours/featured:
 *   get:
 *     summary: Get featured Expedition tours
 *     description: |
 *       Returns up to 8 tours marked as featured (`isFeatured: true`) and active,
 *       ordered by `displayOrder` ascending. Designed for hero/carousel sections.
 *       Cached in Redis for 300 seconds.
 *     tags: [Expedition]
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
 *                         $ref: '#/components/schemas/ExpeditionTourListing'
 */
router.get('/tours/featured', expeditionController.getFeaturedTours);

/**
 * @swagger
 * /api/expedition/tours/sitemap:
 *   get:
 *     summary: Get Expedition sitemap data
 *     description: |
 *       Returns an array of { slug, updatedAt } for all active Expedition tours.
 *       Used by the frontend to generate a `sitemap.xml` for SEO.
 *       Cached in Redis for 3600 seconds.
 *     tags: [Expedition]
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
 *                         $ref: '#/components/schemas/ExpeditionSitemapEntry'
 */
router.get('/tours/sitemap', expeditionController.getSitemap);

/**
 * @swagger
 * /api/expedition/tours/{slug}/reviews:
 *   get:
 *     summary: Get tour reviews
 *     description: |
 *       Returns paginated, approved reviews for a specific Expedition tour.
 *       Includes customer name and photo for each review.
 *       Supports sorting by newest, highest rating, or lowest rating.
 *     tags: [Expedition]
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
 *                         $ref: '#/components/schemas/ExpeditionReview'
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
router.get('/tours/:slug/reviews', validate(getTourReviewsSchema), expeditionController.getTourReviews);

/**
 * @swagger
 * /api/expedition/tours/{slug}/similar:
 *   get:
 *     summary: Get similar tours
 *     description: |
 *       Returns up to 4 similar tours in the same category as the specified tour.
 *       Excludes the current tour. Useful for detail page "You may also like" sections.
 *     tags: [Expedition]
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
 *                         $ref: '#/components/schemas/ExpeditionTourListing'
 *       404:
 *         description: Tour not found
 */
router.get('/tours/:slug/similar', expeditionController.getSimilarTours);

/**
 * @swagger
 * /api/expedition/tours/{slug}/availability:
 *   get:
 *     summary: Get tour availability calendar
 *     description: |
 *       Returns a day-by-day availability calendar for a given Expedition tour and date range.
 *       Max range of 31 days. Each day shows status (AVAILABLE, LIMITED, FULL, BLOCKED),
 *       remaining spots, and time slot info.
 *       Does not require authentication.
 *     tags: [Expedition]
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
 *                         $ref: '#/components/schemas/ExpeditionCalendarDay'
 *       400:
 *         description: Invalid date range
 *       404:
 *         description: Tour not found
 */
router.get('/tours/:slug/availability', validate(availabilityCalendarSchema), expeditionController.getTourAvailability);

/**
 * @swagger
 * /api/expedition/tours/{slug}:
 *   get:
 *     summary: Get Expedition tour by slug
 *     description: |
 *       Returns full tour details for a single Expedition tour identified by its URL slug.
 *       Includes embedded JSON-LD structured data for rich search results.
 *       Tracks the view (IP + User-Agent dedup with 30-min cooldown).
 *       Cached in Redis for 300 seconds.
 *     tags: [Expedition]
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
router.get('/tours/:slug', expeditionController.getTourBySlug);

/**
 * @swagger
 * /api/expedition/contact:
 *   post:
 *     summary: Submit Expedition contact form
 *     description: |
 *       Sends a contact/inquiry message to the Expedition support team.
 *       Rate-limited to 5 submissions per 15 minutes per IP address.
 *       Sends an email notification to the support team.
 *     tags: [Expedition]
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
router.post('/contact', contactLimiter, validate(contactSchema), expeditionController.submitContact);

/**
 * @swagger
 * /api/expedition/subscribe:
 *   post:
 *     summary: Subscribe to Expedition newsletter
 *     description: |
 *       Adds an email to the Expedition newsletter subscriber list.
 *       If the email already exists but is unsubscribed, re-subscribes.
 *       Rate-limited to 10 submissions per minute per IP.
 *       Does not require authentication.
 *     tags: [Expedition]
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
router.post('/subscribe', subscribeLimiter, validate(subscribeSchema), expeditionController.subscribe);

/**
 * @swagger
 * /api/expedition/track-click:
 *   post:
 *     summary: Track a click event on Expedition
 *     description: |
 *       Records a click event (e.g. call-to-action, external link) for analytics.
 *       Stores the click with IP, user agent, and optional metadata.
 *       Does not require authentication.
 *     tags: [Expedition]
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
router.post('/track-click', validate(trackClickSchema), expeditionController.trackClick);

/**
 * @swagger
 * /api/expedition/checkout/calculate:
 *   post:
 *     summary: Calculate checkout pricing
 *     description: |
 *       Public endpoint that returns a pricing breakdown for a given tour, date, and traveler composition.
 *       Checks availability and validates traveler count against remaining spots.
 *       Does NOT require authentication — usable before login.
 *     tags: [Expedition]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tourId, selectedDate, travelers]
 *             properties:
 *               tourId:
 *                 type: string
 *                 description: ID of the tour
 *                 example: cmp2hql3c0001tzv0460pbckm
 *               selectedDate:
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
 *                   $ref: '#/components/schemas/ExpeditionCheckoutPricing'
 *       400:
 *         description: Invalid input or tour not available
 *       404:
 *         description: Tour not found
 */
router.post('/checkout/calculate', validate(calculateCheckoutSchema), expeditionController.calculateCheckout);

/**
 * @swagger
 * /api/expedition/checkout/confirm:
 *   post:
 *     summary: Confirm an Expedition booking
 *     description: |
 *       Authenticated endpoint that creates a booking with Stripe payment.
 *       Validates traveler info, checks availability with row-level locking,
 *       creates a Stripe PaymentIntent, and creates the booking record with `source: 'EXPEDITION'`.
 *       Sends an Expedition-branded confirmation email and notifies the supplier.
 *     tags: [Expedition]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tourId, selectedDate, travelers, paymentMethodId]
 *             properties:
 *               tourId:
 *                 type: string
 *                 description: ID of the tour to book
 *                 example: cmp2hql3c0001tzv0460pbckm
 *               selectedDate:
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
 *                   $ref: '#/components/schemas/ExpeditionBookingResult'
 *       400:
 *         description: Validation error, availability conflict, or payment failure
 *       401:
 *         description: Authentication required
 *       404:
 *         description: Tour not found
 */
router.post('/checkout/confirm', protect, validate(confirmBookingSchema), expeditionController.confirmBooking);

/**
 * @swagger
 * /api/expedition/wishlist:
 *   get:
 *     summary: Get Expedition wishlist
 *     description: |
 *       Returns the authenticated user's wishlisted tours, filtered to only include
 *       tours that are available on Expedition (`expeditionTours.some: { isActive: true }`).
 *       Tours are returned in the order they were added to the wishlist.
 *     tags: [Expedition]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Wishlist tours filtered for Expedition
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
 *                         $ref: '#/components/schemas/ExpeditionWishlistEntry'
 *       401:
 *         description: Authentication required
 */
router.get('/wishlist', protect, expeditionController.getExpeditionWishlist);

/**
 * @swagger
 * /api/expedition/wishlist/{tourId}:
 *   patch:
 *     summary: Toggle tour in Expedition wishlist
 *     description: |
 *       Add or remove a tour from the user's wishlist.
 *       Only works for tours that exist on Expedition (active ExpeditionTour record).
 *       If the tour is already wishlisted, it is removed; otherwise it is added.
 *     tags: [Expedition]
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
 *                       description: Updated full wishlist array (all tour IDs, not just Expedition)
 *                       example: ['cmp2hql3c0001tzv0460pbckm', 'cmp2hql3c0001tzv0460pbckn']
 *                     isWishlisted:
 *                       type: boolean
 *                       description: Whether the toggled tour is now in the wishlist
 *                       example: true
 *       401:
 *         description: Authentication required
 *       404:
 *         description: Tour not available on Expedition
 */
router.patch('/wishlist/:tourId', protect, validate(tourIdParamSchema), expeditionController.toggleExpeditionWishlist);

/**
 * @swagger
 * /api/expedition/bookings:
 *   get:
 *     summary: Get my Expedition bookings
 *     description: |
 *       Returns the authenticated user's bookings placed through Expedition (`source: EXPEDITION`).
 *       Paginated and sorted by most recent. Optionally filter by status.
 *     tags: [Expedition]
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
 *         description: Paginated list of user's Expedition bookings
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
 *                         $ref: '#/components/schemas/ExpeditionBookingSummary'
 *                 pagination:
 *                   $ref: '#/components/schemas/Pagination'
 *       401:
 *         description: Authentication required
 */
router.get('/bookings', protect, validate(getBookingsSchema), expeditionController.getMyBookings);

/**
 * @swagger
 * /api/expedition/bookings/{id}:
 *   get:
 *     summary: Get Expedition booking detail
 *     description: |
 *       Returns full details for a single Expedition booking.
 *       Only the booking owner can view it.
 *     tags: [Expedition]
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
 *                       $ref: '#/components/schemas/ExpeditionBookingDetail'
 *       401:
 *         description: Authentication required
 *       404:
 *         description: Booking not found
 */
router.get('/bookings/:id', protect, validate(bookingIdParamSchema), expeditionController.getBooking);

/**
 * @swagger
 * /api/expedition/bookings/{id}/cancel:
 *   patch:
 *     summary: Cancel an Expedition booking
 *     description: |
 *       Cancels a PENDING or CONFIRMED Expedition booking.
 *       Processes a full refund via Stripe if payment was successful.
 *       Only the booking owner can cancel.
 *       Returns 400 if within the cancellation window (default 24 hours before tour).
 *     tags: [Expedition]
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
 *                       $ref: '#/components/schemas/ExpeditionBookingCancelResult'
 *       400:
 *         description: Cannot cancel — within window or invalid status
 *       401:
 *         description: Authentication required
 *       404:
 *         description: Booking not found
 */
router.patch('/bookings/:id/cancel', protect, validate(cancelBookingSchema), expeditionController.cancelBooking);

// ================================
// ADMIN ROUTES (protected + rate-limited)
// ================================

const adminLimiter = createLimiter({
  name: 'admin',
  defaultMax: 200,
  defaultWindowMs: 15 * 60 * 1000,
  message: {
    status: 'fail',
    message: 'Too many admin requests from this IP, please try again later.',
  },
});

router.use('/admin', protect, restrictTo('admin'), adminLimiter);

/**
 * @swagger
 * /api/expedition/admin/search:
 *   get:
 *     summary: Search tours for Expedition admin dropdown
 *     description: |
 *       Searches the main Tour table by title for the admin "Add Tour" autocomplete.
 *       Returns tours not yet added to Expedition, or all tours matching the query.
 *       Admin-only.
 *     tags: [Expedition Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string, minLength: 2 }
 *         description: Search query (minimum 2 characters)
 *         example: Kilimanjaro
 *     responses:
 *       200:
 *         description: Matching tours for selection
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 *                 results: { type: integer, example: 5 }
 *                 data:
 *                   type: object
 *                   properties:
 *                     tours:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id: { type: string }
 *                           title: { type: string }
 *                           slug: { type: string }
 *                           category: { type: string, nullable: true }
 *                           city: { type: string, nullable: true }
 *                           country: { type: string, nullable: true }
 *                           supplierName: { type: string, nullable: true }
 *                           isAlreadyAdded: { type: boolean, description: 'Whether already on Expedition' }
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Admin role required
 */
router.get('/admin/search', validate(searchToursSchema), expeditionController.searchTours);

/**
 * @swagger
 * /api/expedition/admin/tours:
 *   get:
 *     summary: List all Expedition tours (admin)
 *     description: |
 *       Returns all ExpeditionTour records with full tour and adder details.
 *       Includes both active and inactive tours. Paginated.
 *       Admin-only.
 *     tags: [Expedition Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *       - in: query
 *         name: isActive
 *         schema: { type: string, enum: ['true', 'false'] }
 *         description: Filter by active status
 *     responses:
 *       200:
 *         description: Admin list of Expedition tours
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 *                 results: { type: integer }
 *                 pagination: { $ref: '#/components/schemas/Pagination' }
 *                 data:
 *                   type: object
 *                   properties:
 *                     tours:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/ExpeditionTour'
 *   post:
 *     summary: Add a tour to Expedition
 *     description: |
 *       Creates a new ExpeditionTour record linked to an existing Tour.
 *       Validates the tour exists and is not already on Expedition.
 *       Automatically sets `addedById` to the current admin.
 *       Invalidates all Expedition caches on success.
 *       Admin-only.
 *     tags: [Expedition Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ExpeditionTourInput'
 *     responses:
 *       201:
 *         description: Tour added to Expedition
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
 *                       $ref: '#/components/schemas/ExpeditionTour'
 *       400:
 *         description: Tour already on Expedition or invalid
 *       404:
 *         description: Tour not found
 */
router.get('/admin/tours', validate(getAdminToursSchema), expeditionController.getAdminTours);
router.post('/admin/tours', validate(addTourSchema), expeditionController.addTour);

/**
 * @swagger
 * /api/expedition/admin/tours/{id}:
 *   patch:
 *     summary: Update an Expedition tour
 *     description: |
 *       Updates fields on an ExpeditionTour record (isActive, isFeatured, displayOrder).
 *       Invalidates all Expedition caches on success.
 *       Admin-only.
 *     tags: [Expedition Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: ExpeditionTour record ID
 *         example: cmp2hql3c0001tzv0460pbckm
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ExpeditionTourUpdate'
 *     responses:
 *       200:
 *         description: Tour updated
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
 *                       $ref: '#/components/schemas/ExpeditionTour'
 *       404:
 *         description: Expedition tour not found
 *   delete:
 *     summary: Remove a tour from Expedition
 *     description: |
 *       Deletes an ExpeditionTour record (soft — truly deletes the junction record).
 *       The original Tour in the main system is unaffected.
 *       Invalidates all Expedition caches on success.
 *       Admin-only.
 *     tags: [Expedition Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: ExpeditionTour record ID to remove
 *         example: cmp2hql3c0001tzv0460pbckm
 *     responses:
 *       204:
 *         description: Tour removed from Expedition
 *       404:
 *         description: Expedition tour not found
 */
router.patch('/admin/tours/:id', validate(updateTourSchema), expeditionController.updateTour);
router.delete('/admin/tours/:id', validate(removeTourSchema), expeditionController.removeTour);

/**
 * @swagger
 * /api/expedition/admin/refresh/{tourId}:
 *   post:
 *     summary: Refresh Expedition cache
 *     description: |
 *       Invalidates Redis caches for Expedition listings, featured tours, sitemap, and tour details.
 *       If `tourId` is provided and is not `all`, only caches related to that specific tour are cleared.
 *       If `tourId` is omitted or `all`, all Expedition caches are cleared.
 *       Admin-only.
 *     tags: [Expedition Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: tourId
 *         required: false
 *         schema: { type: string }
 *         description: Specific ExpeditionTour ID or 'all' to clear everything
 *         example: all
 *     responses:
 *       200:
 *         description: Cache cleared
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: success }
 *                 message: { type: string, example: All expedition caches cleared }
 *       404:
 *         description: Expedition tour not found (if specific ID provided)
 */
router.post('/admin/refresh/:tourId?', validate(refreshCacheSchema), expeditionController.refreshCache);

module.exports = router;
