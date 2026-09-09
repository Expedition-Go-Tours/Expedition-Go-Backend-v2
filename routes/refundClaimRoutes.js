const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { resolveSupplier, requireTeamPermission } = require('../middleware/teamRoleMiddleware');
const refundClaimController = require('../controllers/refundClaimController');

const router = express.Router();

router.use(protect);

// Tiny in-memory rate limit so claim submission can't be spammed.
const CLAIM_WINDOW_MS = 10 * 60 * 1000;
const CLAIM_MAX = 5;
const claimBuckets = new Map();

function claimRateLimit(req, res, next) {
  if (!req.user) return next();
  const now = Date.now();
  const key = req.user.id;
  const bucket = claimBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    claimBuckets.set(key, { count: 0, resetAt: now + CLAIM_WINDOW_MS });
  }
  const b = claimBuckets.get(key);
  b.count += 1;
  if (b.count > CLAIM_MAX) {
    return res.status(429).json({ status: 'fail', message: 'Too many refund requests — please try again in a few minutes' });
  }
  return next();
}

// ── Customer ─────────────────────────────────────────────────────────────
// Submit a claim on a completed, paid booking (Lite storefront).
router.post('/bookings/:bookingId/claim', restrictTo('customer'), claimRateLimit, refundClaimController.submitRefundClaim);
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
