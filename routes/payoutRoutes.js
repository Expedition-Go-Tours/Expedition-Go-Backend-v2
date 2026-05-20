const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const payoutController = require('../controllers/payoutController');

const router = express.Router();

router.use(protect);

// ── Supplier routes ──

/**
 * @swagger
 * /payouts/me:
 *   get:
 *     summary: Get my payout history (supplier)
 *     description: Returns paginated payout history for the authenticated supplier with running totals.
 *     tags: [Payouts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/pageParam'
 *       - $ref: '#/components/parameters/limitParam'
 *       - name: status
 *         in: query
 *         schema:
 *           type: string
 *           enum: [PENDING, APPROVED, PROCESSING, PAID, FAILED, CANCELLED]
 *         description: Filter by payout status
 *     responses:
 *       200:
 *         description: Payout history with pagination and summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: object
 *                   properties:
 *                     payouts:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Payout'
 *                     summary:
 *                       type: object
 *                       properties:
 *                         totalEarned:
 *                           type: number
 *                         totalPayouts:
 *                           type: integer
 *                     pagination:
 *                       $ref: '#/components/schemas/PaginatedResponse/properties/pagination'
 */
router.get('/me', restrictTo('supplier'), payoutController.getMyPayouts);

// ── Admin routes ──

/**
 * @swagger
 * /payouts/admin:
 *   get:
 *     summary: List all payouts (admin)
 *     description: View all payouts across all suppliers with filtering and pagination.
 *     tags: [Payouts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/pageParam'
 *       - $ref: '#/components/parameters/limitParam'
 *       - name: status
 *         in: query
 *         schema:
 *           type: string
 *           enum: [PENDING, APPROVED, PROCESSING, PAID, FAILED, CANCELLED]
 *         description: Filter by payout status
 *     responses:
 *       200:
 *         description: Paginated payouts list with summary
 */
router.get('/admin', restrictTo('admin'), payoutController.getAllPayouts);

/**
 * @swagger
 * /payouts/admin/summary:
 *   get:
 *     summary: Payout summary dashboard (admin)
 *     description: Aggregate stats — pending count/total, paid this month, monthly breakdown.
 *     tags: [Payouts]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Payout summary stats
 */
router.get('/admin/summary', restrictTo('admin'), payoutController.getPayoutSummary);

/**
 * @swagger
 * /payouts/admin/export:
 *   get:
 *     summary: Export payouts as CSV (admin)
 *     description: Download all payouts as a CSV file, optionally filtered by status, supplier, or date range.
 *     tags: [Payouts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: status
 *         in: query
 *         schema:
 *           type: string
 *           enum: [PENDING, APPROVED, PROCESSING, PAID, FAILED, CANCELLED]
 *         description: Filter by payout status
 *       - name: supplierId
 *         in: query
 *         schema:
 *           type: string
 *         description: Filter by supplier ID
 *       - name: startDate
 *         in: query
 *         schema:
 *           type: string
 *           format: date
 *         description: Start date for created at filter (ISO 8601)
 *       - name: endDate
 *         in: query
 *         schema:
 *           type: string
 *           format: date
 *         description: End date for created at filter (ISO 8601)
 *     responses:
 *       200:
 *         description: CSV file download
 *         content:
 *           text/csv:
 *             schema:
 *               type: string
 *               format: binary
 */
router.get('/admin/export', restrictTo('admin'), payoutController.exportPayouts);

/**
 * @swagger
 * /payouts/admin/{id}/approve:
 *   patch:
 *     summary: Approve a pending payout (admin)
 *     description: Moves a payout from PENDING → APPROVED, notifying the supplier.
 *     tags: [Payouts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Payout ID
 *     responses:
 *       200:
 *         description: Payout approved
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PayoutApproveResponse'
 */
router.patch('/admin/:id/approve', restrictTo('admin'), payoutController.approvePayout);

/**
 * @swagger
 * /payouts/admin/{id}/release:
 *   patch:
 *     summary: Release/confirm payout (admin)
 *     description: |
 *       Marks an APPROVED payout as PAID. Records which specific payout method was used,
 *       a transaction reference, and admin notes. The payoutMethodId is optional — if omitted
 *       the supplier's default verified method is auto-selected.
 *     tags: [Payouts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Payout ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PayoutReleaseInput'
 *     responses:
 *       200:
 *         description: Payout released and recorded
 *       400:
 *         description: Supplier has no verified payout method or invalid payout method ID
 */
router.patch('/admin/:id/release', restrictTo('admin'), payoutController.releasePayout);

/**
 * @swagger
 * /payouts/admin/{id}/fail:
 *   patch:
 *     summary: Mark payout as failed (admin)
 *     description: Moves APPROVED or PROCESSING payouts to FAILED with a reason.
 *     tags: [Payouts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Payout ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PayoutFailInput'
 *     responses:
 *       200:
 *         description: Payout marked as failed
 */
router.patch('/admin/:id/fail', restrictTo('admin'), payoutController.failPayout);

module.exports = router;
