const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const teamController = require('../controllers/teamController');
const settingsController = require('../controllers/supplierSettingsController');

const router = express.Router();

router.use(protect);

// Token-based team invite routes — any authenticated user can accept/decline
router.get('/team/invite/:token', teamController.getInviteDetails);
router.post('/team/invite/:token/accept', teamController.acceptInvite);
router.post('/team/invite/:token/decline', teamController.declineInvite);

router.use(restrictTo('supplier'));

// Business Profile
router.get('/business-profile', settingsController.getBusinessProfile);
router.patch('/business-profile', settingsController.updateBusinessProfile);

// Notification Preferences
router.get('/notification-preferences', settingsController.getNotificationPreferences);
router.put('/notification-preferences', settingsController.updateNotificationPreferences);

// Tax Info
router.get('/tax-info', settingsController.getTaxInfo);
router.patch('/tax-info', settingsController.updateTaxInfo);

// Booking Rules
router.get('/booking-rules', settingsController.getBookingRules);
router.put('/booking-rules', settingsController.updateBookingRules);

// Team Management (supplier only)
router.get('/team/members', teamController.getMembers);
router.post('/team/invite', teamController.inviteMember);
router.post('/team/direct-add', teamController.directAddMember);
router.delete('/team/members/:id', teamController.removeMember);
router.patch('/team/members/:id/role', teamController.updateMemberRole);
router.get('/team/members/:id', teamController.getMemberById);

module.exports = router;