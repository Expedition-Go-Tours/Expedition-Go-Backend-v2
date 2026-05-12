/**
 * Tour Routes - Production Ready
 * Handles all tour-related endpoints
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const tourController = require('../controllers/tourController');
const { uploadTourPhotos } = require('../middleware/uploadMiddleware');

const router = express.Router();

// ================================
// PUBLIC TOUR ROUTES
// ================================

/**
 * @swagger
 * /tours:
 *   get:
 *     summary: Get all tours with filtering and pagination
 *     tags: [Tours]
 *     parameters:
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *           default: 12
 *       - name: category
 *         in: query
 *         schema:
 *           type: string
 *       - name: theme
 *         in: query
 *         schema:
 *           type: string
 *       - name: minPrice
 *         in: query
 *         schema:
 *           type: number
 *       - name: maxPrice
 *         in: query
 *         schema:
 *           type: number
 *       - name: rating
 *         in: query
 *         schema:
 *           type: number
 *       - name: search
 *         in: query
 *         schema:
 *           type: string
 *       - name: sortBy
 *         in: query
 *         schema:
 *           type: string
 *           enum: [createdAt, rating, price, popularity]
 *           default: createdAt
 *     responses:
 *       200:
 *         description: Tours retrieved successfully
 */
router.get('/', tourController.getAllTours);

/**
 * @swagger
 * /tours/{id}:
 *   get:
 *     summary: Get single tour by ID or slug
 *     tags: [Tours]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Tour retrieved successfully
 *       404:
 *         description: Tour not found
 */
router.get('/:id', tourController.getTour);

// ================================
// SUPPLIER TOUR MANAGEMENT
// ================================

// All routes below require authentication
router.use(protect);

/**
 * @swagger
 * /tours/supplier/my-tours:
 *   get:
 *     summary: Get supplier's own tours
 *     tags: [Tours, Supplier]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: status
 *         in: query
 *         schema:
 *           type: string
 *           enum: [DRAFT, ACTIVE, PAUSED, ARCHIVED]
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
 *         description: Supplier tours retrieved successfully
 *       403:
 *         description: Access denied
 */
router.get('/supplier/my-tours', restrictTo('supplier'), tourController.getMyTours);

