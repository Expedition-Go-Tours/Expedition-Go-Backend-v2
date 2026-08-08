/**
 * Availability Routes - Tour Availability Management
 * Handles date-level availability overrides for supplier tours.
 * All routes require authentication; view routes require tours.view or bookings.view,
 * and mutation routes require tours.update permission.
 *
 * @module routes/availabilityRoutes
 */

const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { resolveSupplier, requireTeamPermission } = require('../middleware/teamRoleMiddleware');
const availabilityController = require('../controllers/availabilityController');

const router = express.Router();

// All availability routes require authentication
router.use(protect);

/**
 * @swagger
 * /api/suppliers/{tourId}/availability:
 *   get:
 *     summary: Get availability calendar for a tour
 *     description: |
 *       Retrieve the availability calendar for a specific tour within a date range.
 *       Returns daily status (AVAILABLE, LIMITED, FULL, BLOCKED), capacity, booking counts,
 *       and any date-level overrides. Requires tours.view or bookings.view permission.
 *     tags: [Availability]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: tourId
 *         in: path
 *         required: true
 *         description: Tour ID
 *         schema:
 *           type: string
 *           example: cmpxxx789
 *       - name: startDate
 *         in: query
 *         required: true
 *         description: Start date for the availability range (YYYY-MM-DD)
 *         schema:
 *           type: string
 *           format: date
 *           example: "2026-07-01"
 *       - name: endDate
 *         in: query
 *         required: true
 *         description: End date for the availability range (YYYY-MM-DD). Max range is 366 days.
 *         schema:
 *           type: string
 *           format: date
 *           example: "2026-07-31"
 *     responses:
 *       200:
 *         description: Availability calendar retrieved successfully
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
 *                         title:
 *                           type: string
 *                     startDate:
 *                       type: string
 *                       format: date
 *                       example: "2026-07-01"
 *                     endDate:
 *                       type: string
 *                       format: date
 *                       example: "2026-07-31"
 *                     calendar:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           date:
 *                             type: string
 *                             format: date
 *                             example: "2026-07-01"
 *                           dayOfWeek:
 *                             type: string
 *                             enum: [Sunday, Monday, Tuesday, Wednesday, Thursday, Friday, Saturday]
 *                           isOperatingDay:
 *                             type: boolean
 *                             description: Whether this is a scheduled operating day based on the tour template
  *                           status:
  *                             type: string
  *                             enum: [AVAILABLE, LIMITED, FULL, BLOCKED]
  *                             description: Availability status for the day — Available/Limited/Full are automatic from bookings vs capacity; BLOCKED is set manually
  *                           capacity:
  *                             type: integer
  *                             description: Capacity from the builder's capacity max (max participants)
 *                           booked:
 *                             type: integer
 *                             description: Number of confirmed/pending bookings for this date
 *                           remaining:
 *                             type: integer
 *                             description: Available spots remaining (capacity - booked, min 0)
 *                           timeSlots:
 *                             type: array
 *                             items:
 *                               type: object
 *                               properties:
 *                                 time:
 *                                   type: string
 *                                   example: "10:00"
 *                                 capacity:
 *                                   type: integer
 *                                 booked:
 *                                   type: integer
 *                           hasOverride:
 *                             type: boolean
 *                             description: Whether a date override exists for this day
 *                           overrideStatus:
 *                             type: string
 *                             nullable: true
 *                             description: Manually set override status if any
 *       400:
 *         description: Invalid date parameters or date range exceeds 366 days
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - insufficient permissions
 *       404:
 *         description: Tour not found or access denied
 */
router.get('/:tourId/availability', resolveSupplier, requireTeamPermission('tours.view', 'bookings.view'), availabilityController.getAvailability);

