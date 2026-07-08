const express = require('express');
const authController = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

const noCache = (req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
};

router.use(noCache);

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Log in with email and password
 *     description: Authenticates a user using local strategy (email + password) via Passport.js and returns JWT access and refresh tokens.
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 description: User email address
 *                 example: john.doe@example.com
 *               password:
 *                 type: string
 *                 format: password
 *                 description: User account password
 *                 example: mySecureP@ss123
 *     responses:
 *       200:
 *         description: Login successful — returns user profile and JWT tokens
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
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *                     accessToken:
 *                       type: string
 *                       description: JWT access token (short-lived, 15 min)
 *                       example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOi...
 *                     refreshToken:
 *                       type: string
 *                       description: JWT refresh token (long-lived, 7 days)
 *                       example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOi...
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 */
router.post('/login', authController.login);

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Register a new account
 *     description: Creates a new user account with local authentication. Also creates a Stripe customer. Returns the user profile and JWT tokens.
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - email
 *               - password
 *             properties:
 *               name:
 *                 type: string
 *                 description: User full name
 *                 minLength: 1
 *                 maxLength: 100
 *                 example: John Doe
 *               email:
 *                 type: string
 *                 format: email
 *                 description: User email address (will be lowercased and trimmed)
 *                 example: john.doe@example.com
 *               password:
 *                 type: string
 *                 format: password
 *                 description: User password (minimum 8 characters)
 *                 minLength: 8
 *                 example: mySecureP@ss123
 *     responses:
 *       201:
 *         description: Account created successfully — returns user profile and JWT tokens
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
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *                     accessToken:
 *                       type: string
 *                       description: JWT access token (short-lived, 15 min)
 *                       example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOi...
 *                     refreshToken:
 *                       type: string
 *                       description: JWT refresh token (long-lived, 7 days)
 *                       example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOi...
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       409:
 *         description: Account already exists with this email
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *             example:
 *               status: fail
 *               message: An account with this email already exists
 *               error:
 *                 statusCode: 409
 *                 status: fail
 *                 isOperational: true
 */
router.post('/register', authController.register);

/**
 * @swagger
 * /api/auth/refresh:
 *   post:
 *     summary: Refresh access token
 *     description: Validates the provided refresh token, rotates it (old token revoked), and issues a new access + refresh token pair.
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - refreshToken
 *             properties:
 *               refreshToken:
 *                 type: string
 *                 description: Valid refresh token issued at login or previous refresh
 *                 example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOi...
 *     responses:
 *       200:
 *         description: Tokens refreshed successfully — old refresh token is revoked
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
 *                     accessToken:
 *                       type: string
 *                       description: New JWT access token
 *                       example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOi...
 *                     refreshToken:
 *                       type: string
 *                       description: New JWT refresh token (previous one revoked)
 *                       example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOi...
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 */
router.post('/refresh', authController.refresh);

/**
 * @swagger
 * /api/auth/forgot-password:
 *   post:
 *     summary: Send password reset email
 *     description: Accepts an email address and sends a password reset link if the account exists. Always returns 200 for security (prevents email enumeration).
 *     tags: [Authentication]
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
 *                 description: Email address of the account to reset
 *                 example: john.doe@example.com
 *     responses:
 *       200:
 *         description: Always returns success regardless of whether the email exists (security best practice)
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
 *                   example: If an account with that email exists, a password reset link has been sent.
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 */
router.post('/forgot-password', authController.forgotPassword);

/**
 * @swagger
 * /api/auth/reset-password:
 *   post:
 *     summary: Reset password with token
 *     description: Resets the user password using a valid reset token (sent via email). The token must have the 'password_reset' purpose claim.
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *               - password
 *             properties:
 *               token:
 *                 type: string
 *                 description: Password reset token (received via email)
 *                 example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOi...
 *               password:
 *                 type: string
 *                 format: password
 *                 description: New password (minimum 8 characters)
 *                 minLength: 8
 *                 example: newSecureP@ss456
 *     responses:
 *       200:
 *         description: Password reset successfully
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
 *                   example: Password has been reset successfully. You can now log in with your new password.
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 */
router.post('/reset-password', authController.resetPassword);

/**
 * @swagger
 * /api/auth/google:
 *   get:
 *     summary: Initiate Google OAuth sign-in
 *     description: Redirects the user to Google's OAuth consent screen. After authentication, Google redirects to /api/auth/google/callback.
 *     tags: [Authentication]
 *     parameters:
 *       - in: query
 *         name: prompt
 *         schema:
 *           type: string
 *           default: select_account
 *           enum: [none, select_account, consent]
 *         description: Google OAuth prompt parameter. Use 'consent' to force re-consent, 'none' to suppress if already authenticated.
 *         example: select_account
 *     responses:
 *       302:
 *         description: Redirects to Google OAuth consent screen
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *             description: Google OAuth URL
 *       503:
 *         description: Google OAuth not configured
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/google', authController.googleAuth);

/**
 * @swagger
 * /api/auth/google/callback:
 *   get:
 *     summary: Google OAuth callback
 *     description: Handles the Google OAuth callback. On success, redirects to the client app with JWT tokens in the URL query string.
 *     tags: [Authentication]
 *     responses:
 *       302:
 *         description: Redirects to the client app with accessToken and refreshToken as query parameters
 *         headers:
 *           Location:
 *             schema:
 *               type: string
 *             description: Client URL with tokens (e.g. https://client.com/auth/callback?accessToken=...&refreshToken=...)
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 */
router.get('/google/callback', authController.googleCallback);

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: Log out (clear refresh token)
 *     description: Revokes the user's refresh token and emits a logout event. Requires a valid JWT access token.
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Logged out successfully
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
 *                   example: Logged out successfully
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 */
router.post('/set-cookies', authController.setCookies);
router.post('/logout', protect, authController.logout);

/**
 * @swagger
 * /api/auth/change-password:
 *   patch:
 *     summary: Change password
 *     description: Changes the authenticated user's password. Requires the current password for verification and a new password (minimum 8 characters). Only works for local auth accounts.
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - currentPassword
 *               - newPassword
 *             properties:
 *               currentPassword:
 *                 type: string
 *                 format: password
 *                 description: Current account password
 *                 example: myOldP@ss123
 *               newPassword:
 *                 type: string
 *                 format: password
 *                 description: New password (minimum 8 characters)
 *                 minLength: 8
 *                 example: myNewSecureP@ss456
 *     responses:
 *       200:
 *         description: Password updated successfully
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
 *                   example: Password updated successfully
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 */
router.patch('/change-password', protect, authController.changePassword);

module.exports = router;
