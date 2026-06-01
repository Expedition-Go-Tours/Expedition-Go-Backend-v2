/**
 * User Controller - Production Ready
 * Handles user profile management and authentication
 * 
 * Features:
 * - User profile CRUD operations
 * - Multi-role support (customer, supplier, admin)
 * - Stripe customer integration
 * - Wishlist and likes management
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { deleteCloudinaryImage } = require('../utils/cloudinaryHelper');
const { logActivity } = require('../utils/auditLogger');
const { cloudinaryUrl } = require('../utils/imageOptimizer');
const admin = require('../config/firebaseAdmin');

exports.getMe = (req, res, next) => {
  if (!req.user) {
    return next(new AppError('User not found', 404));
  }

  // Optimize user photo
  const optimizedUser = {
    ...req.user,
    photoURL: req.user.photoURL
      ? cloudinaryUrl(req.user.photoURL, 300)
      : req.user.photoURL,
  };

  res.status(200).json({
    status: 'success',
    data: { user: optimizedUser },
  });
};

exports.updateMe = catchAsync(async (req, res, next) => {
  //  Block email updates
  if (req.body.email) {
    return next(new AppError('Email cannot be updated here', 400));
  }

  const updates = {};

  //  Text fields
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.phone !== undefined) updates.phone = req.body.phone;
  if (req.body.language !== undefined) updates.language = req.body.language;
  if (req.body.timezone !== undefined) updates.timezone = req.body.timezone;

  if (req.file) {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
    });

    if (user?.photoURL) {
      await deleteCloudinaryImage(user.photoURL);
    }

    updates.photoURL = req.file.path;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(200).json({
      status: 'success',
      data: { user: req.user },
    });
  }

  const updatedUser = await prisma.user.update({
    where: { id: req.user.id },
    data: updates,
  });

  // Log activity
  await logActivity({
    userId: req.user.id,
    action: 'user.profile_updated',
    resource: 'User',
    resourceId: req.user.id,
    oldValues: req.user,
    newValues: updatedUser
  });

  res.status(200).json({ status: 'success', data: { user: updatedUser } });
});

exports.deleteMe = catchAsync(async (req, res) => {
  // Soft delete by setting active to false
  await prisma.user.update({
    where: { id: req.user.id },
    data: { active: false }
  });

  // Log activity
  await logActivity({
    userId: req.user.id,
    action: 'user.account_deleted',
    resource: 'User',
    resourceId: req.user.id
  });

  res.status(204).json({
    status: 'success',
    data: null,
  });
});

exports.deleteUser = catchAsync(async (req, res, next) => {
  try {
    await prisma.user.delete({ where: { id: req.params.id } });
  } catch {
    return next(new AppError('User not found', 404));
  }

  // Log activity
  await logActivity({
    userId: req.user.id,
    action: 'user.deleted_by_admin',
    resource: 'User',
    resourceId: req.params.id
  });

  res.status(204).json({ status: 'success', data: null });
});

exports.toggleWishlist = catchAsync(async (req, res, next) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return next(new AppError('User not found', 404));

  const tourId = req.params.tourId;

  const isWishlisted = user.wishlist.includes(tourId);
  const nextWishlist = isWishlisted
    ? user.wishlist.filter((id) => id !== tourId)
    : [...user.wishlist, tourId];

  const updatedUser = await prisma.user.update({
    where: { id: req.user.id },
    data: { wishlist: nextWishlist },
  });

  // Log activity
  await logActivity({
    userId: req.user.id,
    action: isWishlisted ? 'user.wishlist_removed' : 'user.wishlist_added',
    resource: 'User',
    resourceId: req.user.id,
    metadata: { tourId }
  });

  res.status(200).json({ status: 'success', data: { wishlist: updatedUser.wishlist } });
});

exports.toggleLike = catchAsync(async (req, res, next) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return next(new AppError('User not found', 404));

  const tourId = req.params.tourId;
  const isLiked = user.likes.includes(tourId);
  const nextLikes = isLiked ? user.likes.filter((id) => id !== tourId) : [...user.likes, tourId];

  const updatedUser = await prisma.user.update({
    where: { id: req.user.id },
    data: { likes: nextLikes },
  });

  // Log activity
  await logActivity({
    userId: req.user.id,
    action: isLiked ? 'user.like_removed' : 'user.like_added',
    resource: 'User',
    resourceId: req.user.id,
    metadata: { tourId }
  });

  res.status(200).json({ status: 'success', data: { likes: updatedUser.likes } });
});

exports.createMe = catchAsync(async (req, res, next) => {
  const firebaseUser = req.firebaseUser;

  if (!firebaseUser || !firebaseUser.uid) {
    return next(new AppError('Invalid Firebase user', 400));
  }

  let user = await prisma.user.findUnique({ where: { firebaseUid: firebaseUser.uid } });

  if (user) {
    return res.status(200).json({ status: 'success', data: { user } });
  }

  // Create Stripe customer
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  let stripeCustomer = null;
  
  try {
    stripeCustomer = await stripe.customers.create({
      email: firebaseUser.email,
      name: firebaseUser.name || firebaseUser.email?.split('@')[0] || 'User',
      metadata: {
        firebaseUid: firebaseUser.uid
      }
    });
  } catch (error) {
    console.error('❌ Failed to create Stripe customer:', error);
  }

  user = await prisma.user.create({
    data: {
      firebaseUid: firebaseUser.uid,
      name: firebaseUser.name || firebaseUser.email?.split('@')[0] || 'User',
      email: firebaseUser.email,
      photoURL: firebaseUser.picture || '',
      stripeCustomerId: stripeCustomer?.id,
      roles: ['customer']
    },
  });

  // Log activity
  await logActivity({
    userId: user.id,
    userEmail: user.email,
    action: 'user.created',
    resource: 'User',
    resourceId: user.id,
    metadata: {
      source: 'firebase',
      stripeCustomerId: stripeCustomer?.id
    }
  });

  res.status(201).json({ status: 'success', data: { user } });
});

exports.syncMe = catchAsync(async (req, res) => {
  const firebaseUser = req.firebaseUser;

  const existing = await prisma.user.findUnique({ where: { firebaseUid: firebaseUser.uid } });

  if (!existing) {
    throw new AppError('User not found. Please complete onboarding.', 404);
  }

  let firebasePhotoUrl = firebaseUser.picture || '';
  if (!firebasePhotoUrl) {
    try {
      const firebaseRecord = await admin.auth().getUser(firebaseUser.uid);
      firebasePhotoUrl = firebaseRecord.photoURL || '';
    } catch { /* ignore */ }
  }

  const user = await prisma.user.update({
    where: { id: existing.id },
    data: {
      name: firebaseUser.name || firebaseUser.email?.split('@')[0],
      email: firebaseUser.email,
      photoURL: firebasePhotoUrl,
      lastLoginAt: new Date()
    },
  });

  // Log activity
  await logActivity({
    userId: user.id,
    action: 'user.synced',
    resource: 'User',
    resourceId: user.id
  });

  res.status(200).json({ status: 'success', data: { user } });
});

module.exports = exports;