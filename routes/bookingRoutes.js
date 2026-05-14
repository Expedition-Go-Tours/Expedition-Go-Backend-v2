/**
 * Booking Routes - Production Ready
 * Handles all booking-related endpoints
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const bookingController = require('../controllers/bookingController');

const router = express.Router();

// All routes require authentication
router.use(protect);

// ================================
// CART MANAGEMENT
// ================================

/**
 * @swagger
 * /bookings/cart:
 *   get:
 *     summary: Get user's cart
 *     tags: [Bookings, Cart]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Cart retrieved successfully
 */
router.get('/cart', bookingController.getCart);

/**
 * @swagger
 * /bookings/cart:
 *   post:
 *     summary: Add tour to cart
 *     tags: [Bookings, Cart]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - tourId
 *               - selectedDate
 *               - travelers
 *             properties:
 *               tourId:
 *                 type: string
 *               selectedDate:
 *                 type: string
 *                 format: date
 *               travelers:
 *                 type: object
 *                 required:
 *                   - adults
 *                   - phoneNumber
 *                   - location
 *                 properties:
 *                   adults:
 *                     type: integer
 *                     description: Number of adult travelers
 *                     example: 2
 *                   children:
 *                     type: integer
 *                     description: Number of child travelers
 *                     example: 1
 *                   infants:
 *                     type: integer
 *                     description: Number of infant travelers
 *                     example: 0
 *                   phoneNumber:
 *                     type: string
 *                     description: Contact phone number / WhatsApp
 *                     example: "+233-55-123-4567"
 *                   location:
 *                     type: string
 *                     description: Customer location (city/country)
 *                     example: "Accra, Ghana"
 *     responses:
 *       201:
 *         description: Item added to cart successfully
 *       400:
 *         description: Validation error or tour not available
 *       404:
 *         description: Tour not found
 */
router.post('/cart', bookingController.addToCart);

/**
 * @swagger
 * /bookings/cart/{id}:
 *   delete:
 *     summary: Remove item from cart
 *     tags: [Bookings, Cart]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       204:
 *         description: Item removed from cart
 *       404:
 *         description: Cart item not found
 */
router.delete('/cart/:id', bookingController.removeFromCart);

/**
 * @swagger
 * /bookings/cart/clear:
 *   delete:
 *     summary: Clear entire cart
 *     tags: [Bookings, Cart]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       204:
 *         description: Cart cleared successfully
 */
router.delete('/cart/clear', bookingController.clearCart);

// ================================
// BOOKING PROCESS
// ================================

/**
 * @swagger
 * /bookings:
 *   post:
 *     summary: Create booking from cart or direct booking
 *     description: |
 *       Create a new booking either from cart items or as a direct booking.
 *       
 *       **Cart Booking:** Set `useCart: true` to book all items in the cart.
 *       
 *       **Direct Booking:** Provide tourId, selectedDate, and travelers to book a single tour directly.
 *     tags: [Bookings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - paymentMethodId
 *             properties:
 *               tourId:
 *                 type: string
 *                 description: Tour ID (required for direct booking)
 *                 example: cmp2hql3c0001tzv0460pbckm
 *               selectedDate:
 *                 type: string
 *                 format: date
 *                 description: Tour date (required for direct booking)
 *                 example: "2026-05-20"
 *               selectedTime:
 *                 type: string
 *                 readOnly: true
 *                 description: Time slot is set by the tour supplier, not customer-selectable
 *               travelers:
 *                 type: object
 *                 description: Traveler information (required for direct booking)
 *                 required:
 *                   - adults
 *                   - phoneNumber
 *                   - location
 *                 properties:
 *                   adults:
 *                     type: integer
 *                     minimum: 1
 *                     maximum: 20
 *                     description: Number of adult travelers
 *                     example: 2
 *                   children:
 *                     type: integer
 *                     minimum: 0
 *                     maximum: 10
 *                     description: Number of child travelers
 *                     example: 1
 *                   infants:
 *                     type: integer
 *                     minimum: 0
 *                     maximum: 5
 *                     description: Number of infant travelers
 *                     example: 0
 *                   phoneNumber:
 *                     type: string
 *                     description: Contact phone number / WhatsApp (required for supplier communication)
 *                     example: "+1-555-123-4567"
 *                   location:
 *                     type: string
 *                     description: Customer location (city/country)
 *                     example: "New York, USA"
 *                   details:
 *                     type: array
 *                     description: Individual traveler details (optional)
 *                     items:
 *                       type: object
 *                       properties:
 *                         name:
 *                           type: string
 *                           example: John Doe
 *                         age:
 *                           type: integer
 *                           example: 35
 *                         ageGroup:
 *                           type: string
 *                           example: Adult
 *                         specialRequests:
 *                           type: string
 *                           example: Vegetarian meal
 *               specialRequests:
 *                 type: string
 *                 description: Any special requests or notes
 *                 example: Please arrange hotel pickup
 *               paymentMethodId:
 *                 type: string
 *                 description: Stripe payment method ID (required)
 *                 example: pm_1234567890abcdef
 *               useCart:
 *                 type: boolean
 *                 default: false
 *                 description: Set to true to book all items in cart instead of direct booking
 *                 example: false
 *           examples:
 *             directBooking:
 *               summary: Direct booking example
 *               value:
 *                 tourId: cmp2hql3c0001tzv0460pbckm
 *                 selectedDate: "2026-05-20"
 *                 travelers:
 *                   adults: 2
 *                   children: 1
 *                   infants: 0
 *                   phoneNumber: "+1-555-123-4567"
 *                   location: "New York, USA"
 *                   details:
 *                     - name: John Doe
 *                       age: 35
 *                       ageGroup: Adult
 *                     - name: Jane Doe
 *                       age: 32
 *                       ageGroup: Adult
 *                     - name: Jimmy Doe
 *                       age: 8
 *                       ageGroup: Child
 *                 specialRequests: Please arrange hotel pickup from Marriott Times Square
 *                 paymentMethodId: pm_1234567890abcdef
 *                 useCart: false
 *             cartBooking:
 *               summary: Cart booking example
 *               value:
 *                 paymentMethodId: pm_1234567890abcdef
 *                 useCart: true
 *     responses:
 *       201:
 *         description: Booking created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   oneOf:
 *                     - $ref: '#/components/schemas/Booking'
 *                     - type: array
 *                       items:
 *                         $ref: '#/components/schemas/Booking'
 *       400:
 *         description: Validation error or booking not possible
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Tour not found or cart empty
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/', bookingController.createBooking);

/**
 * @swagger
 * /bookings/my-bookings:
 *   get:
 *     summary: Get user's bookings
 *     tags: [Bookings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: status
 *         in: query
 *         schema:
 *           type: string
 *           enum: [PENDING, CONFIRMED, CANCELLED, REFUNDED, COMPLETED, NO_SHOW]
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *           default: 10
 *     responses:
 *       200:
 *         description: Bookings retrieved successfully
 */
