const express = require('express');
const { createLimiter } = require('../middleware/dynamicRateLimiter');
const { protect } = require('../middleware/authMiddleware');
const { requireTeamRole, resolveSupplier } = require('../middleware/teamRoleMiddleware');
const teamController = require('../controllers/teamController');
const settingsController = require('../controllers/supplierSettingsController');

const router = express.Router();

const teamInviteLimiter = createLimiter({
  name: 'team_invite',
  defaultMax: 10,
  defaultWindowMs: 60 * 60 * 1000,
  message: {
    status: 'fail',
    message: 'Too many invitation attempts, please try again later.',
  },
});

const inviteLookupLimiter = createLimiter({
  name: 'invite_lookup',
  defaultMax: 30,
  defaultWindowMs: 15 * 60 * 1000,
  message: {
    status: 'fail',
    message: 'Too many requests, please try again later.',
  },
});

// Public — no auth required
/**
 * @swagger
 * /api/suppliers/team/invite/{token}:
 *   get:
 *     summary: Get team invite details
 *     description: |
 *       Retrieve details of a pending team invitation by token.
 *       Returns the supplier name, invited role, email, and status.
 *       No authentication required.
 *     tags: [Suppliers, Team]
 *     parameters:
 *       - name: token
 *         in: path
 *         required: true
 *         description: The unique invite token
 *         schema:
 *           type: string
 *           example: a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
 *     responses:
 *       200:
 *         description: Invite details retrieved successfully
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
 *                     supplierName:
 *                       type: string
 *                       example: "Adventure Tours Ghana"
 *                     role:
 *                       type: string
 *                       example: editor
 *                     invitedEmail:
 *                       type: string
 *                       format: email
 *                       example: "user@example.com"
 *                     status:
 *                       type: string
 *                       example: PENDING
 *       404:
 *         description: Invitation not found
 *       410:
 *         description: Invitation has expired or been revoked
 *       409:
 *         description: Invitation has already been accepted
 */
router.get('/team/invite/:token', inviteLookupLimiter, teamController.getInviteDetails);

// Auth required
router.use(protect);

/**
 * @swagger
 * /api/suppliers/team/my-role:
 *   get:
 *     summary: Get my team role
 *     description: |
 *       Returns the authenticated user's role and permissions within
 *       a supplier team, or indicates if they are the owner/admin.
 *     tags: [Suppliers, Team]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Role information retrieved successfully
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
 *                     role:
 *                       type: string
 *                       nullable: true
 *                       example: admin
 *                     permissions:
 *                       type: array
 *                       items:
 *                         type: string
 *                       example: ["*"]
 *                     isOwner:
 *                       type: boolean
 *                       example: true
 *                     supplierId:
 *                       type: string
 *                       example: "supp_abc123"
 */
router.get('/team/my-role', teamController.getMyTeamRole);

/**
 * @swagger
 * /api/suppliers/team/invite/{token}/accept:
 *   post:
 *     summary: Accept team invite
 *     description: |
 *       Accept a pending team invitation.
 *       The authenticated user's email must match the invited email.
 *     tags: [Suppliers, Team]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: token
 *         in: path
 *         required: true
 *         description: The unique invite token
 *         schema:
 *           type: string
 *           example: a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
 *     responses:
 *       200:
 *         description: Invitation accepted successfully
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
 *                   example: Invitation accepted successfully
 *                 data:
 *                   type: object
 *                   properties:
 *                     member:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                           example: "cmptm1234"
 *                         email:
 *                           type: string
 *                           format: email
 *                           example: "user@example.com"
 *                         role:
 *                           type: string
 *                           example: editor
 *                         status:
 *                           type: string
 *                           example: ACCEPTED
 *                         acceptedAt:
 *                           type: string
 *                           format: date-time
 *                         createdAt:
 *                           type: string
 *                           format: date-time
 *                         updatedAt:
 *                           type: string
 *                           format: date-time
 *       403:
 *         description: Email mismatch - invite sent to a different email
 *       404:
 *         description: Invitation not found
 *       409:
 *         description: Invitation has already been accepted
 *       410:
 *         description: Invitation has expired or been revoked
 */
router.post('/team/invite/:token/accept', teamController.acceptInvite);

/**
 * @swagger
 * /api/suppliers/team/invite/{token}/decline:
 *   post:
 *     summary: Decline team invite
 *     description: |
 *       Decline a pending team invitation.
 *       The authenticated user's email must match the invited email.
 *     tags: [Suppliers, Team]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: token
 *         in: path
 *         required: true
 *         description: The unique invite token
 *         schema:
 *           type: string
 *           example: a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
 *     responses:
 *       200:
 *         description: Invitation declined
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
 *                   example: Invitation declined
 *       400:
 *         description: Invitation is not in PENDING status
 *       403:
 *         description: Email mismatch - invite sent to a different email
 *       404:
 *         description: Invitation not found
 */
