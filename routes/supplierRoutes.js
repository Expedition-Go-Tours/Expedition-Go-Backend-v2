/**
 * Supplier Routes - Production Ready
 * Handles all supplier-related endpoints
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const supplierController = require('../controllers/supplierController');
const { uploadSupplierDocuments } = require('../middleware/uploadMiddleware');

const router = express.Router();

// All routes require authentication
router.use(protect);

// ================================
// SUPPLIER APPLICATION PROCESS
// ================================

/**
 * @swagger
 * /suppliers/apply:
 *   post:
 *     summary: Submit supplier application
 *     description: |
 *       Submit a complete supplier application to become a tour provider on the platform.
 *       All fields must be provided as JSON strings in multipart/form-data format.
 *       Documents must be uploaded as files.
 *     tags: [Suppliers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - businessInfo
 *               - operatingInfo
 *               - representativeInfo
 *               - payoutInfo
 *               - registrationDocument
 *               - taxDocument
 *               - proofOfAddress
 *               - idDocument
 *             properties:
 *               businessInfo:
 *                 type: string
 *                 description: |
 *                   JSON string containing business information:
 *                   - legalBusinessName: Legal registered business name (required)
 *                   - displayName: Public display name (required)
 *                   - businessType: "individual", "company", or "non_profit" (required)
 *                   - country: ISO 3166-1 alpha-2 country code (required)
 *                   - address: Object with line1, city, state, postalCode (required)
 *                   - website: Business website URL (optional)
 *                   - phoneNumber: Business phone number (required)
 *                 example: '{"legalBusinessName":"Adventure Tours Ltd","displayName":"Adventure Tours","businessType":"company","country":"US","address":{"line1":"123 Main Street","line2":"Suite 100","city":"New York","state":"NY","postalCode":"10001"},"website":"https://adventuretours.com","phoneNumber":"+1-555-123-4567"}'
 *               operatingInfo:
 *                 type: string
 *                 description: |
 *                   JSON string containing operating information:
 *                   - tourCategories: Array of tour types offered (required)
 *                   - destinations: Array of geographic areas served (required)
 *                   - languages: Array of languages spoken by guides (required)
 *                   - yearsInBusiness: Years of experience (optional)
 *                   - cancellationPolicy: Standard cancellation policy (required)
 *                   - meetingStyle: "pickup", "meeting_point", or "flexible" (required)
 *                 example: '{"tourCategories":["Adventure","Cultural","Nature"],"destinations":["New York","California","Florida"],"languages":["English","Spanish","French"],"yearsInBusiness":5,"cancellationPolicy":"Free cancellation up to 24 hours before tour start time","meetingStyle":"pickup"}'
 *               representativeInfo:
 *                 type: string
 *                 description: |
 *                   JSON string containing legal representative information:
 *                   - fullName: Full legal name (required)
 *                   - email: Email address (required)
 *                   - phoneNumber: Phone number (optional, used as operator contact in booking emails)
 *                   - dateOfBirth: Date of birth in YYYY-MM-DD format (required, must be 18+)
 *                   - address: Object with line1, city, state, postalCode (required)
 *                   - idType: "passport", "drivers_license", or "national_id" (required)
 *                 example: '{"fullName":"John Smith","email":"john@adventuretours.com","phoneNumber":"+1-555-123-4567","dateOfBirth":"1985-06-15","address":{"line1":"456 Oak Avenue","line2":"Apt 2B","city":"New York","state":"NY","postalCode":"10002"},"idType":"passport"}'
 *               payoutInfo:
 *                 type: string
 *                 description: |
 *                   JSON string containing bank account information:
 *                   - bankAccountName: Name on bank account (required)
 *                   - bankCountry: ISO 3166-1 alpha-2 country code (required)
 *                   - payoutCurrency: ISO 4217 currency code (required)
 *                 example: '{"bankAccountName":"Adventure Tours Ltd","bankCountry":"US","payoutCurrency":"USD"}'
 *               registrationDocument:
 *                 type: string
 *                 format: binary
 *                 description: Business registration certificate (PDF, max 5MB)
 *               taxDocument:
 *                 type: string
 *                 format: binary
 *                 description: Tax identification document (PDF, max 5MB)
 *               proofOfAddress:
 *                 type: string
 *                 format: binary
 *                 description: Proof of business address (PDF, max 5MB)
 *               idDocument:
 *                 type: string
 *                 format: binary
 *                 description: Representative ID document (PDF/Image, max 5MB)
 *               licenses:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *                 description: Additional business licenses (optional, PDF, max 5MB each)
 *     responses:
 *       201:
 *         description: Supplier application submitted successfully
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
 *                   example: Supplier application submitted successfully
 *                 data:
 *                   $ref: '#/components/schemas/SupplierProfile'
 *       400:
 *         description: Validation error or application already exists
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/apply', uploadSupplierDocuments, supplierController.applyToBeSupplier);

/**
 * @swagger
 * /suppliers/application/status:
 *   get:
 *     summary: Get supplier application status
 *     description: Retrieve the current status of the authenticated user's supplier application
 *     tags: [Suppliers]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Application status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   $ref: '#/components/schemas/SupplierProfile'
 *       404:
 *         description: No supplier application found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/application/status', supplierController.getApplicationStatus);

/**
 * @swagger
 * /suppliers/application:
 *   patch:
 *     summary: Update supplier application (only if PENDING or UNDER_REVIEW)
 *     tags: [Suppliers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Application updated successfully
 *       400:
 *         description: Application cannot be modified in current status
 *       404:
 *         description: No supplier application found
 */
