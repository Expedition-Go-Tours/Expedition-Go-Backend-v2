const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/permissionMiddleware');
const { resolveSupplier, requireTeamPermission } = require('../middleware/teamRoleMiddleware');
const payoutMethodController = require('../controllers/payoutMethodController');

const router = express.Router();

router.use(protect);

// ── Supplier routes ──

/**
 * @swagger
 * /payout-methods/me:
 *   get:
 *     summary: Get my payout methods (supplier)
 *     description: Returns all payout methods for the authenticated supplier, default first.
 *     tags: [Payout Methods]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of payout methods
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
 *                     methods:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/PayoutMethod'
 */
router.get('/me', resolveSupplier, requireTeamPermission('payout-methods.view'), payoutMethodController.getMyMethods);

/**
 * @swagger
 * /payout-methods:
 *   post:
 *     summary: Add a payout method (supplier)
 *     description: |
 *       Add a new payout method. The first method added is auto-set as default.
 *       Validation differs by type — see PayoutMethodInput schema for required fields.
 *     tags: [Payout Methods]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PayoutMethodInput'
 *     responses:
 *       201:
 *         description: Payout method created
 */
router.post('/', resolveSupplier, requireTeamPermission('payout-methods.manage'), payoutMethodController.addMethod);

/**
 * @swagger
 * /payout-methods/{id}:
 *   patch:
 *     summary: Update a payout method (supplier)
 *     tags: [Payout Methods]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PayoutMethodInput'
 *     responses:
 *       200:
 *         description: Payout method updated
 *   delete:
 *     summary: Delete a payout method (supplier)
 *     description: Deleting the default method auto-assigns default to the next available.
 *     tags: [Payout Methods]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Payout method deleted
 */
router.patch('/:id', resolveSupplier, requireTeamPermission('payout-methods.manage'), payoutMethodController.updateMethod);
router.delete('/:id', resolveSupplier, requireTeamPermission('payout-methods.manage'), payoutMethodController.deleteMethod);

// ── Admin routes ──

/**
 * @swagger
 * /payout-methods/admin/suppliers/{supplierId}:
 *   get:
 *     summary: Get a supplier's payout methods (admin)
 *     tags: [Payout Methods]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: supplierId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Supplier's payout methods with user info
 */
router.get('/admin/suppliers/:supplierId', restrictTo('admin'), requirePermission('payout-methods.view'), payoutMethodController.getSupplierMethods);

/**
 * @swagger
 * /payout-methods/admin:
 *   get:
 *     summary: List all suppliers with payout methods (admin)
 *     description: Finance dashboard — see all suppliers and their payout methods. Filter by hasMethod=true/false.
 *     tags: [Payout Methods]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/pageParam'
 *       - $ref: '#/components/parameters/limitParam'
 *       - name: hasMethod
 *         in: query
 *         schema:
 *           type: string
 *           enum: [true, false]
 *         description: Filter to only suppliers with/without payout methods
 *     responses:
 *       200:
 *         description: Suppliers list with payout methods
 */
router.get('/admin', restrictTo('admin'), requirePermission('payout-methods.view'), payoutMethodController.getAllSuppliersMethods);

/**
 * @swagger
 * /payout-methods/admin/summary:
 *   get:
 *     summary: Payout method coverage summary (admin)
 *     description: Coverage + readiness stats for the finance dashboard (suppliers with methods, need setup, unverified, default coverage, type mix).
 *     tags: [Payout Methods]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Coverage summary
 */
router.get('/admin/summary', restrictTo('admin'), requirePermission('payout-methods.view'), payoutMethodController.getPayoutMethodSummary);

/**
 * @swagger
 * /payout-methods/admin/{id}/verify:
 *   patch:
 *     summary: Verify/unverify a payout method (admin)
 *     description: |
 *       Finance team marks a supplier's payout method as verified after confirming
 *       the banking details. Send { verified: false } to unverify.
 *     tags: [Payout Methods]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Payout method ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               verified:
 *                 type: boolean
 *                 default: true
 *     responses:
 *       200:
 *         description: Payout method verification status updated
 */
router.patch('/admin/:id/verify', restrictTo('admin'), requirePermission('payout-methods.verify'), payoutMethodController.verifyPayoutMethod);

module.exports = router;