router.get('/my-bookings', bookingController.getMyBookings);

/**
 * @swagger
 * /bookings/{id}/ticket:
 *   get:
 *     summary: Get printable ticket for a booking
 *     description: Returns a print-optimized HTML ticket page with all booking and tour details
 *     tags: [Bookings]
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
 *         description: HTML ticket page
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *       404:
 *         description: Booking not found
 */
router.get('/:id/ticket', bookingController.getBookingTicket);

/**
 * @swagger
 * /bookings/{id}:
 *   get:
 *     summary: Get single booking details
 *     tags: [Bookings]
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
 *         description: Booking retrieved successfully
 *       404:
 *         description: Booking not found
 */
router.get('/:id', bookingController.getBooking);

/**
 * @swagger
 * /bookings/{id}/cancel:
 *   patch:
 *     summary: Cancel booking
 *     description: |
 *       Cancel a confirmed booking. Refund eligibility depends on the tour's cancellation policy.
 *       Cancellations made within the free cancellation window will receive a full refund.
 *     tags: [Bookings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Booking ID
 *         schema:
 *           type: string
 *           example: cmp2hql3c0001tzv0460pbckm
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *                 description: Reason for cancellation (optional but recommended)
 *                 maxLength: 500
 *                 example: Change of travel plans due to family emergency
 *           example:
 *             reason: Change of travel plans due to family emergency
 *     responses:
 *       200:
 *         description: Booking cancelled successfully
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
 *                   example: Booking cancelled successfully. Full refund will be processed within 5-10 business days.
 *                 data:
 *                   type: object
 *                   properties:
 *                     booking:
 *                       $ref: '#/components/schemas/Booking'
 *                     refundAmount:
 *                       type: number
 *                       description: Amount to be refunded
 *                       example: 101.10
 *                     refundStatus:
 *                       type: string
 *                       enum: [FULL_REFUND, PARTIAL_REFUND, NO_REFUND]
 *                       example: FULL_REFUND
 *       400:
 *         description: Booking cannot be cancelled (outside cancellation window or already completed)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Booking not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.patch('/:id/cancel', bookingController.cancelBooking);

// ================================
// SUPPLIER BOOKING MANAGEMENT
// ================================

/**
 * @swagger
 * /bookings/supplier/bookings:
 *   get:
 *     summary: Get supplier's bookings
 *     tags: [Bookings, Supplier]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: status
 *         in: query
 *         schema:
 *           type: string
 *       - name: tourId
 *         in: query
 *         schema:
 *           type: string
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *           default: 10
 *     responses:
 *       200:
 *         description: Supplier bookings retrieved successfully
 *       403:
 *         description: Access denied
 */
router.get('/supplier/bookings', restrictTo('supplier'), bookingController.getSupplierBookings);

/**
 * @swagger
 * /bookings/{id}/status:
 *   patch:
 *     summary: Update booking status (suppliers only)
 *     description: |
 *       Update the status of a booking for your tour. Suppliers can mark bookings as:
 *       - CONFIRMED: Confirm a pending booking
 *       - COMPLETED: Mark booking as completed after tour ends
 *       - NO_SHOW: Mark when customer doesn't show up
 *     tags: [Bookings, Supplier]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Booking ID
 *         schema:
 *           type: string
 *           example: cmp2hql3c0001tzv0460pbckm
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [CONFIRMED, COMPLETED, NO_SHOW]
 *                 description: New booking status
 *                 example: COMPLETED
 *               supplierNotes:
 *                 type: string
 *                 description: Optional notes about the status change
 *                 maxLength: 1000
 *                 example: Tour completed successfully. All guests enjoyed the experience.
 *           examples:
 *             markCompleted:
 *               summary: Mark booking as completed
 *               value:
 *                 status: COMPLETED
 *                 supplierNotes: Tour completed successfully. All guests enjoyed the experience.
 *             markNoShow:
 *               summary: Mark customer as no-show
 *               value:
 *                 status: NO_SHOW
 *                 supplierNotes: Customer did not arrive at meeting point. Waited 15 minutes past scheduled time.
 *     responses:
 *       200:
 *         description: Booking status updated successfully
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
 *                   example: Booking status updated successfully
 *                 data:
 *                   $ref: '#/components/schemas/Booking'
 *       400:
 *         description: Invalid status transition
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Booking not found or access denied
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Access denied - not your booking
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.patch('/:id/status', restrictTo('supplier'), bookingController.updateBookingStatus);

module.exports = router;