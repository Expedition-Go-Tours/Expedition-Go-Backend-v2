const express = require('express');
const authController = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/login', authController.login);
router.post('/register', authController.register);
router.post('/refresh', authController.refresh);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);
router.get('/google', authController.googleAuth);
router.get('/google/callback', authController.googleCallback);
router.post('/logout', protect, authController.logout);
router.patch('/change-password', protect, authController.changePassword);

module.exports = router;