router.post('/team/invite/:token/decline', teamController.declineInvite);

// Supplier access (owner or invited team member)
router.use(resolveSupplier);

/**
 * @swagger
 * /api/suppliers/business-profile:
 *   get:
 *     summary: Get business profile
 *     description: |
 *       Retrieve the supplier's business profile including business
 *       information and operating details.
 *     tags: [Suppliers, Business Profile]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Business profile retrieved successfully
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
 *                     businessInfo:
 *                       type: object
 *                       description: Business information (name, address, etc.)
 *                       example:
 *                         businessName: "Adventure Tours Ghana"
 *                         businessEmail: "info@adventuretours.com"
 *                         phone: "+233-55-123-4567"
 *                     operatingInfo:
 *                       type: object
 *                       description: Operating details
 *                       example:
 *                         timezone: "Africa/Accra"
 *                         currency: "GHS"
 */
router.get('/business-profile', settingsController.getBusinessProfile);

/**
 * @swagger
 * /api/suppliers/business-profile:
 *   patch:
 *     summary: Update business profile
 *     description: |
 *       Update the supplier's business profile.
 *       Merge-updates the provided fields under businessInfo and/or operatingInfo.
 *       Requires admin or editor role.
 *     tags: [Suppliers, Business Profile]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               businessInfo:
 *                 type: object
 *                 description: Business information fields to update
 *                 example:
 *                   businessName: "Adventure Tours Ghana Ltd"
 *                   businessEmail: "contact@adventuretours.com"
 *               operatingInfo:
 *                 type: object
 *                 description: Operating details to update
 *                 example:
 *                   timezone: "Africa/Accra"
 *                   currency: "GHS"
 *     responses:
 *       200:
 *         description: Business profile updated successfully
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
 *                     businessInfo:
 *                       type: object
 *                     operatingInfo:
 *                       type: object
 *       404:
 *         description: Supplier profile not found
 */
router.patch('/business-profile', requireTeamRole('admin', 'editor'), settingsController.updateBusinessProfile);

/**
 * @swagger
 * /api/suppliers/notification-preferences:
 *   get:
 *     summary: Get notification preferences
 *     description: |
 *       Retrieve the authenticated user's notification preferences
 *       for email and push notifications across different event types.
 *     tags: [Suppliers, Settings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Notification preferences retrieved successfully
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
 *                     emailNotifications:
 *                       type: object
 *                       properties:
 *                         bookings:
 *                           type: boolean
 *                           example: true
 *                         reviews:
 *                           type: boolean
 *                           example: true
 *                         payments:
 *                           type: boolean
 *                           example: true
 *                         systemAlerts:
 *                           type: boolean
 *                           example: true
 *                     pushNotifications:
 *                       type: object
 *                       properties:
 *                         bookings:
 *                           type: boolean
 *                           example: true
 *                         reviews:
 *                           type: boolean
 *                           example: true
 *                         payments:
 *                           type: boolean
 *                           example: true
 *                         systemAlerts:
 *                           type: boolean
 *                           example: true
 */
router.get('/notification-preferences', settingsController.getNotificationPreferences);

/**
 * @swagger
 * /api/suppliers/notification-preferences:
 *   put:
 *     summary: Update notification preferences
 *     description: |
 *       Update the authenticated user's notification preferences.
 *       Merge-updates the provided sections (emailNotifications and/or pushNotifications).
 *       Requires admin role.
 *     tags: [Suppliers, Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               emailNotifications:
 *                 type: object
 *                 description: Email notification toggles
 *                 properties:
 *                   bookings:
 *                     type: boolean
 *                     example: true
 *                   reviews:
 *                     type: boolean
 *                     example: false
 *                   payments:
 *                     type: boolean
 *                     example: true
 *                   systemAlerts:
 *                     type: boolean
 *                     example: true
 *               pushNotifications:
 *                 type: object
 *                 description: Push notification toggles
 *                 properties:
 *                   bookings:
 *                     type: boolean
 *                     example: true
 *                   reviews:
 *                     type: boolean
 *                     example: false
 *                   payments:
 *                     type: boolean
 *                     example: true
 *                   systemAlerts:
 *                     type: boolean
 *                     example: false
 *     responses:
 *       200:
 *         description: Notification preferences updated successfully
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
 *       400:
 *         description: Provide emailNotifications or pushNotifications
 */
