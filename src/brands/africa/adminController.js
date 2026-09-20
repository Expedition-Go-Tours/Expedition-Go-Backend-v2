/**
 * Travio Africa admin controller.
 *
 * Reuses the shared brand-parameterized admin factory (see
 * controllers/travioGhanaAdminController.js — makeAdminController). The
 * `africa` brand config points it at the TravioAfricaTour listing model,
 * BookingSource.TRAVIO_AFRICA, the `travioafrica` role, and Africa's
 * domains/URLs.
 */

const makeAdminController = require('../../core/admin');

module.exports = makeAdminController('africa');
