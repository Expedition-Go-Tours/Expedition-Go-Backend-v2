const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/permissionMiddleware');
const adminFinanceController = require('../controllers/adminFinanceController');

const router = express.Router();

router.use(protect, restrictTo('admin'));

// ── Payout requests (supplier-initiated batches) ──

/**
 * @swagger
 * /admin/finance/payout-requests:
 *   get:
 *     summary: List supplier payout requests
 *     tags: [Admin Finance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *         description: Comma-separated PROCESSING,APPROVED,COMPLETED,REJECTED,CANCELLED
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Payout requests with supplier + method context
 */
router.get('/payout-requests', requirePermission('payouts.view'), adminFinanceController.getPayoutRequests);

/**
 * @swagger
 * /admin/finance/payout-requests/{id}:
 *   get:
 *     summary: Payout request detail with booking items
 *     tags: [Admin Finance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Full payout request
 */
router.get('/payout-requests/:id', requirePermission('payouts.view'), adminFinanceController.getPayoutRequestById);

/**
 * @swagger
 * /admin/finance/payout-requests/{id}/approve:
 *   patch:
 *     summary: Approve a payout request (authorize payment)
 *     tags: [Admin Finance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Request moved to APPROVED
 */
router.patch('/payout-requests/:id/approve', requirePermission('payouts.approve'), adminFinanceController.approvePayoutRequest);

/**
 * @swagger
 * /admin/finance/payout-requests/{id}/reject:
 *   patch:
 *     summary: Reject a payout request (bookings return to ELIGIBLE)
 *     tags: [Admin Finance]
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
 *             required: [reason]
 *             properties:
 *               reason: { type: string }
 *     responses:
 *       200:
 *         description: Request rejected
 */
router.patch('/payout-requests/:id/reject', requirePermission('payouts.approve'), adminFinanceController.rejectPayoutRequest);

/**
 * @swagger
 * /admin/finance/payout-requests/{id}/complete:
 *   patch:
 *     summary: Mark a payout as sent (writes ledger rows, bookings → PAID)
 *     tags: [Admin Finance]
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
 *             required: [reference]
 *             properties:
 *               reference: { type: string, description: Bank/PayPal transaction reference }
 *               notes: { type: string }
 *     responses:
 *       200:
 *         description: Request completed; immutable ledger Payout rows created
 *       409:
 *         description: Open dispute on an included booking
 */
router.patch('/payout-requests/:id/complete', requirePermission('payouts.approve'), adminFinanceController.completePayoutRequest);

// ── Refund requests (supplier-initiated; stored as Dispute) ──

/**
 * @swagger
 * /admin/finance/disputes:
 *   get:
 *     summary: List supplier refund requests
 *     tags: [Admin Finance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *         description: Comma-separated OPEN,UNDER_REVIEW,RESOLVED_CUSTOMER,RESOLVED_SUPPLIER,WITHDRAWN
 *     responses:
 *       200:
 *         description: Refund requests with booking/customer/supplier context
 */
router.get('/disputes', requirePermission('disputes.view'), adminFinanceController.getDisputes);

/**
 * @swagger
 * /admin/disputes/{id}:
 *   get:
 *     summary: Refund request detail
 *     tags: [Admin Finance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Full refund request record
 */
router.get('/disputes/:id', requirePermission('disputes.view'), adminFinanceController.getDisputeById);

/**
 * @swagger
 * /admin/disputes/{id}/resolve:
 *   patch:
 *     summary: Resolve a supplier refund request
 *     description: >
 *       CUSTOMER approves the refund — the customer is refunded via Stripe and
 *       the booking's funds are cancelled. SUPPLIER denies it / WITHDRAWN
 *       means the supplier pulled the request — funds unfreeze back to
 *       ELIGIBLE.
 *     tags: [Admin Finance]
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
 *             required: [outcome, resolution]
 *             properties:
 *               outcome: { type: string, enum: [CUSTOMER, SUPPLIER, WITHDRAWN] }
 *               resolution: { type: string }
 *               refundAmount: { type: number, description: Override refund amount (defaults to full) }
 *     responses:
 *       200:
 *         description: Refund request resolved
 *       502:
 *         description: Stripe refund failed — resolve manually once refunded
 */
router.patch('/disputes/:id/resolve', requirePermission('disputes.resolve'), adminFinanceController.resolveDispute);

module.exports = router;