router.put('/notification-preferences', requireTeamRole('admin'), settingsController.updateNotificationPreferences);

/**
 * @swagger
 * /api/suppliers/tax-info:
 *   get:
 *     summary: Get tax info
 *     description: |
 *       Retrieve the supplier's tax information and business documents.
 *     tags: [Suppliers, Settings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Tax info retrieved successfully
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
 *                     taxInfo:
 *                       type: object
 *                       example:
 *                         taxId: "TX-12345"
 *                         taxCountry: "GH"
 *                         legalBusinessName: "Adventure Tours Ghana Ltd"
 *                         businessType: "Tour Operator"
 *                     documents:
 *                       type: object
 *                       description: Uploaded business documents
 *                       example: {}
 */
router.get('/tax-info', settingsController.getTaxInfo);

/**
 * @swagger
 * /api/suppliers/tax-info:
 *   patch:
 *     summary: Update tax info
 *     description: |
 *       Update the supplier's tax information including tax ID,
 *       tax country, legal business name, and business type.
 *       Also syncs legalBusinessName and businessType into businessInfo.
 *       Requires admin or finance role.
 *     tags: [Suppliers, Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               taxId:
 *                 type: string
 *                 description: Tax registration number
 *                 example: "TX-12345"
 *               taxCountry:
 *                 type: string
 *                 description: Country code for tax jurisdiction
 *                 example: "GH"
 *               legalBusinessName:
 *                 type: string
 *                 description: Legal/registered business name
 *                 example: "Adventure Tours Ghana Ltd"
 *               businessType:
 *                 type: string
 *                 description: Type of business entity
 *                 example: "Tour Operator"
 *     responses:
 *       200:
 *         description: Tax info updated successfully
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
 *                     taxInfo:
 *                       type: object
 *                     documents:
 *                       type: object
 *       404:
 *         description: Supplier profile not found
 */
router.patch('/tax-info', requireTeamRole('admin', 'finance'), settingsController.updateTaxInfo);

/**
 * @swagger
 * /api/suppliers/booking-rules:
 *   get:
 *     summary: Get booking rules
 *     description: |
 *       Retrieve the supplier's booking rules including confirmation
 *       type, traveler limits, advance booking windows, and cancellation policy.
 *     tags: [Suppliers, Settings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Booking rules retrieved successfully
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
 *                     confirmationType:
 *                       type: string
 *                       enum: [INSTANT, MANUAL]
 *                       example: INSTANT
 *                     maxTravelersPerBooking:
 *                       type: integer
 *                       example: 15
 *                     minAdvanceHours:
 *                       type: integer
 *                       example: 24
 *                     maxAdvanceDays:
 *                       type: integer
 *                       example: 365
 *                     cancellationPolicy:
 *                       type: string
 *                       example: "Free cancellation up to 24 hours before start time"
 *                     cancellationWindowHours:
 *                       type: integer
 *                       example: 24
 */
router.get('/booking-rules', settingsController.getBookingRules);

/**
 * @swagger
 * /api/suppliers/booking-rules:
 *   put:
 *     summary: Update booking rules
 *     description: |
 *       Update the supplier's booking rules. Merge-updates the provided fields.
 *       Requires admin or editor role.
 *     tags: [Suppliers, Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               confirmationType:
 *                 type: string
 *                 enum: [INSTANT, MANUAL]
 *                 example: INSTANT
 *               maxTravelersPerBooking:
 *                 type: integer
 *                 example: 20
 *               minAdvanceHours:
 *                 type: integer
 *                 example: 48
 *               maxAdvanceDays:
 *                 type: integer
 *                 example: 180
 *               cancellationPolicy:
 *                 type: string
 *                 example: "Free cancellation up to 48 hours before start time"
 *               cancellationWindowHours:
 *                 type: integer
 *                 example: 48
 *     responses:
 *       200:
 *         description: Booking rules updated successfully
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
 *                   description: The full updated booking rules object
 *       404:
 *         description: Supplier profile not found
 */
router.put('/booking-rules', requireTeamRole('admin', 'editor'), settingsController.updateBookingRules);