/**
 * @swagger
 * /tours:
 *   post:
 *     summary: Create new tour (suppliers only)
 *     description: |
 *       Create a new tour listing. Complex fields (categorization, theme, productContent, schedulesAndPricing, bookingAndTickets) 
 *       should be sent as JSON strings in the multipart form data.
 *       
 *       **Note:** When using multipart/form-data, JSON objects must be stringified.
 *     tags: [Tours, Supplier]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *               - description
 *               - categorization
 *               - schedulesAndPricing
 *             properties:
 *               title:
 *                 type: string
 *                 minLength: 5
 *                 maxLength: 200
 *                 description: Tour title
 *                 example: Amazing Central Park Walking Tour
 *               description:
 *                 type: string
 *                 minLength: 50
 *                 maxLength: 5000
 *                 description: Detailed tour description
 *                 example: Discover the hidden gems of Central Park with our expert local guide. This 2-hour walking tour covers the most iconic spots and secret locations that most tourists never see.
 *               categorization:
 *                 type: string
 *                 description: |
 *                   JSON string containing:
 *                   - category: Main category (e.g., "Cultural", "Adventure", "Nature")
 *                   - subcategory: Specific type (e.g., "Walking Tours", "Hiking")
 *                   - difficulty: Tour difficulty ("Easy", "Moderate", "Challenging", "Extreme")
 *                   - duration: Duration in minutes (integer)
 *                 example: '{"category":"Cultural","subcategory":"Walking Tours","difficulty":"Easy","duration":120}'
 *               theme:
 *                 type: string
 *                 description: |
 *                   JSON string containing:
 *                   - primaryTheme: Main theme
 *                   - secondaryThemes: Array of additional themes
 *                 example: '{"primaryTheme":"Nature & Wildlife","secondaryThemes":["Photography","Adventure"]}'
 *               productContent:
 *                 type: string
 *                 description: |
 *                   JSON string containing:
 *                   - highlights: Array of tour highlights
 *                   - included: Array of included items/services
 *                   - excluded: Array of excluded items
 *                   - whatToBring: Array of items guests should bring
 *                   - accessibility: Accessibility information
 *                   - restrictions: Any restrictions or requirements
 *                 example: '{"highlights":["Visit Bethesda Fountain","See Bow Bridge","Explore Strawberry Fields"],"included":["Professional guide","Bottled water"],"excluded":["Gratuities","Hotel pickup"],"whatToBring":["Comfortable walking shoes","Camera","Weather-appropriate clothing"],"accessibility":"Not wheelchair accessible","restrictions":"Moderate walking required"}'
 *               schedulesAndPricing:
 *                 type: string
 *                 description: |
 *                   JSON string containing:
 *                   - travelerDetails: Pricing model and age groups
 *                   - pricingSchedules: Currency and price schedules
 *                   - availability: Days of week and time slots
 *                 example: '{"travelerDetails":{"pricingModel":"perPerson","maxTravelersPerBooking":15,"ageGroups":[{"label":"Adult","minAge":13,"maxAge":99},{"label":"Child","minAge":6,"maxAge":12},{"label":"Infant","minAge":0,"maxAge":5}]},"pricingSchedules":{"currency":"USD","schedules":[{"startDate":"2026-05-13","endDate":"2026-12-31","prices":[{"ageGroup":"Adult","retailPrice":35.00},{"ageGroup":"Child","retailPrice":25.00},{"ageGroup":"Infant","retailPrice":0.00}]}]},"availability":{"daysOfWeek":["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"],"timeSlots":["10:00","14:00"]}}'
 *               bookingAndTickets:
 *                 type: string
 *                 description: |
 *                   JSON string containing:
 *                   - confirmationType: "INSTANT" or "REQUEST"
 *                   - cancellationPolicy: Cancellation policy text
 *                   - meetingPoint: Meeting point details with type, address, and coordinates
 *                   - checkInProcess: Check-in instructions
 *                 example: '{"confirmationType":"INSTANT","cancellationPolicy":"Free cancellation up to 24 hours before start time","meetingPoint":{"type":"meeting_point","address":"Central Park South Entrance, 59th Street and 5th Avenue, New York, NY","coordinates":{"lat":40.7678,"lng":-73.9812},"instructions":"Meet at the main entrance near the fountain"},"checkInProcess":"Please arrive 10 minutes before tour start time"}'
 *               photos:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *                 description: Tour photos (max 10 images, JPEG/PNG, max 5MB each)
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Search tags for the tour (comma-separated or array)
 *                 example: ["central-park","walking-tour","nyc","nature"]
 *     responses:
 *       201:
 *         description: Tour created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   $ref: '#/components/schemas/Tour'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Access denied - supplier role required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/', restrictTo('supplier'), uploadTourPhotos, tourController.createTour);

/**
 * @swagger
 * /tours/{id}:
 *   patch:
 *     summary: Update tour (suppliers only - own tours)
 *     tags: [Tours, Supplier]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Tour ID or slug
 *         schema:
 *           type: string
 *           example: cmp2hql3c0001tzv0460pbckm
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *                 minLength: 5
 *                 maxLength: 200
 *                 description: Tour title
 *               description:
 *                 type: string
 *                 minLength: 50
 *                 maxLength: 5000
 *                 description: Detailed tour description
 *               categorization:
 *                 type: string
 *                 description: JSON string with category, subcategory, difficulty, and duration
 *               theme:
 *                 type: string
 *                 description: JSON string with theme details
 *               productContent:
 *                 type: string
 *                 description: JSON string with highlights, included items, excluded items, etc.
 *               schedulesAndPricing:
 *                 type: string
 *                 description: JSON string with traveler details, pricing schedules, and availability
 *               bookingAndTickets:
 *                 type: string
 *                 description: JSON string with booking requirements and ticket details
 *               photos:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *                 description: Tour photos (max 10 images)
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Search tags for the tour
 *               status:
 *                 type: string
 *                 enum: [DRAFT, ACTIVE, PAUSED, ARCHIVED]
 *                 description: Tour status
 *     responses:
 *       200:
 *         description: Tour updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   $ref: '#/components/schemas/Tour'
 *       404:
 *         description: Tour not found or access denied
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Access denied - can only update own tours
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.patch('/:id', restrictTo('supplier'), uploadTourPhotos, tourController.updateTour);

/**
 * @swagger
 * /tours/{id}:
 *   delete:
 *     summary: Delete tour (suppliers only - own tours)
 *     tags: [Tours, Supplier]
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
 *         description: Tour deleted successfully
 *       400:
 *         description: Cannot delete tour with active bookings
 *       404:
 *         description: Tour not found or access denied
 */
router.delete('/:id', restrictTo('supplier'), tourController.deleteTour);

