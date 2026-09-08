const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { resolveSupplier, requireTeamPermission } = require('../middleware/teamRoleMiddleware');
const refundClaimController = require('../controllers/refundClaimController');

const router = express.Router();

router.use(protect);

// ── Customer ─────────────────────────────────────────────────────────────
// Submit a claim on a completed, paid booking (Lite storefront).
router.post('/bookings/:bookingId/claim', restrictTo('customer'), refundClaimController.submitRefundClaim);
router.get('/my', restrictTo('customer'), refundClaimController.getMyClaims);

// ── Supplier ─────────────────────────────────────────────────────────────
router.get('/supplier', resolveSupplier, requireTeamPermission('bookings.manage'), refundClaimController.getSupplierClaims);
router.patch('/supplier/:id/approve', resolveSupplier, requireTeamPermission('bookings.manage'), refundClaimController.supplierApprove);
router.patch('/supplier/:id/decline', resolveSupplier, requireTeamPermission('bookings.manage'), refundClaimController.supplierDecline);

// ── Admin ────────────────────────────────────────────────────────────────
router.get('/admin', restrictTo('admin'), refundClaimController.getAdminClaims);
router.patch('/admin/:id/release', restrictTo('admin'), refundClaimController.adminRelease);
router.patch('/admin/:id/decline', restrictTo('admin'), refundClaimController.adminDecline);

module.exports = router;
