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
 *         description: Filter by main category (e.g., Cultural, Adventure, Nature)
 *         schema:
 *           type: string
 *           example: Cultural
 *       - name: subcategory
 *         in: query
 *         description: Filter by subcategory (e.g., Walking Tours, Hiking)
 *         schema:
 *           type: string
 *           example: Walking Tours
 *       - name: activityType
 *         in: query
 *         description: Filter by specific activity type
 *         schema:
 *           type: string
 *       - name: theme
 *         in: query
 *         description: Filter by theme (searches both primary and secondary themes)
 *         schema:
 *           type: string
 *           example: Nature & Wildlife
 *       - name: primaryTheme
 *         in: query
 *         description: Filter by primary theme only
 *         schema:
 *           type: string
 *       - name: secondaryTheme
 *         in: query
 *         description: Filter by secondary theme
 *         schema:
 *           type: string
 *       - name: location
 *         in: query
 *         description: Search across city, country, region, and address
 *         schema:
 *           type: string
 *           example: New York
 *       - name: city
 *         in: query
 *         description: Filter by specific city
 *         schema:
 *           type: string
 *           example: New York
 *       - name: country
 *         in: query
 *         description: Filter by country
 *         schema:
 *           type: string
 *           example: United States
 *       - name: region
 *         in: query
 *         description: Filter by region
 *         schema:
 *           type: string
 *       - name: minPrice
 *         in: query
 *         description: Minimum price filter
 *         schema:
 *           type: number
 *           example: 20
 *       - name: maxPrice
 *         in: query
 *         description: Maximum price filter
 *         schema:
 *           type: number
 *           example: 100
 *       - name: priceRange
 *         in: query
 *         description: Predefined price range
 *         schema:
 *           type: string
 *           enum: [budget, moderate, luxury]
 *           example: moderate
 *       - name: currency
 *         in: query
 *         description: Currency for price filtering
 *         schema:
 *           type: string
 *           default: USD
 *       - name: minRating
 *         in: query
 *         description: Minimum average rating (0-5)
 *         schema:
 *           type: number
 *           minimum: 0
 *           maximum: 5
 *           example: 4.0
 *       - name: minReviews
 *         in: query
 *         description: Minimum number of reviews
 *         schema:
 *           type: integer
 *           example: 10
 *       - name: minDuration
 *         in: query
 *         description: Minimum duration
 *         schema:
 *           type: integer
 *       - name: maxDuration
 *         in: query
 *         description: Maximum duration
 *         schema:
 *           type: integer
 *       - name: durationType
 *         in: query
 *         description: Duration unit
 *         schema:
 *           type: string
 *           enum: [hours, days]
 *           default: hours
 *       - name: availableDate
 *         in: query
 *         description: Filter tours available on specific date (YYYY-MM-DD)
 *         schema:
 *           type: string
 *           format: date
 *           example: "2026-06-15"
 *       - name: dayOfWeek
 *         in: query
 *         description: Filter by day of week
 *         schema:
 *           type: string
 *           enum: [Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday]
 *       - name: instantConfirmation
 *         in: query
 *         description: Filter tours with instant confirmation
 *         schema:
 *           type: boolean
 *       - name: freeCancellation
 *         in: query
 *         description: Filter tours with free cancellation
 *         schema:
 *           type: boolean
 *       - name: search
 *         in: query
 *         description: Full-text search in title and description. Uses PostgreSQL tsvector ranking — results are sorted by relevance when this is provided (unless another sortBy is explicitly set).
 *         schema:
 *           type: string
 *           example: luxury safari cape town
 *       - name: tags
 *         in: query
 *         description: Filter by tags (comma-separated)
 *         schema:
 *           type: string
 *           example: nature,photography
 *       - name: supplierId
 *         in: query
 *         description: Filter by specific supplier
 *         schema:
 *           type: string
 *       - name: verifiedOnly
 *         in: query
 *         description: Show only verified suppliers
 *         schema:
 *           type: boolean
  *       - name: lat
  *         in: query
  *         description: Center latitude for geo-distance "near me" search (requires lng). Tours within radius km are returned with distanceKm field.
  *         schema:
  *           type: number
  *           minimum: -90
  *           maximum: 90
  *           example: 5.6037
  *       - name: lng
  *         in: query
  *         description: Center longitude for geo-distance search (requires lat)
  *         schema:
  *           type: number
  *           minimum: -180
  *           maximum: 180
  *           example: -0.187
  *       - name: radius
  *         in: query
  *         description: Search radius in kilometers (default 50). Used with lat/lng.
  *         schema:
  *           type: number
  *           default: 50
  *           example: 30
  *       - name: sortBy
  *         in: query
  *         description: Sort field
  *         schema:
  *           type: string
  *           enum: [createdAt, updatedAt, title, price, rating, reviews, bookings, popularity, relevance, nearest]
  *           default: createdAt
  *       - name: sortOrder
  *         in: query
  *         description: Sort order
  *         schema:
  *           type: string
  *           enum: [asc, desc]
  *           default: desc
  *     responses:
  *       200:
  *         description: Tours retrieved successfully
  *         content:
  *           application/json:
  *             schema:
  *               type: object
  *               properties:
  *                 tours:
  *                   type: array
  *                   items:
  *                     allOf:
  *                       - $ref: '#/components/schemas/Tour'
  *                       - type: object
  *                         properties:
  *                           distanceKm:
  *                             type: number
  *                             nullable: true
  *                             description: Distance from search center in km (only when lat/lng provided)
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
 *                         limit:
 *                           type: integer
 *                     appliedFilters:
 *                       type: object
 *                       description: Summary of applied filters
 *       400:
 *         description: Invalid filter parameters
 */