router.patch('/application', uploadSupplierDocuments, supplierController.updateApplication);

// ================================
// SUPPLIER DASHBOARD
// ================================

/**
 * @swagger
 * /suppliers/dashboard:
 *   get:
 *     summary: Get supplier dashboard data
 *     description: |
 *       Retrieve comprehensive dashboard data for the supplier including:
 *       - Total earnings and revenue statistics
 *       - Active tours count
 *       - Booking statistics (pending, confirmed, completed)
 *       - Recent reviews and average rating
 *       - Performance metrics
 *     tags: [Suppliers, Dashboard]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard data retrieved successfully
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
 *                     earnings:
 *                       type: object
 *                       properties:
 *                         totalEarnings:
 *                           type: number
 *                           example: 12500.75
 *                         pendingPayouts:
 *                           type: number
 *                           example: 1250.50
 *                         thisMonthEarnings:
 *                           type: number
 *                           example: 3200.00
 *                     tours:
 *                       type: object
 *                       properties:
 *                         total:
 *                           type: integer
 *                           example: 15
 *                         active:
 *                           type: integer
 *                           example: 12
 *                         draft:
 *                           type: integer
 *                           example: 2
 *                         paused:
 *                           type: integer
 *                           example: 1
 *                     bookings:
 *                       type: object
 *                       properties:
 *                         total:
 *                           type: integer
 *                           example: 342
 *                         pending:
 *                           type: integer
 *                           example: 5
 *                         confirmed:
 *                           type: integer
 *                           example: 12
 *                         completed:
 *                           type: integer
 *                           example: 320
 *                     reviews:
 *                       type: object
 *                       properties:
 *                         averageRating:
 *                           type: number
 *                           example: 4.8
 *                         totalReviews:
 *                           type: integer
 *                           example: 289
 *                         recentReviews:
 *                           type: array
 *                           items:
 *                             $ref: '#/components/schemas/Review'
 *       404:
 *         description: Supplier profile not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/dashboard', restrictTo('supplier'), supplierController.getDashboard);

/**
 * @swagger
 * /suppliers/earnings:
 *   get:
 *     summary: Get supplier earnings and payout history
 *     description: |
 *       Retrieve detailed earnings information including:
 *       - Total earnings breakdown
 *       - Payout history with dates and amounts
 *       - Pending payouts
 *       - Transaction details
 *       Supports filtering by date range and pagination.
 *     tags: [Suppliers, Earnings]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: page
 *         in: query
 *         description: Page number for pagination
 *         schema:
 *           type: integer
 *           default: 1
 *           example: 1
 *       - name: limit
 *         in: query
 *         description: Number of records per page
 *         schema:
 *           type: integer
 *           default: 20
 *           example: 20
 *       - name: startDate
 *         in: query
 *         description: Filter earnings from this date (YYYY-MM-DD)
 *         schema:
 *           type: string
 *           format: date
 *           example: "2026-01-01"
 *       - name: endDate
 *         in: query
 *         description: Filter earnings until this date (YYYY-MM-DD)
 *         schema:
 *           type: string
 *           format: date
 *           example: "2026-12-31"
 *     responses:
 *       200:
 *         description: Earnings retrieved successfully
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
 *                     summary:
 *                       type: object
 *                       properties:
 *                         totalEarnings:
 *                           type: number
 *                           description: Total lifetime earnings
 *                           example: 12500.75
 *                         totalPayouts:
 *                           type: number
 *                           description: Total amount paid out
 *                           example: 11000.00
 *                         pendingPayouts:
 *                           type: number
 *                           description: Amount pending payout
 *                           example: 1500.75
 *                         currency:
 *                           type: string
 *                           example: USD
 *                     payouts:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                             example: cmp2hql3c0001tzv0460pbckm
 *                           amount:
 *                             type: number
 *                             example: 850.50
 *                           status:
 *                             type: string
 *                             enum: [PENDING, PROCESSING, PAID, FAILED]
 *                             example: PAID
 *                           paidAt:
 *                             type: string
 *                             format: date-time
 *                             example: "2026-05-01T10:00:00.000Z"
 *                           stripePayoutId:
 *                             type: string
 *                             example: po_1234567890abcdef
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         currentPage:
 *                           type: integer
 *                           example: 1
 *                         totalPages:
 *                           type: integer
 *                           example: 5
 *                         totalCount:
 *                           type: integer
 *                           example: 95
 *                         hasNextPage:
 *                           type: boolean
 *                           example: true
 *       403:
 *         description: Access denied - supplier role required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/earnings', restrictTo('supplier'), supplierController.getEarnings);

// ================================
// ADMIN SUPPLIER MANAGEMENT
// ================================

/**
 * @swagger
 * /suppliers/admin/applications:
 *   get:
 *     summary: Get all supplier applications (admin only)
 *     description: |
 *       Retrieve all supplier applications with filtering and pagination.
 *       Admin can filter by application status and review pending applications.
 *     tags: [Suppliers, Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: status
 *         in: query
 *         description: Filter by application status
 *         schema:
 *           type: string
 *           enum: [PENDING, UNDER_REVIEW, APPROVED, REJECTED, ACTIVE, SUSPENDED]
 *           example: PENDING
 *       - name: page
 *         in: query
 *         description: Page number
 *         schema:
 *           type: integer
 *           default: 1
 *           example: 1
 *       - name: limit
 *         in: query
 *         description: Items per page
 *         schema:
 *           type: integer
 *           default: 20
 *           example: 20
 *     responses:
 *       200:
 *         description: Applications retrieved successfully
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
 *                     applications:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/SupplierProfile'
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         currentPage:
 *                           type: integer
 *                           example: 1
 *                         totalPages:
 *                           type: integer
 *                           example: 3
 *                         totalCount:
 *                           type: integer
 *                           example: 47
 *                         hasNextPage:
 *                           type: boolean
 *                           example: true
 *       403:
 *         description: Access denied - admin role required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/admin/applications', restrictTo('admin'), supplierController.getAllApplications);

/**
 * @swagger
 * /suppliers/admin/applications/{id}/review:
 *   patch:
 *     summary: Review supplier application (admin only)
 *     description: |
 *       Admin review of supplier applications. Available actions:
 *       - **approve**: Approve the application
 *       - **reject**: Reject the application with reason
 *       - **request_info**: Request additional information from supplier
 *     tags: [Suppliers, Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Supplier application ID
 *         schema:
 *           type: string
 *           example: cmp2himz40001iwkfib3ld8to
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - action
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [approve, reject, request_info]
 *                 description: Review action to take
 *                 example: approve
 *               notes:
 *                 type: string
 *                 minLength: 10
 *                 maxLength: 1000
 *                 description: Admin notes (required for reject and request_info)
 *                 example: All documents verified. Business registration is valid. Approved for Stripe onboarding.
 *           examples:
 *             approve:
 *               summary: Approve application
 *               value:
 *                 action: approve
 *                 notes: All documents verified. Business registration is valid. Approved.
 *             reject:
 *               summary: Reject application
 *               value:
 *                 action: reject
 *                 notes: Business registration document is expired. Please submit a current registration certificate.
 *             requestInfo:
 *               summary: Request more information
 *               value:
 *                 action: request_info
 *                 notes: Please provide a clearer copy of your tax identification document. The current upload is not legible.
 *     responses:
 *       200:
 *         description: Application reviewed successfully
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
 *                   example: Application approved successfully
 *                 data:
 *                   $ref: '#/components/schemas/SupplierProfile'
 *       400:
 *         description: Invalid review action or missing required notes
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Supplier application not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Access denied - admin role required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.patch('/admin/applications/:id/review', restrictTo('admin'), supplierController.reviewApplication);

/**
 * @swagger
 * /suppliers/admin/{id}/suspend:
 *   patch:
 *     summary: Suspend/unsuspend supplier (admin only)
 *     description: |
 *       Suspend or reactivate a supplier account. Suspended suppliers cannot:
 *       - Create or edit tours
 *       - Receive new bookings
 *       - Access earnings
 *       
 *       Existing bookings for suspended suppliers remain valid.
 *     tags: [Suppliers, Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Supplier profile ID
 *         schema:
 *           type: string
 *           example: cmp2himz40001iwkfib3ld8to
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - suspend
 *             properties:
 *               suspend:
 *                 type: boolean
 *                 description: true to suspend, false to reactivate
 *                 example: true
 *               reason:
 *                 type: string
 *                 minLength: 10
 *                 maxLength: 1000
 *                 description: Reason for suspension/reactivation (required for suspension)
 *                 example: Multiple customer complaints about tour quality and safety concerns. Suspended pending investigation.
 *           examples:
 *             suspend:
 *               summary: Suspend supplier
 *               value:
 *                 suspend: true
 *                 reason: Multiple customer complaints about tour quality and safety concerns. Suspended pending investigation.
 *             reactivate:
 *               summary: Reactivate supplier
 *               value:
 *                 suspend: false
 *                 reason: Investigation completed. Issues resolved. Supplier has implemented corrective measures.
 *     responses:
 *       200:
 *         description: Supplier status updated successfully
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
 *                   example: Supplier suspended successfully
 *                 data:
 *                   $ref: '#/components/schemas/SupplierProfile'
 *       400:
 *         description: Missing required reason for suspension
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Supplier not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Access denied - admin role required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.patch('/admin/:id/suspend', restrictTo('admin'), supplierController.suspendSupplier);

/**
 * @swagger
 * /suppliers/admin/{id}/activate:
 *   patch:
 *     summary: Activate a supplier (admin)
 *     description: |
 *       Activates a supplier directly.
 *       Supplier must be in APPROVED status first.
 *       Supplier should have at least one verified payout method before activation.
 *     tags: [Suppliers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Supplier user ID
 *     responses:
 *       200:
 *         description: Supplier activated
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
 *                     supplierProfile:
 *                       $ref: '#/components/schemas/SupplierProfile'
 *       400:
 *         description: Supplier not in APPROVED status
 */
router.patch('/admin/:id/activate', restrictTo('admin'), supplierController.activateSupplier);

module.exports = router;