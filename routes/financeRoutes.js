const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { resolveSupplier, requireTeamPermission } = require('../middleware/teamRoleMiddleware');
const financeController = require('../src/core/domain/financeController');

const router = express.Router();

router.use(protect);

// ── Supplier finance endpoints (Finance page) ──

/**
 * @swagger
 * /finance/summary:
 *   get:
 *     summary: Finance KPI summary for the authenticated supplier
 *     tags: [Finance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Available balance, pending clearance, in-review totals, paid out, cycle + window state
 */
router.get('/summary', resolveSupplier, requireTeamPermission('payouts.view'), financeController.getFinanceSummary);

// Cancellation-fee ledger (open fees are netted off the next payout request)
router.get('/charges', resolveSupplier, requireTeamPermission('payouts.view'), financeController.getSupplierCharges);

/**
 * @swagger
 * /finance/earnings:
 *   get:
 *     summary: Booking-level earnings list with payout lifecycle filters
 *     tags: [Finance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: payoutStatus
 *         schema: { type: string }
 *         description: Comma-separated PENDING,ELIGIBLE,REQUESTED,PAID,DISPUTED,CANCELLED
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Earnings rows + aggregate summary + pagination
 */
router.get('/earnings', resolveSupplier, requireTeamPermission('payouts.view'), financeController.getEarnings);

/**
 * @swagger
 * /finance/payout/request:
 *   post:
 *     summary: Request a payout for eligible bookings
 *     description: >
 *       Only allowed while the bi-monthly withdrawal window is open.
 *       Omitting bookingIds selects ALL eligible bookings. Mixed currencies
 *       are split into one request per currency.
 *     tags: [Finance]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               bookingIds:
 *                 type: array
 *                 items: { type: string }
 *                 description: Optional explicit selection; omit for all eligible
 *               payoutMethodId:
 *                 type: string
 *                 description: Defaults to the supplier's default verified method
 *               notes:
 *                 type: string
 *     responses:
 *       201:
 *         description: Created payout request(s)
 *       400:
 *         description: Window closed / no eligible bookings / unverified method
 */
router.post('/payout/request', resolveSupplier, requireTeamPermission('payouts.request'), financeController.createPayoutRequest);

/**
 * @swagger
 * /finance/payouts/requests:
 *   get:
 *     summary: List my payout requests
 *     tags: [Finance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Payout requests with items + pagination
 */
router.get('/payouts/requests', resolveSupplier, requireTeamPermission('payouts.view'), financeController.getPayoutRequests);

/**
 * @swagger
 * /finance/payouts/requests/{id}:
 *   get:
 *     summary: Payout request detail
 *     tags: [Finance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Payout request with booking items
 */
router.get('/payouts/requests/:id', resolveSupplier, requireTeamPermission('payouts.view'), financeController.getPayoutRequestById);

/**
 * @swagger
 * /finance/payouts/requests/{id}/cancel:
 *   patch:
 *     summary: Cancel my payout request (only while PROCESSING)
 *     tags: [Finance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Cancelled; bookings returned to ELIGIBLE
 */
router.patch('/payouts/requests/:id/cancel', resolveSupplier, requireTeamPermission('payouts.request'), financeController.cancelPayoutRequest);

/**
 * @swagger
 * /finance/disputes:
 *   get:
 *     summary: Disputes opened against my bookings
 *     tags: [Finance]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Disputes with booking context
 */
router.get('/disputes', resolveSupplier, requireTeamPermission('payouts.view'), financeController.getDisputes);

/**
 * @swagger
 * /finance/payout-settings:
 *   get:
 *     summary: The supplier's automated payout schedule
 *     description: >
 *       Current cadence, next run date and any change scheduled for the 1st of
 *       next month. `autoManaged: false` means the legacy manual withdrawal
 *       window still applies.
 *     tags: [Finance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Payout plan for the authenticated supplier
 */
router.get('/payout-settings', resolveSupplier, requireTeamPermission('payouts.view'), financeController.getPayoutSettings);

/**
 * @swagger
 * /finance/payout-settings:
 *   patch:
 *     summary: Choose the payout cadence (weekly / twice a month / monthly)
 *     description: >
 *       Changes take effect on the 1st of the following month; a first
 *       enrolment applies immediately.
 *     tags: [Finance]
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
 *     responses:
 *       200:
 *         description: Updated payout plan
 *       400:
 *         description: Invalid cycle
 */
router.patch('/payout-settings', resolveSupplier, requireTeamPermission('payouts.view'), financeController.updatePayoutSettings);

module.exports = router;