router.get('/', tourController.getAllTours);

/**
 * @swagger
 * /tours/filters/options:
 *   get:
 *     summary: Get available filter options
 *     description: |
 *       Returns all available filter values extracted from active tours.
 *       Use this endpoint to populate filter dropdowns and UI elements.
 *       
 *       **Returns:**
 *       - Available categories, subcategories, and activity types
 *       - Available themes (primary and secondary)
 *       - Available locations (cities, countries, regions)
 *       - Available tags
 *       - Predefined price ranges
 *       - Predefined duration ranges
 *     tags: [Tours]
 *     responses:
 *       200:
 *         description: Filter options retrieved successfully
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
 *                     filterOptions:
 *                       type: object
 *                       properties:
 *                         categories:
 *                           type: array
 *                           items:
 *                             type: string
 *                           example: ["Adventure", "Cultural", "Nature", "Food & Drink"]
 *                         subcategories:
 *                           type: array
 *                           items:
 *                             type: string
 *                           example: ["Walking Tours", "Hiking", "City Tours", "Wine Tasting"]
 *                         activityTypes:
 *                           type: array
 *                           items:
 *                             type: string
 *                           example: ["Guided Tour", "Self-Guided", "Private Tour"]
 *                         themes:
 *                           type: object
 *                           properties:
 *                             primary:
 *                               type: array
 *                               items:
 *                                 type: string
 *                               example: ["Nature & Wildlife", "History & Culture", "Adventure"]
 *                             secondary:
 *                               type: array
 *                               items:
 *                                 type: string
 *                               example: ["Photography", "Family-Friendly", "Romantic"]
 *                         locations:
 *                           type: object
 *                           properties:
 *                             cities:
 *                               type: array
 *                               items:
 *                                 type: string
 *                               example: ["New York", "Paris", "Tokyo", "London"]
 *                             countries:
 *                               type: array
 *                               items:
 *                                 type: string
 *                               example: ["United States", "France", "Japan", "United Kingdom"]
 *                             regions:
 *                               type: array
 *                               items:
 *                                 type: string
 *                               example: ["Manhattan", "Île-de-France", "Kanto"]
 *                         tags:
 *                           type: array
 *                           items:
 *                             type: string
 *                           example: ["nature", "photography", "family-friendly", "romantic"]
 *                         priceRanges:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               label:
 *                                 type: string
 *                               value:
 *                                 type: string
 *                               range:
 *                                 type: string
 *                           example:
 *                             - label: Budget
 *                               value: budget
 *                               range: "$0 - $50"
 *                             - label: Moderate
 *                               value: moderate
 *                               range: "$50 - $150"
 *                             - label: Luxury
 *                               value: luxury
 *                               range: "$150+"
 *                         durations:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               label:
 *                                 type: string
 *                               value:
 *                                 type: string
 *                               hours:
 *                                 type: object
 *                               days:
 *                                 type: object
 *                           example:
 *                             - label: "Short (< 3 hours)"
 *                               value: short
 *                               hours:
 *                                 max: 3
 *                             - label: "Half Day (3-6 hours)"
 *                               value: half-day
 *                               hours:
 *                                 min: 3
 *                                 max: 6
 *       500:
 *         description: Failed to retrieve filter options
 */
router.get('/filters/options', tourController.getFilterOptions);

/**
 * @swagger
 * /tours/popular/by-category:
 *   get:
 *     summary: Get popular tours grouped by category
 *     description: |
 *       Returns tours ranked by a weighted popularity score within each category.
 *       Scoring signals: bookings (40%), rating (25%), review count (20%), view count (15%).
 *     tags: [Tours]
 *     parameters:
 *       - name: perCategory
 *         in: query
 *         schema:
 *           type: integer
 *           default: 6
 *           minimum: 1
 *           maximum: 20
 *         description: Number of top tours to return per category
 *       - name: category
 *         in: query
 *         schema:
 *           type: string
 *         description: Filter to a single category
 *       - name: theme
 *         in: query
 *         schema:
 *           type: string
 *         description: Filter by primary or secondary theme
 *     responses:
 *       200:
 *         description: Popular tours retrieved successfully
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
 *                     categories:
 *                       type: object
 *                       description: Object mapping category names to arrays of scored tours
 *                       additionalProperties:
 *                         type: array
 *                         items:
 *                           allOf:
 *                             - $ref: '#/components/schemas/Tour'
 *                             - type: object
 *                               properties:
 *                                 popularityScore:
 *                                   type: number
 *                                   description: Normalized popularity score (0-1)
 *                     weights:
 *                       type: object
 *                       description: Scoring weights used in calculation
 */
