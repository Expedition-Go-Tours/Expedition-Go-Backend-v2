/**
 * Special Offer Routes - Supplier Special Offer Management
 * Handles CRUD and status toggle operations for supplier special offers.
 * All routes require authentication, supplier resolution, and 'tours.manage' permission.
 *
 * @module routes/specialOfferRoutes
 */

const express = require('express');
const router = express.Router();
const specialOfferController = require('../controllers/specialOfferController');
const { protect } = require('../middleware/authMiddleware');
const { resolveSupplier, requireTeamPermission } = require('../middleware/teamRoleMiddleware');

// All special offer routes require authentication + supplier team management permission
router.use(protect, resolveSupplier, requireTeamPermission('tours.manage'));

/**
 * @swagger
 * /api/suppliers/special-offers:
 *   get:
 *     summary: Get all special offers for the supplier
 *     description: |
 *       Retrieve all special offers belonging to the authenticated supplier.
 *       Supports filtering by status, offer type, and full-text search.
 *       Results are paginated and ordered by creation date (newest first).
 *     tags: [Special Offers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: status
 *         in: query
 *         description: Filter by computed status (active, scheduled, expired, inactive)
 *         schema:
 *           type: string
 *           enum: [active, scheduled, expired, inactive]
 *           example: active
 *       - name: offerType
 *         in: query
 *         description: Filter by offer type
 *         schema:
 *           type: string
 *           enum: [LIMITED_TIME, EARLY_BIRD, LAST_MINUTE]
 *           example: EARLY_BIRD
 *       - name: search
 *         in: query
 *         description: Search in offer name and promo code
 *         schema:
 *           type: string
 *           example: summer
 *       - name: page
 *         in: query
 *         description: Page number for pagination
 *         schema:
 *           type: integer
 *           default: 1
 *           minimum: 1
 *       - name: limit
 *         in: query
 *         description: Number of offers per page
 *         schema:
 *           type: integer
 *           default: 20
 *           minimum: 1
 *           maximum: 100
 *     responses:
 *       200:
 *         description: Special offers retrieved successfully
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
 *                     offers:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                             example: cmpxxx123
 *                           supplierId:
 *                             type: string
 *                             example: cmpxxx456
 *                           name:
 *                             type: string
 *                             example: Summer Early Bird
 *                           offerType:
 *                             type: string
 *                             enum: [LIMITED_TIME, EARLY_BIRD, LAST_MINUTE]
 *                           discountType:
 *                             type: string
 *                             enum: [PERCENTAGE, FIXED_AMOUNT]
 *                           discountPercentage:
 *                             type: integer
 *                             example: 15
 *                           fixedDiscountValue:
 *                             type: number
 *                             nullable: true
 *                             example: 25.00
 *                           startDate:
 *                             type: string
 *                             format: date-time
 *                           endDate:
 *                             type: string
 *                             format: date-time
 *                           isActive:
 *                             type: boolean
 *                             example: true
 *                           status:
 *                             type: string
 *                             enum: [active, scheduled, expired, inactive]
 *                             description: Computed status based on dates and isActive flag
 *                           capacityType:
 *                             type: string
 *                             enum: [UNLIMITED, CAPPED]
 *                           maxSpots:
 *                             type: integer
 *                             nullable: true
 *                           spotsSold:
 *                             type: integer
 *                             example: 0
 *                           timeSlotMode:
 *                             type: string
 *                             enum: [ALL_DAYS, SPECIFIC_WEEKDAYS]
 *                           specificWeekdays:
 *                             type: array
 *                             items:
 *                               type: string
 *                           earlyBirdAdvanceDays:
 *                             type: integer
 *                             nullable: true
 *                           lastMinuteWindowHours:
 *                             type: integer
 *                             nullable: true
 *                           promoCode:
 *                             type: string
 *                             nullable: true
 *                           minQuantity:
 *                             type: integer
 *                             nullable: true
 *                           minSpendAmount:
 *                             type: number
 *                             nullable: true
 *                           maxRedemptionsPerCustomer:
 *                             type: integer
 *                             nullable: true
 *                           stackable:
 *                             type: boolean
 *                             example: false
 *                           targets:
 *                             type: array
 *                             items:
 *                               $ref: '#/components/schemas/SpecialOfferTarget'
 *                           createdAt:
 *                             type: string
 *                             format: date-time
 *                           updatedAt:
 *                             type: string
 *                             format: date-time
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         currentPage:
 *                           type: integer
 *                         totalPages:
 *                           type: integer
 *                         totalCount:
 *                           type: integer
 *                         hasNextPage:
 *                           type: boolean
 *                         hasPrevPage:
 *                           type: boolean
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Forbidden - insufficient permissions
 */
