/**
 * TravioAfrica Routes — pan-African storefront routes.
 *
 * Mounted at /api/travioafrica/*
 *
 * Mirrors travioGhanaRoutes.js — same structure, TravioAfrica-scoped.
 * Public routes (no auth): homepage, tours, badges, featured, reviews, sitemap.
 * Customer routes (auth required): bookings, wishlist, checkout.
 * Supplier routes: mounted separately at /api/travioafrica/supplier
 * Admin routes: mounted separately at /api/travioafrica/admin
 */

const express = require('express');
const router = express.Router();

const travioAfricaHomepageController = require('../controllers/travioAfricaHomepageController');

// ── Public routes ──────────────────────────────────────────────────────

// Homepage — TravioAfrica-scoped sections
router.get('/homepage', travioAfricaHomepageController.getAfricaHomepage);

// NOTE: Additional routes (tours, badges, featured, reviews, sitemap,
// bookings, wishlist, checkout) will be added as TravioAfrica storefront
// features are built. The homepage is the critical first route — it makes
// the storefront's homepage sections render with real data.

module.exports = router;