/**
 * @swagger
 * /api/suppliers/team/members:
 *   get:
 *     summary: Get team members
 *     description: |
 *       Retrieve all team members for the current supplier with optional
 *       status filtering and pagination. Requires admin role.
 *     tags: [Suppliers, Team]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: status
 *         in: query
 *         description: Filter by invite/membership status
 *         schema:
 *           type: string
 *           enum: [PENDING, ACCEPTED, REVOKED, EXPIRED]
 *         example: ACCEPTED
 *       - name: page
 *         in: query
 *         description: Page number for pagination
 *         schema:
 *           type: integer
 *           default: 1
 *           example: 1
 *       - name: limit
 *         in: query
 *         description: Number of members per page
 *         schema:
 *           type: integer
 *           default: 50
 *           example: 20
 *     responses:
 *       200:
 *         description: Team members retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 results:
 *                   type: integer
 *                   example: 2
 *                 data:
 *                   type: object
 *                   properties:
 *                     members:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                             example: "cmptm1234"
 *                           email:
 *                             type: string
 *                             format: email
 *                             example: "user@example.com"
 *                           role:
 *                             type: string
 *                             example: editor
 *                           status:
 *                             type: string
 *                             example: ACCEPTED
 *                           invitedById:
 *                             type: string
 *                             example: "user_abc"
 *                           acceptedAt:
 *                             type: string
 *                             format: date-time
 *                             nullable: true
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
 *                           example: 1
 *                         totalPages:
 *                           type: integer
 *                           example: 1
 *                         totalCount:
 *                           type: integer
 *                           example: 2
 *                         limit:
 *                           type: integer
 *                           example: 50
 */
router.get('/team/members', requireTeamRole('admin'), teamController.getMembers);

/**
 * @swagger
 * /api/suppliers/team/invite:
 *   post:
 *     summary: Invite team member
 *     description: |
 *       Send a team invitation email to a new member.
 *       Optionally set their role and whether to directly add them without email.
 *       Rate-limited to 10 requests per hour. Requires admin role.
 *     tags: [Suppliers, Team]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 description: Email address of the invitee
 *                 example: "newmember@example.com"
 *               role:
 *                 type: string
 *                 description: Team role for the invitee
 *                 enum: [admin, editor, finance, viewer]
 *                 default: editor
 *                 example: editor
 *               directAdd:
 *                 type: boolean
 *                 description: If true, add directly without sending an invitation email
 *                 default: false
 *                 example: false
 *     responses:
 *       201:
 *         description: Invitation sent successfully (or member added directly)
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
 *                   example: Invitation sent to newmember@example.com
 *                 data:
 *                   type: object
 *                   properties:
 *                     member:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                         email:
 *                           type: string
 *                         role:
 *                           type: string
 *                         status:
 *                           type: string
 *                         createdAt:
 *                           type: string
 *                           format: date-time
 *                         updatedAt:
 *                           type: string
 *                           format: date-time
 *       400:
 *         description: Validation error - invalid email, duplicate invite, or team size limit reached
 */
router.post('/team/invite', requireTeamRole('admin'), teamInviteLimiter, teamController.inviteMember);

/**
 * @swagger
 * /api/suppliers/team/invite/resend:
 *   post:
 *     summary: Resend team invite
 *     description: |
 *       Resend a pending team invitation email with a new token.
 *       Rate-limited to 10 requests per hour. Requires admin role.
 *     tags: [Suppliers, Team]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 description: Email address to resend the invitation to
 *                 example: "pendingmember@example.com"
 *     responses:
 *       200:
 *         description: Invitation resent successfully
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
 *                   example: Invitation resent to pendingmember@example.com
 *       400:
 *         description: Invalid email, invitation already accepted, or invitation revoked
 *       404:
 *         description: No pending invitation found for this email
 */
router.post('/team/invite/resend', requireTeamRole('admin'), teamInviteLimiter, teamController.resendInvite);

/**
 * @swagger
 * /api/suppliers/team/invite/{memberId}/revoke:
 *   patch:
 *     summary: Revoke team invite
 *     description: |
 *       Revoke a pending team invitation. The invitee will receive a
 *       revocation email notification. Requires admin role.
 *     tags: [Suppliers, Team]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: memberId
 *         in: path
 *         required: true
 *         description: The ID of the pending team member record
 *         schema:
 *           type: string
 *           example: "cmptm1234"
 *     responses:
 *       200:
 *         description: Invitation revoked successfully
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
 *                   example: Invitation revoked successfully
 *       400:
 *         description: Invitation is already in a non-PENDING state
 *       404:
 *         description: Team member not found
 */
router.patch('/team/invite/:memberId/revoke', requireTeamRole('admin'), teamController.revokeInvite);