router.get('/', specialOfferController.getOffers);

/**
 * @swagger
 * /api/suppliers/special-offers:
 *   post:
 *     summary: Create a new special offer
 *     description: |
 *       Create a new special offer for the authenticated supplier.
 *       Validates offer dates, discount values, and at least one target product is required.
 *       Supports all offer types: LIMITED_TIME, EARLY_BIRD, and LAST_MINUTE.
 *     tags: [Special Offers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - offerType
 *               - startDate
 *               - endDate
 *               - targets
 *             properties:
 *               name:
 *                 type: string
 *                 description: Offer name
 *                 example: Summer Early Bird
 *               offerType:
 *                 type: string
 *                 enum: [LIMITED_TIME, EARLY_BIRD, LAST_MINUTE]
 *                 description: Type of special offer
 *                 example: EARLY_BIRD
 *               discountType:
 *                 type: string
 *                 enum: [PERCENTAGE, FIXED_AMOUNT]
 *                 default: PERCENTAGE
 *                 description: Type of discount to apply
 *               discountPercentage:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 100
 *                 description: Discount percentage (required when discountType is PERCENTAGE)
 *                 example: 15
 *               fixedDiscountValue:
 *                 type: number
 *                 minimum: 0.01
 *                 description: Fixed discount amount (required when discountType is FIXED_AMOUNT)
 *                 example: 25.00
 *               startDate:
 *                 type: string
 *                 format: date-time
 *                 description: Offer start date
 *                 example: "2026-07-01T00:00:00.000Z"
 *               endDate:
 *                 type: string
 *                 format: date-time
 *                 description: Offer end date (must be after startDate)
 *                 example: "2026-08-31T23:59:59.000Z"
 *               isActive:
 *                 type: boolean
 *                 default: true
 *                 description: Whether the offer is active
 *               capacityType:
 *                 type: string
 *                 enum: [UNLIMITED, CAPPED]
 *                 default: UNLIMITED
 *                 description: Capacity limitation type
 *               maxSpots:
 *                 type: integer
 *                 minimum: 1
 *                 description: Maximum number of redeemable spots (required when capacityType is CAPPED)
 *               timeSlotMode:
 *                 type: string
 *                 enum: [ALL_DAYS, SPECIFIC_WEEKDAYS]
 *                 default: ALL_DAYS
 *               specificWeekdays:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday]
 *                 description: Weekdays the offer applies to (when timeSlotMode is SPECIFIC_WEEKDAYS)
 *               earlyBirdAdvanceDays:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 365
 *                 description: Days in advance required for EARLY_BIRD offers
 *                 example: 14
 *               lastMinuteWindowHours:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 720
 *                 description: Hours before tour start for LAST_MINUTE offers
 *                 example: 48
 *               promoCode:
 *                 type: string
 *                 minLength: 3
 *                 description: Unique promo code for the offer
 *                 example: SUMMER15
 *               minQuantity:
 *                 type: integer
 *                 minimum: 1
 *                 description: Minimum quantity required to apply the offer
 *               minSpendAmount:
 *                 type: number
 *                 minimum: 0.01
 *                 description: Minimum spend amount to apply the offer
 *               maxRedemptionsPerCustomer:
 *                 type: integer
 *                 minimum: 1
 *                 description: Maximum times a customer can redeem this offer
 *               stackable:
 *                 type: boolean
 *                 default: false
 *                 description: Whether the offer can be stacked with other offers
 *               targets:
 *                 type: array
 *                 description: Products/tours this offer applies to (at least one required)
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   required:
 *                     - tourId
 *                   properties:
 *                     tourId:
 *                       type: string
 *                       description: Target tour ID
 *                       example: cmpxxx789
 *                     tourOptionKey:
 *                       type: string
 *                       description: Specific tour option/package key (optional)
 *                       example: deluxe-package
 *                     tourOptionLabel:
 *                       type: string
 *                       description: Display label for the option (optional)
 *                       example: Deluxe Package
 *     responses:
 *       201:
 *         description: Special offer created successfully
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
 *                     offer:
 *                       type: object
 *                       $ref: '#/components/schemas/SpecialOffer'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - insufficient permissions
 *       409:
 *         description: Promo code already in use
 */
router.post('/', specialOfferController.createOffer);

