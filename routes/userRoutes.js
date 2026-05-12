const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const userController = require('../controllers/userController');
const authController = require('../controllers/authController');
const { uploadUserPhoto } = require('../middleware/uploadMiddleware');

const router = express.Router();

//  ONBOARDING ROUTES (no Mongo user required)

/**
 * @swagger
 * /users/signup:
 *   post:
 *     summary: Create or get user profile (Firebase authenticated)
 *     description: |
 *       Idempotent endpoint to create a user profile from Firebase authentication.
 *       If the user already exists, returns the existing profile.
 *       This is typically called after Firebase authentication on the client side.
 *       
 *       **Note:** This endpoint does NOT require the user to exist in the database first.
 *       It handles Firebase token verification internally.
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: User's full name (optional, can be synced from Firebase)
 *                 example: John Doe
 *               email:
 *                 type: string
 *                 format: email
 *                 description: User's email (optional, can be synced from Firebase)
 *                 example: john.doe@example.com
 *     responses:
 *       201:
 *         description: User profile created successfully
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
 *       200:
 *         description: User already exists (idempotent operation)
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
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 */
router.post('/signup', authController.signup); // NO protect middleware!

/**
 * @swagger
 * /users/create-me:
 *   post:
 *     summary: Create user profile (Firebase authenticated)
 *     description: |
 *       Create a new user profile with custom data.
 *       This endpoint is used when you want to provide additional user information during signup.
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 100
 *                 description: User's full name
 *                 example: John Doe
 *               phone:
 *                 type: string
 *                 pattern: '^\+?[1-9]\d{1,14}$'
 *                 description: Phone number in international format
 *                 example: "+1234567890"
 *               language:
 *                 type: string
 *                 pattern: '^[a-z]{2}$'
 *                 description: Preferred language (ISO 639-1 code)
 *                 example: en
 *               timezone:
 *                 type: string
 *                 description: User timezone (IANA timezone)
 *                 example: America/New_York
 *           example:
 *             name: John Doe
 *             phone: "+1234567890"
 *             language: en
 *             timezone: America/New_York
 *     responses:
 *       201:
 *         description: User profile created successfully
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
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 */
router.post('/create-me', protect, userController.createMe);

/**
 * @swagger
 * /users/sync-me:
 *   patch:
 *     summary: Sync user profile with Firebase
 *     description: |
 *       Synchronize user profile data with Firebase Authentication.
 *       This is useful when user updates their profile in Firebase (name, email, photo)
 *       and you want to sync those changes to your database.
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: Updated name from Firebase
 *                 example: John Doe
 *               email:
 *                 type: string
 *                 format: email
 *                 description: Updated email from Firebase
 *                 example: john@example.com
 *               photoURL:
 *                 type: string
 *                 format: uri
 *                 description: Updated photo URL from Firebase
 *                 example: https://lh3.googleusercontent.com/a/default-user
 *           example:
 *             name: John Doe
 *             email: john@example.com
 *             photoURL: https://lh3.googleusercontent.com/a/default-user
 *     responses:
 *       200:
 *         description: User synced successfully
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
 */
router.patch('/sync-me', protect, userController.syncMe);

/**
 * @swagger
 * /users/updateMe:
 *   patch:
 *     summary: Update current user profile
 *     description: |
 *       Update the authenticated user's profile information.
 *       Supports updating name, phone, and profile photo.
 *       Photo is uploaded to Cloudinary and the URL is stored.
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 100
 *                 description: User's full name
 *                 example: John Doe
 *               phone:
 *                 type: string
 *                 pattern: '^\+?[1-9]\d{1,14}$'
 *                 description: Phone number in international format
 *                 example: "+1234567890"
 *               language:
 *                 type: string
 *                 pattern: '^[a-z]{2}$'
 *                 description: Preferred language (ISO 639-1)
 *                 example: en
 *               timezone:
 *                 type: string
 *                 description: User timezone (IANA timezone)
 *                 example: America/New_York
 *               photo:
 *                 type: string
 *                 format: binary
 *                 description: User profile photo (JPEG/PNG, max 5MB)
 *     responses:
 *       200:
 *         description: User updated successfully
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
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 */
router.patch(
  '/updateMe',
  protect,
  uploadUserPhoto, // this enables file upload
  userController.updateMe,
);

//  EVERYTHING BELOW REQUIRES FULL USER
router.use(protect);

/**
 * @swagger
 * /users/me:
 *   get:
 *     summary: Get current user profile
 *     description: Retrieve the authenticated user's complete profile information
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User profile retrieved successfully
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
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *   delete:
 *     summary: Delete current user account
 *     description: |
 *       Permanently delete the authenticated user's account.
 *       This action:
 *       - Deletes the user profile from the database
 *       - Cancels all pending bookings
 *       - Removes the user from Firebase Authentication
 *       - Cannot be undone
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       204:
 *         description: User deleted successfully (no content)
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 */
router.get('/me', userController.getMe);
router.delete('/me', userController.deleteMe);

/**
 * @swagger
 * /users/wishlist/{tourId}:
 *   patch:
 *     summary: Toggle tour in wishlist
 *     description: |
 *       Add or remove a tour from the user's wishlist.
 *       If the tour is already in the wishlist, it will be removed.
 *       If the tour is not in the wishlist, it will be added.
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: tourId
 *         in: path
 *         required: true
 *         description: Tour ID to add/remove from wishlist
 *         schema:
 *           type: string
 *           example: cmp2hql3c0001tzv0460pbckm
 *     responses:
 *       200:
 *         description: Wishlist updated successfully
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
 *                   example: Tour added to wishlist
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *       404:
 *         description: Tour not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 */
router.patch('/wishlist/:tourId', userController.toggleWishlist);

/**
 * @swagger
 * /users/like/{tourId}:
 *   patch:
 *     summary: Toggle tour like
 *     description: |
 *       Like or unlike a tour.
 *       If the tour is already liked, it will be unliked.
 *       If the tour is not liked, it will be liked.
 *       Likes are used for personalized recommendations.
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: tourId
 *         in: path
 *         required: true
 *         description: Tour ID to like/unlike
 *         schema:
 *           type: string
 *           example: cmp2hql3c0001tzv0460pbckm
 *     responses:
 *       200:
 *         description: Like toggled successfully
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
 *                   example: Tour liked
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       $ref: '#/components/schemas/User'
 *       404:
 *         description: Tour not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 */
router.patch('/like/:tourId', userController.toggleLike);

/**
 * @swagger
 * /users/{id}:
 *   delete:
 *     summary: Delete a user (Admin only)
 *     description: |
 *       Admin endpoint to delete any user account.
 *       This action:
 *       - Deletes the user profile from the database
 *       - Cancels all pending bookings
 *       - Removes the user from Firebase Authentication
 *       - Cannot be undone
 *       
 *       **Warning:** Use with caution. This is a destructive operation.
 *     tags: [Users, Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: User ID to delete
 *         schema:
 *           type: string
 *           example: cmp2h5edn0000wrs1gfllik7m
 *     responses:
 *       204:
 *         description: User deleted successfully (no content)
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         description: Access denied - admin role required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/responses/ForbiddenError'
 *       404:
 *         description: User not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/responses/NotFoundError'
 */
router.delete('/:id', restrictTo('admin'), userController.deleteUser);

module.exports = router;