/**
 * @swagger
 * /api/suppliers/team/direct-add:
 *   post:
 *     summary: Direct add team member
 *     description: |
 *       Directly add a team member without sending an invitation email.
 *       The member is immediately set to ACCEPTED status.
 *       Rate-limited to 10 requests per hour. Requires admin role.
 *     tags: [Suppliers, Team]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - role
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 description: Email address of the member
 *                 example: "directmember@example.com"
 *               role:
 *                 type: string
 *                 description: Team role for the member
 *                 enum: [admin, editor, finance, viewer]
 *                 example: editor
 *     responses:
 *       201:
 *         description: Member added directly
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
 *                   example: directmember@example.com added as a team member
 *                 data:
 *                   type: object
 *                   properties:
 *                     member:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                         email:
 *                           type: string
 *                         role:
 *                           type: string
 *                         status:
 *                           type: string
 *                         acceptedAt:
 *                           type: string
 *                           format: date-time
 *                         createdAt:
 *                           type: string
 *                           format: date-time
 *                         updatedAt:
 *                           type: string
 *                           format: date-time
 *       400:
 *         description: Validation error - invalid email, role, duplicate, or team size limit reached
 */
router.post('/team/direct-add', requireTeamRole('admin'), teamInviteLimiter, teamController.directAddMember);

/**
 * @swagger
 * /api/suppliers/team/members/{id}:
 *   delete:
 *     summary: Remove team member
 *     description: |
 *       Permanently remove a team member from the supplier's team.
 *       Requires admin role.
 *     tags: [Suppliers, Team]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: The ID of the team member to remove
 *         schema:
 *           type: string
 *           example: "cmptm1234"
 *     responses:
 *       200:
 *         description: Team member removed successfully
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
 *                   example: Team member removed successfully
 *       404:
 *         description: Team member not found
 */
router.delete('/team/members/:id', requireTeamRole('admin'), teamController.removeMember);

/**
 * @swagger
 * /api/suppliers/team/members/{id}/role:
 *   patch:
 *     summary: Update member role
 *     description: |
 *       Update the role of an existing team member.
 *       Admins cannot change their own role. Requires admin role.
 *     tags: [Suppliers, Team]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: The ID of the team member
 *         schema:
 *           type: string
 *           example: "cmptm1234"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - role
 *             properties:
 *               role:
 *                 type: string
 *                 description: New team role
 *                 enum: [admin, editor, finance, viewer]
 *                 example: admin
 *     responses:
 *       200:
 *         description: Member role updated successfully
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
 *                     member:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                         email:
 *                           type: string
 *                         role:
 *                           type: string
 *                         status:
 *                           type: string
 *                         acceptedAt:
 *                           type: string
 *                           format: date-time
 *                           nullable: true
 *                         createdAt:
 *                           type: string
 *                           format: date-time
 *                         updatedAt:
 *                           type: string
 *                           format: date-time
 *       400:
 *         description: Invalid role provided
 *       403:
 *         description: You cannot change your own role
 *       404:
 *         description: Team member not found
 */
router.patch('/team/members/:id/role', requireTeamRole('admin'), teamController.updateMemberRole);

/**
 * @swagger
 * /api/suppliers/team/members/{id}:
 *   get:
 *     summary: Get team member by ID
 *     description: |
 *       Retrieve details of a specific team member by their ID.
 *       Requires admin role.
 *     tags: [Suppliers, Team]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: The ID of the team member
 *         schema:
 *           type: string
 *           example: "cmptm1234"
 *     responses:
 *       200:
 *         description: Team member retrieved successfully
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
 *                     member:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                         email:
 *                           type: string
 *                         role:
 *                           type: string
 *                         status:
 *                           type: string
 *                         invitedById:
 *                           type: string
 *                         acceptedAt:
 *                           type: string
 *                           format: date-time
 *                           nullable: true
 *                         createdAt:
 *                           type: string
 *                           format: date-time
 *                         updatedAt:
 *                           type: string
 *                           format: date-time
 *       404:
 *         description: Team member not found
 */
router.get('/team/members/:id', requireTeamRole('admin'), teamController.getMemberById);

/**
 * @swagger
 * /api/suppliers/team/cleanup-expired:
 *   post:
 *     summary: Cleanup expired invites
 *     description: |
 *       Mark all expired pending invitations as EXPIRED.
 *       Returns the count of cleaned-up invitations. Requires admin role.
 *     tags: [Suppliers, Team]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Expired invites cleaned up successfully
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
 *                   example: 3 expired invitation(s) cleaned up
 *                 data:
 *                   type: object
 *                   properties:
 *                     cleanedCount:
 *                       type: integer
 *                       example: 3
 */
router.post('/team/cleanup-expired', requireTeamRole('admin'), teamController.cleanupExpiredInvites);

module.exports = router;
