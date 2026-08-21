const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { resolveSupplier, requireTeamPermission } = require('../middleware/teamRoleMiddleware');
const disputeController = require('../controllers/disputeController');

const router = express.Router();

router.use(protect);

/**
 * @swagger
 * /disputes:
 *   post:
 *     summary: Open a refund request on one of my bookings (supplier)
 *     description: >
 *       Supplier-initiated refund request. Freezes the booking's payout funds
 *       until an admin approves the refund or denies the request. Only paid
 *       bookings whose funds are still on the platform (PENDING/ELIGIBLE) can
 *       be disputed.
 *     tags: [Disputes]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bookingId, reason]
 *             properties:
 *               bookingId: { type: string }
 *               reason:
 *                 type: string
 *                 enum: [OPERATIONAL, FORCE_MAJEURE, CUSTOMER_REQUESTED, OTHER]
 *               description: { type: string }
 *     responses:
 *       201:
 *         description: Refund request created; booking funds frozen
 *       400:
 *         description: Booking not eligible (wrong payout status / unpaid)
 *       409:
 *         description: An open refund request already exists for this booking
 */
router.post('/', resolveSupplier, requireTeamPermission('payouts.request'), disputeController.createDispute);

/**
 * @swagger
 * /disputes/mine:
 *   get:
 *     summary: List refund requests I opened
 *     tags: [Disputes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: My refund requests with booking context
 */
router.get('/mine', disputeController.getMyDisputes);

/**
 * @swagger
 * /disputes/{id}/withdraw:
 *   patch:
 *     summary: Withdraw my open refund request
 *     tags: [Disputes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Request withdrawn; funds unfrozen
 */
router.patch('/:id/withdraw', disputeController.withdrawDispute);

module.exports = router;