/**
 * @swagger
 * /api/suppliers/special-offers/{id}:
 *   get:
 *     summary: Get a single special offer by ID
 *     description: |
 *       Retrieve a specific special offer by its ID.
 *       Only returns the offer if it belongs to the authenticated supplier.
 *       Includes the computed status field and full target details with tour information.
 *     tags: [Special Offers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Special offer ID
 *         schema:
 *           type: string
 *           example: cmpxxx123
 *     responses:
 *       200:
 *         description: Special offer retrieved successfully
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
 *                     offer:
 *                       $ref: '#/components/schemas/SpecialOffer'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Offer not found
 */
router.get('/:id', specialOfferController.getOffer);

/**
 * @swagger
 * /api/suppliers/special-offers/{id}:
 *   put:
 *     summary: Update a special offer
 *     description: |
 *       Update an existing special offer. All fields are optional during update.
 *       If targets are provided, existing targets are replaced entirely.
 *       Validates dates, discount values, and promo code uniqueness.
 *     tags: [Special Offers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Special offer ID
 *         schema:
 *           type: string
 *           example: cmpxxx123
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: Updated offer name
 *                 example: Summer Early Bird - Updated
 *               offerType:
 *                 type: string
 *                 enum: [LIMITED_TIME, EARLY_BIRD, LAST_MINUTE]
 *               discountType:
 *                 type: string
 *                 enum: [PERCENTAGE, FIXED_AMOUNT]
 *               discountPercentage:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 100
 *               fixedDiscountValue:
 *                 type: number
 *                 minimum: 0.01
 *               startDate:
 *                 type: string
 *                 format: date-time
 *               endDate:
 *                 type: string
 *                 format: date-time
 *               isActive:
 *                 type: boolean
 *               capacityType:
 *                 type: string
 *                 enum: [UNLIMITED, CAPPED]
 *               maxSpots:
 *                 type: integer
 *                 minimum: 1
 *               timeSlotMode:
 *                 type: string
 *                 enum: [ALL_DAYS, SPECIFIC_WEEKDAYS]
 *               specificWeekdays:
 *                 type: array
 *                 items:
 *                   type: string
 *               earlyBirdAdvanceDays:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 365
 *               lastMinuteWindowHours:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 720
 *               promoCode:
 *                 type: string
 *                 minLength: 3
 *               minQuantity:
 *                 type: integer
 *                 minimum: 1
 *               minSpendAmount:
 *                 type: number
 *                 minimum: 0.01
 *               maxRedemptionsPerCustomer:
 *                 type: integer
 *                 minimum: 1
 *               stackable:
 *                 type: boolean
 *               targets:
 *                 type: array
 *                 description: Replace all existing targets (if provided)
 *                 items:
 *                   type: object
 *                   required:
 *                     - tourId
 *                   properties:
 *                     tourId:
 *                       type: string
 *                     tourOptionKey:
 *                       type: string
 *                     tourOptionLabel:
 *                       type: string
 *     responses:
 *       200:
 *         description: Special offer updated successfully
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
 *                     offer:
 *                       $ref: '#/components/schemas/SpecialOffer'
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Offer not found
 *       409:
 *         description: Promo code already in use
 */
router.put('/:id', specialOfferController.updateOffer);

/**
 * @swagger
 * /api/suppliers/special-offers/{id}:
 *   delete:
 *     summary: Delete a special offer
 *     description: |
 *       Permanently delete a special offer by ID.
 *       Only the owning supplier can delete their offers.
 *       This action cannot be undone.
 *     tags: [Special Offers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Special offer ID to delete
 *         schema:
 *           type: string
 *           example: cmpxxx123
 *     responses:
 *       200:
 *         description: Offer deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 message:
 *                   type: string
 *                   example: Offer deleted
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Offer not found
 */
router.delete('/:id', specialOfferController.deleteOffer);

/**
 * @swagger
 * /api/suppliers/special-offers/{id}/toggle:
 *   patch:
 *     summary: Toggle special offer active/inactive status
 *     description: |
 *       Toggle the isActive flag of a special offer.
 *       If currently active, it becomes inactive and vice versa.
 *       Returns the updated offer with its computed status.
 *     tags: [Special Offers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Special offer ID to toggle
 *         schema:
 *           type: string
 *           example: cmpxxx123
 *     responses:
 *       200:
 *         description: Offer status toggled successfully
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
 *                     offer:
 *                       $ref: '#/components/schemas/SpecialOffer'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Offer not found
 */
router.patch('/:id/toggle', specialOfferController.toggleOffer);

module.exports = router;
