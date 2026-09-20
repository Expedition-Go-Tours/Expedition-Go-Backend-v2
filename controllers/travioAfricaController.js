/**
 * Travio Africa storefront controller.
 *
 * Travio Africa reuses the shared, brand-parameterized storefront factory
 * (see controllers/expeditionController.js — makeStorefrontController). The
 * `africa` brand config points the factory at the TravioAfricaTour listing
 * model, BookingSource.TRAVIO_AFRICA, the `travioafrica` role, and Africa's
 * domains/URLs.
 *
 * Africa currently inherits the factory's default storefront behaviours.
 * When Africa's storefront diverges (same pattern Ghana used), add
 * Africa-specific overrides here:
 *   const makeStorefrontController = require('../src/core/storefront');
 *   module.exports = { ...makeStorefrontController('africa'), <overrides> };
 */

const { makeStorefrontController } = require('./expeditionController');

module.exports = makeStorefrontController('africa');
