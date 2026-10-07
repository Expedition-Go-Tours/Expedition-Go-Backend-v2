const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/permissionMiddleware');
const adminFinanceController = require('../src/core/domain/adminFinanceController');

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

// ── Finance v3 — invoices (automatic GetYourGuide-style billing) ──

/**
 * @swagger
 * /admin/finance/invoices:
 *   get:
 *     summary: List supplier invoices (Your balance / paid history)
 *     tags: [Admin Finance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *         description: Comma-separated INVOICED,PAID,CANCELLED
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Invoice number, reference, or supplier name/email
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, enum: [invoiceNumber, netTotal, status, invoicedAt, createdAt] }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [asc, desc] }
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Invoices with supplier + method + line-item context
 */
router.get('/invoices', requirePermission('payouts.view'), adminFinanceController.getInvoices);

/**
 * @swagger
 * /admin/finance/invoices/{id}:
 *   get:
 *     summary: Invoice detail with booking line items
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
 *         description: Full invoice with bookings, customer + tour context
 */
router.get('/invoices/:id', requirePermission('payouts.view'), adminFinanceController.getInvoiceById);

/**
 * @swagger
 * /admin/finance/invoices/{id}/mark-paid:
 *   patch:
 *     summary: Mark an invoice as paid (records the real bank reference)
 *     description: |
 *       Money movement stays manual — no provider API. The admin records the
 *       bank/transaction reference; the invoice flips to PAID (leaving the
 *       supplier's balance) and its bookings' payoutStatus flip to PAID.
 *       Only INVOICED invoices can be marked paid.
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
 *               reference: { type: string, description: Real bank / transaction reference }
 *     responses:
 *       200:
 *         description: Invoice marked paid
 *       404:
 *         description: Invoice not found
 *       409:
 *         description: Invoice is already PAID or CANCELLED
 */
router.patch('/invoices/:id/mark-paid', requirePermission('payouts.approve'), adminFinanceController.markInvoicePaid);

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

// ── Payout schedules (automated runs) ──

/**
 * @swagger
 * /admin/finance/payout-schedules:
 *   get:
 *     summary: Enrolled suppliers with their payout cadence and next run
 *     tags: [Admin Finance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: cycle
 *         schema: { type: string, enum: [WEEKLY, TWICE_MONTHLY, MONTHLY] }
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Payout schedules + eligible balances
 */
router.get('/payout-schedules', requirePermission('payouts.view'), adminFinanceController.getPayoutSchedules);

/**
 * @swagger
 * /admin/finance/payout-schedules/{supplierId}/eligible-bookings:
 *   get:
 *     summary: The line items behind a supplier's "Eligible now" figure
 *     description: |
 *       Every booking the next payout run would claim for this supplier,
 *       built from the same predicate that decides what gets paid, plus the
 *       reason the run will or will not fire. Fetched lazily when a row is
 *       expanded rather than joined into the list response.
 *     tags: [Admin Finance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: supplierId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Eligible bookings, readiness and the cadence window
 *       404:
 *         description: Supplier not found
 */
router.get('/payout-schedules/:supplierId/eligible-bookings', requirePermission('payouts.view'), adminFinanceController.getSupplierEligibleBookings);

/**
 * @swagger
 * /admin/finance/payout-schedules/{supplierId}:
 *   get:
 *     summary: One supplier's payout schedule
 *     tags: [Admin Finance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Payout plan + eligible balance
 *       404:
 *         description: Supplier not found
 */
router.get('/payout-schedules/:supplierId', requirePermission('payouts.view'), adminFinanceController.getSupplierPayoutSchedule);

/**
 * @swagger
 * /admin/finance/payout-schedules/{supplierId}:
 *   patch:
 *     summary: Change (or override) a supplier's payout cadence
 *     tags: [Admin Finance]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [cycle]
 *             properties:
 *               cycle: { type: string, enum: [WEEKLY, TWICE_MONTHLY, MONTHLY] }
 *               immediate: { type: boolean, description: Force the change on the next run date instead of the 1st of next month }
 *               note: { type: string }
 *     responses:
 *       200:
 *         description: Updated payout plan
 */
router.patch('/payout-schedules/:supplierId', requirePermission('payouts.approve'), adminFinanceController.updateSupplierPayoutSchedule);

module.exports = router;