router.get('/popular/by-category', tourController.getPopularByCategory);

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
 * /tours/seed:
 *   post:
 *     summary: Create a simulated tour for development/testing
 *     description: |
 *       **Development only.** Creates a tour with realistic mock data.
 *       If the user doesn't have a supplier profile, one is created automatically.
 *     tags: [Tours, Development]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Simulated tour created successfully
 *       403:
 *         description: Only available in development mode
 */
router.post('/seed', tourController.seedTour);

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
 *                   - transportMode: Object with air/land/water arrays (e.g., {"land":["Walking","4x4/Jeep"],"air":["Plane"]})
 *                 example: '{"category":"Cultural","subcategory":"Walking Tours","difficulty":"Easy","duration":120,"transportMode":{"land":["Walking","4x4/Jeep"],"air":["Plane"]}}'
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
 *               coverPhoto:
 *                 type: string
 *                 description: URL of the cover/featured image for the tour. If not provided, the first photo in the photos array is used. Should be one of the uploaded photo URLs.
 *                 example: https://res.cloudinary.com/dfpagrtoy/image/upload/v1/tours/cover.jpg
 *               coverPhotoIndex:
 *                 type: string
 *                 description: Zero-based index of which uploaded photo should be the cover/hero image. Overrides coverPhoto.
 *                 example: "0"
 *               latitude:
  *                 type: number
  *                 format: float
  *                 minimum: -90
  *                 maximum: 90
  *                 description: Tour location latitude for geo-search (must be provided with longitude)
  *                 example: 40.7678
  *               longitude:
  *                 type: number
  *                 format: float
  *                 minimum: -180
  *                 maximum: 180
  *                 description: Tour location longitude for geo-search (must be provided with latitude)
  *                 example: -73.9812
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
 *                 description: New tour photo files to upload. Existing photos to keep should be sent via existingPhotos field.
 *               coverPhoto:
 *                 type: string
 *                 description: URL of the cover/featured image for the tour
 *               coverPhotoIndex:
 *                 type: string
 *                 description: Zero-based index of which newly uploaded photo should be the cover/hero image
 *                 example: "0"
 *               existingPhotos:
 *                 type: string
 *                 description: JSON string array of existing photo URLs to keep. Photos not in this list will be deleted from Cloudinary.
 *                 example: '["https://res.cloudinary.com/dfpagrtoy/image/upload/v1/tours/photo1.jpg","https://res.cloudinary.com/dfpagrtoy/image/upload/v1/tours/photo2.jpg"]'
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Search tags for the tour
  *               latitude:
  *                 type: number
  *                 format: float
  *                 minimum: -90
  *                 maximum: 90
  *                 description: Tour location latitude for geo-search
  *                 example: 40.7678
  *               longitude:
  *                 type: number
  *                 format: float
  *                 minimum: -180
  *                 maximum: 180
  *                 description: Tour location longitude for geo-search
  *                 example: -73.9812
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
 *     description: Deletes a tour (sets status to ARCHIVED) and removes all associated photos from Cloudinary.
 *     responses:
 *       204:
 *         description: Tour deleted successfully. All associated Cloudinary images have been cleaned up.
 *       400:
 *         description: Cannot delete tour with active bookings
 *       404:
 *         description: Tour not found or access denied
 */
router.delete('/:id', restrictTo('supplier'), tourController.deleteTour);

/**
 * @swagger
 * /tours/{id}/photos:
 *   delete:
 *     summary: Delete a specific photo from a tour (suppliers only - own tours)
 *     tags: [Tours, Supplier]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Tour ID
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - photoUrl
 *             properties:
 *               photoUrl:
 *                 type: string
 *                 description: The full Cloudinary URL of the photo to delete
 *                 example: https://res.cloudinary.com/dfpagrtoy/image/upload/v1/tours/photo.jpg
 *     responses:
 *       200:
 *         description: Photo deleted successfully
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
 *                   example: Photo deleted successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     photos:
 *                       type: array
 *                       items:
 *                         type: string
 *                       description: Updated photos array after deletion
 *                     coverPhoto:
 *                       type: string
 *                       nullable: true
 *                       description: Updated cover photo (null if the deleted photo was the cover)
 *       400:
 *         description: Photo URL is required
 *       404:
 *         description: Tour not found, access denied, or photo not found in tour
 */
router.delete('/:id/photos', restrictTo('supplier'), tourController.deleteTourPhoto);

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