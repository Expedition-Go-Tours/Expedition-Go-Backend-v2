const express = require('express');
const rateLimit = require('express-rate-limit');
const { protect } = require('../middleware/authMiddleware');
const { requireTeamRole, resolveSupplier } = require('../middleware/teamRoleMiddleware');
const teamController = require('../controllers/teamController');
const settingsController = require('../controllers/supplierSettingsController');

const router = express.Router();

const teamInviteLimiter = rateLimit({
  max: 10,
  windowMs: 60 * 60 * 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 'fail',
    message: 'Too many invitation attempts, please try again later.',
  },
});

// Public — no auth required
router.get('/team/invite/:token', teamController.getInviteDetails);

// Auth required
router.use(protect);

router.get('/team/my-role', teamController.getMyTeamRole);
router.post('/team/invite/:token/accept', teamController.acceptInvite);
router.post('/team/invite/:token/decline', teamController.declineInvite);

// Supplier access (owner or invited team member)
router.use(resolveSupplier);

router.get('/business-profile', settingsController.getBusinessProfile);
router.patch('/business-profile', requireTeamRole('admin', 'editor'), settingsController.updateBusinessProfile);

router.get('/notification-preferences', settingsController.getNotificationPreferences);
router.put('/notification-preferences', requireTeamRole('admin'), settingsController.updateNotificationPreferences);

router.get('/tax-info', settingsController.getTaxInfo);
router.patch('/tax-info', requireTeamRole('admin', 'finance'), settingsController.updateTaxInfo);

router.get('/booking-rules', settingsController.getBookingRules);
router.put('/booking-rules', requireTeamRole('admin', 'editor'), settingsController.updateBookingRules);

router.get('/team/members', requireTeamRole('admin'), teamController.getMembers);
router.post('/team/invite', requireTeamRole('admin'), teamInviteLimiter, teamController.inviteMember);
router.post('/team/invite/resend', requireTeamRole('admin'), teamInviteLimiter, teamController.resendInvite);
router.patch('/team/invite/:memberId/revoke', requireTeamRole('admin'), teamController.revokeInvite);
router.post('/team/direct-add', requireTeamRole('admin'), teamInviteLimiter, teamController.directAddMember);
router.delete('/team/members/:id', requireTeamRole('admin'), teamController.removeMember);
router.patch('/team/members/:id/role', requireTeamRole('admin'), teamController.updateMemberRole);
router.get('/team/members/:id', requireTeamRole('admin'), teamController.getMemberById);

module.exports = router;