/**
 * @swagger
 * /tours/{id}/analytics:
 *   get:
 *     summary: Get tour analytics (suppliers only - own tours)
 *     description: |
 *       Retrieve comprehensive analytics data for a specific tour.
 *       Only the tour owner (supplier) can access analytics for their tours.
 *       
 *       **Analytics include:**
 *       - View statistics (total views, unique visitors)
 *       - Booking statistics (total bookings, conversion rate)
 *       - Revenue metrics (total revenue, average booking value)
 *       - Customer demographics
 *       - Rating and review statistics
 *       - Time-based trends (daily, weekly, monthly)
 *       - Popular booking dates and times
 *       - Cancellation rates
 *     tags: [Tours, Supplier, Analytics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Tour ID
 *         schema:
 *           type: string
 *           example: cmp2hql3c0001tzv0460pbckm
 *       - name: startDate
 *         in: query
 *         description: Start date for analytics period (YYYY-MM-DD)
 *         schema:
 *           type: string
 *           format: date
 *           example: "2026-01-01"
 *       - name: endDate
 *         in: query
 *         description: End date for analytics period (YYYY-MM-DD)
 *         schema:
 *           type: string
 *           format: date
 *           example: "2026-12-31"
 *     responses:
 *       200:
 *         description: Tour analytics retrieved successfully
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
 *                     tour:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                           example: cmp2hql3c0001tzv0460pbckm
 *                         title:
 *                           type: string
 *                           example: Amazing Central Park Walking Tour
 *                         status:
 *                           type: string
 *                           example: ACTIVE
 *                     overview:
 *                       type: object
 *                       properties:
 *                         totalViews:
 *                           type: integer
 *                           description: Total number of tour page views
 *                           example: 1543
 *                         uniqueVisitors:
 *                           type: integer
 *                           description: Number of unique visitors
 *                           example: 892
 *                         totalBookings:
 *                           type: integer
 *                           description: Total number of bookings
 *                           example: 127
 *                         conversionRate:
 *                           type: number
 *                           description: Booking conversion rate (percentage)
 *                           example: 14.2
 *                         totalRevenue:
 *                           type: number
 *                           description: Total revenue generated
 *                           example: 4445.00
 *                         averageBookingValue:
 *                           type: number
 *                           description: Average revenue per booking
 *                           example: 35.00
 *                     bookingStats:
 *                       type: object
 *                       properties:
 *                         confirmed:
 *                           type: integer
 *                           example: 115
 *                         completed:
 *                           type: integer
 *                           example: 110
 *                         cancelled:
 *                           type: integer
 *                           example: 12
 *                         noShow:
 *                           type: integer
 *                           example: 5
 *                         cancellationRate:
 *                           type: number
 *                           description: Cancellation rate (percentage)
 *                           example: 9.4
 *                     revenueByMonth:
 *                       type: array
 *                       description: Monthly revenue breakdown
 *                       items:
 *                         type: object
 *                         properties:
 *                           month:
 *                             type: string
 *                             example: "2026-05"
 *                           revenue:
 *                             type: number
 *                             example: 875.00
 *                           bookings:
 *                             type: integer
 *                             example: 25
 *                     customerDemographics:
 *                       type: object
 *                       properties:
 *                         averageGroupSize:
 *                           type: number
 *                           example: 2.8
 *                         ageGroupDistribution:
 *                           type: object
 *                           properties:
 *                             adults:
 *                               type: integer
 *                               example: 245
 *                             children:
 *                               type: integer
 *                               example: 89
 *                             infants:
 *                               type: integer
 *                               example: 12
 *                     reviewStats:
 *                       type: object
 *                       properties:
 *                         averageRating:
 *                           type: number
 *                           example: 4.7
 *                         totalReviews:
 *                           type: integer
 *                           example: 89
 *                         ratingDistribution:
 *                           type: object
 *                           properties:
 *                             5:
 *                               type: integer
 *                               example: 65
 *                             4:
 *                               type: integer
 *                               example: 18
 *                             3:
 *                               type: integer
 *                               example: 4
 *                             2:
 *                               type: integer
 *                               example: 1
 *                             1:
 *                               type: integer
 *                               example: 1
 *                     popularDates:
 *                       type: array
 *                       description: Most popular booking dates
 *                       items:
 *                         type: object
 *                         properties:
 *                           date:
 *                             type: string
 *                             format: date
 *                             example: "2026-07-04"
 *                           bookings:
 *                             type: integer
 *                             example: 15
 *                     popularTimeSlots:
 *                       type: array
 *                       description: Most popular time slots
 *                       items:
 *                         type: object
 *                         properties:
 *                           time:
 *                             type: string
 *                             example: "10:00"
 *                           bookings:
 *                             type: integer
 *                             example: 45
 *       404:
 *         description: Tour not found or access denied (not your tour)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Access denied - supplier role required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/:id/analytics', restrictTo('supplier'), tourController.getTourAnalytics);

module.exports = router;