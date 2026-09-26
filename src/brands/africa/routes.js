/**
 * TravioAfrica Routes — pan-African storefront routes.
 *
 * Mounted at /api/travioafrica/*
 *
 * Mirrors travioGhanaRoutes.js — same storefront surface, TravioAfrica-scoped.
 *   - Public routes (no auth): homepage, tours, badges, featured, reviews,
 *     sitemap, availability, contact, subscribe, track-click, checkout/calculate.
 *   - Customer routes (auth): wishlist, checkout/confirm, bookings, reviews.
 *   - Supplier routes: /supplier/bookings (inline).
 *   - Admin routes: mounted separately at /api/travioafrica/admin (future).
 *
 * Validation schemas are brand-agnostic (request shape, not brand identity),
 * so they are shared from travioGhanaValidation until a shared validation
 * module is consolidated in Phase 3.
 */

const express = require('express');
const { createLimiter } = require('../../../middleware/dynamicRateLimiter');
const { protect, restrictTo } = require('../../../middleware/authMiddleware');
// Supplier-scoped routes resolve the supplier through the team membership
// (`resolveSupplier`), not through `restrictTo('supplier')`: a team member's own
// account carries `roles: ['customer']` — the supplier they work for is reached
// through the membership, not through their roles — so a role check on the
// caller's own roles refused every member the page they are allowed to open.
const { resolveSupplier, requireTeamPermission } = require('../../../middleware/teamRoleMiddleware');
const travioAfricaController = require('./controller');
const payLaterPaymentController = require('../../core/domain/payLaterPaymentController');
const reviewController = require('../../core/domain/reviewController');
const { uploadReviewPhotos } = require('../../../middleware/uploadMiddleware');
const travioAfricaHomepageController = require('./homepageController');
const validate = require('../../../middleware/validate');
const {
  getToursSchema,
  contactSchema,
  trackClickSchema,
  calculateCheckoutSchema,
  confirmBookingSchema,
  tourIdParamSchema,
  subscribeSchema,
  availabilityCalendarSchema,
  slugParamSchema,
  getTourReviewsSchema,
  getBookingsSchema,
  bookingIdParamSchema,
  cancelBookingSchema,
  getSupplierBookingsSchema,
} = require('../../core/services/travioGhanaValidation');
// Structured GetYourGuide-style cancellation validation (shared with core) —
// replaces the brand-local loose schema so a supplier cancel can never skip
// the taxonomy / T&C / refund rules.
const { updateBookingStatusSchema } = require('../../core/services/cancellationSchemas');

const router = express.Router();

// Rate limiters (same defaults as the Ghana storefront)
const contactLimiter = createLimiter({
  name: 'contact',
  defaultMax: 5,
  defaultWindowMs: 15 * 60 * 1000,
  message: { status: 'fail', message: 'Too many submissions from this IP, please try again later.' },
});
const subscribeLimiter = createLimiter({
  name: 'subscribe',
  defaultMax: 10,
  defaultWindowMs: 60 * 1000,
  message: { status: 'fail', message: 'Too many subscription attempts, please try again later.' },
});
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

// ── Homepage (Africa-scoped) ─────────────────────────────────────────
router.get('/homepage', travioAfricaHomepageController.getAfricaHomepage);

// ── Tours ─────────────────────────────────────────────────────────────
router.get('/tours', validate(getToursSchema), travioAfricaController.getTours);
router.get('/tours/badges', travioAfricaController.getTourBadges);
router.get('/tours/featured', travioAfricaController.getFeaturedTours);
router.get('/tours/sitemap', travioAfricaController.getSitemap);
router.get('/tours/:slug/reviews', validate(getTourReviewsSchema), travioAfricaController.getTourReviews);
router.get('/tours/:slug/similar', validate(slugParamSchema), travioAfricaController.getSimilarTours);
router.get('/tours/:slug/availability', validate(availabilityCalendarSchema), travioAfricaController.getTourAvailability);
router.get('/tours/:slug', validate(slugParamSchema), travioAfricaController.getTourBySlug);

// ── Contact / newsletter / analytics ─────────────────────────────────
router.post('/contact', contactLimiter, validate(contactSchema), travioAfricaController.submitContact);
router.post('/subscribe', subscribeLimiter, validate(subscribeSchema), travioAfricaController.subscribe);
router.post('/track-click', validate(trackClickSchema), travioAfricaController.trackClick);

// ── Checkout ─────────────────────────────────────────────────────────
router.post('/checkout/calculate', calculateLimiter, validate(calculateCheckoutSchema), travioAfricaController.calculateCheckout);
router.post('/checkout/confirm', confirmLimiter, protect, restrictTo('customer'), validate(confirmBookingSchema), travioAfricaController.confirmBooking);

// ── Wishlist (customer) ──────────────────────────────────────────────
router.get('/wishlist', protect, restrictTo('customer'), travioAfricaController.getWishlist);
router.patch('/wishlist/:tourId', protect, restrictTo('customer'), validate(tourIdParamSchema), travioAfricaController.toggleWishlist);

// ── Bookings (customer) ──────────────────────────────────────────────
router.get('/bookings', protect, restrictTo('customer'), validate(getBookingsSchema), travioAfricaController.getMyBookings);
router.get('/bookings/by-session/:sessionId', protect, restrictTo('customer'), travioAfricaController.getBookingBySession);
router.get('/bookings/:id', protect, restrictTo('customer'), validate(bookingIdParamSchema), travioAfricaController.getBooking);
router.patch('/bookings/:id/cancel', protect, restrictTo('customer'), validate(cancelBookingSchema), travioAfricaController.cancelBooking);
router.get('/bookings/:id/payment-state', protect, restrictTo('customer'), payLaterPaymentController.getPaymentState);
router.post('/bookings/:id/pay-now', protect, restrictTo('customer'), payLaterPaymentController.startPayNow);

// ── Reviews (customer) ───────────────────────────────────────────────
router.post('/reviews', protect, restrictTo('customer'), uploadReviewPhotos, reviewController.createReview);

// ── Supplier bookings (protected) ────────────────────────────────────
router.get('/supplier/bookings', protect, resolveSupplier, requireTeamPermission('bookings.view'), validate(getSupplierBookingsSchema), travioAfricaController.getSupplierBookings);
router.patch('/supplier/bookings/:id/status', protect, resolveSupplier, requireTeamPermission('bookings.manage'), validate(updateBookingStatusSchema), travioAfricaController.updateBookingStatus);

module.exports = router;