/**
 * @swagger
 * /api/suppliers/{tourId}/availability/{date}:
 *   patch:
 *     summary: Update or create availability override for a specific date
 *     description: |
 *       Create or update a date-level availability override for a tour.
 *       Uses upsert behavior — if an override exists for the given date it is updated,
 *       otherwise a new override is created.
 *       Requires tours.update permission.
 *     tags: [Availability]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: tourId
 *         in: path
 *         required: true
 *         description: Tour ID
 *         schema:
 *           type: string
 *           example: cmpxxx789
 *       - name: date
 *         in: path
 *         required: true
 *         description: Target date for the override (YYYY-MM-DD)
 *         schema:
 *           type: string
 *           format: date
 *           example: "2026-07-15"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
*               status:
 *                 type: string
 *                 enum: [BLOCKED]
 *                 description: Only BLOCKED can be set manually — Available, Limited and Full are automatic. Remove an override to unblock.
 *                 example: BLOCKED
 *               capacity:
 *                 type: integer
 *                 nullable: true
 *                 minimum: 1
 *                 maximum: 100000
 *                 description: Per-day capacity override, in the day's capacity unit (people or group slots). Values below the tour default limit the day; values above it increase it. Null removes the override and reverts to the tour default.
 *                 example: 5
 *               timeSlotOverrides:
  *                 type: array
  *                 description: Override time slot definitions
  *                 items:
  *                   type: object
  *                   properties:
  *                     time:
 *                       type: string
 *                       example: "10:00"
 *                     capacity:
 *                       type: integer
 *                       example: 10
 *                     booked:
 *                       type: integer
 *                       example: 0
 *                 example:
 *                   - time: "10:00"
 *                     capacity: 10
 *                     booked: 0
 *                   - time: "14:00"
 *                     capacity: 10
 *                     booked: 2
 *               notes:
 *                 type: string
 *                 description: Internal notes for this date override
 *                 example: "Private event - limited availability"
 *     responses:
 *       200:
 *         description: Availability override updated/created successfully
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
 *                     override:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                         tourId:
 *                           type: string
 *                         date:
 *                           type: string
 *                           format: date
  *                         status:
  *                           type: string
  *                           enum: [AVAILABLE, LIMITED, FULL, BLOCKED]
*                         capacity:
 *                           type: integer
 *                           nullable: true
 *                           description: Per-day capacity override (null = no override; the day uses the tour default). Enforced for bookings across the whole day.
 *                         timeSlotOverrides:
 *                           type: array
 *                           nullable: true
 *                         notes:
 *                           type: string
 *                           nullable: true
  *       400:
  *         description: Invalid date format, invalid status, or the date already has live bookings
  *       401:
  *         description: Unauthorized
  *       403:
  *         description: Forbidden - insufficient permissions
  *       404:
  *         description: Tour not found or access denied
  */
router.patch('/:tourId/availability/:date', resolveSupplier, requireTeamPermission('tours.update'), availabilityController.updateDateAvailability);

/**
 * @swagger
 * /api/suppliers/{tourId}/availability/{date}:
 *   delete:
 *     summary: Remove a date availability override
 *     description: |
 *       Delete a date-level availability override for a tour.
 *       This removes the manual override and reverts the date to using
 *       template-based availability rules. Requires tours.update permission.
 *     tags: [Availability]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: tourId
 *         in: path
 *         required: true
 *         description: Tour ID
 *         schema:
 *           type: string
 *           example: cmpxxx789
 *       - name: date
 *         in: path
 *         required: true
 *         description: Date to remove override for (YYYY-MM-DD)
 *         schema:
 *           type: string
 *           format: date
 *           example: "2026-07-15"
 *     responses:
 *       200:
 *         description: Override removed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   nullable: true
 *                   example: null
 *       400:
 *         description: Invalid date format
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - insufficient permissions
 *       404:
 *         description: Tour not found or access denied
 */
router.delete('/:tourId/availability/:date', resolveSupplier, requireTeamPermission('tours.update'), availabilityController.removeDateOverride);

/**
 * @swagger
 * /api/suppliers/{tourId}/availability/batch:
 *   post:
 *     summary: Batch update availability for multiple dates
 *     description: |
 *       Create or update availability overrides for multiple dates in a single request.
 *       Each entry is upserted — existing overrides are updated, new ones are created.
 *       Maximum 365 dates per batch. Requires tours.update permission.
 *     tags: [Availability]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: tourId
 *         in: path
 *         required: true
 *         description: Tour ID
 *         schema:
 *           type: string
 *           example: cmpxxx789
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - updates
 *             properties:
 *               updates:
 *                 type: array
 *                 description: Array of date updates (max 365)
 *                 minItems: 1
 *                 maxItems: 365
 *                 items:
 *                   type: object
 *                   required:
 *                     - date
 *                   properties:
 *                     date:
 *                       type: string
 *                       format: date
 *                       description: Date for the override (YYYY-MM-DD)
 *                       example: "2026-07-15"
  *                     status:
  *                       type: string
  *                       enum: [BLOCKED]
  *                       description: Only BLOCKED can be set manually — Available, Limited and Full are automatic
  *                       example: BLOCKED
  *                     timeSlotOverrides:
  *                       type: array
  *                       items:
  *                         type: object
  *                         properties:
  *                           time:
  *                             type: string
  *                           capacity:
  *                             type: integer
  *                           booked:
  *                             type: integer
  *                     notes:
 *                       type: string
 *                       description: Internal notes
 *     responses:
 *       200:
 *         description: Batch update completed successfully
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
 *                     overrides:
 *                       type: array
 *                       items:
 *                         type: object
 *                     count:
 *                       type: integer
 *                       description: Number of dates updated
 *                       example: 5
 *       400:
 *         description: Invalid updates array, invalid date format, or invalid status
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - insufficient permissions
 *       404:
 *         description: Tour not found or access denied
 */
router.post('/:tourId/availability/batch', resolveSupplier, requireTeamPermission('tours.update'), availabilityController.batchUpdateAvailability);

module.exports = router;
