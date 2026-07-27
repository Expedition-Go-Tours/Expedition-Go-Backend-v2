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
const { deleteCloudinaryImage, isValidCloudinaryUrl } = require('../utils/cloudinaryHelper');
const { logActivity } = require('../utils/auditLogger');
const { invalidateUserCache } = require('../middleware/authMiddleware');

exports.getMe = catchAsync(async (req, res, next) => {
  if (!req.user) {
    return next(new AppError('User not found', 404));
  }

  // Optimize user photo
  const optimizedUser = {
    ...req.user,
    photoURL: req.user.photoURL
      ? req.user.photoURL
      : req.user.photoURL,
  };

  res.status(200).json({
    status: 'success',
    data: { user: optimizedUser },
  });
});

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
  if (req.body.logoUrl !== undefined) updates.logoUrl = req.body.logoUrl;

  if (req.file) {
    if (!isValidCloudinaryUrl(req.file.path)) {
      return next(new AppError('Upload failed: invalid image URL', 400));
    }

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

  invalidateUserCache(req.user.id);

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

  invalidateUserCache(req.user.id);

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

exports.getWishlist = catchAsync(async (req, res, next) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { wishlist: true }
  });
  if (!user) return next(new AppError('User not found', 404));

  const tourIds = user.wishlist;

  let tours = [];
  if (tourIds.length > 0) {
    tours = await prisma.tour.findMany({
      where: { id: { in: tourIds }, status: { not: 'DRAFT' } },
      select: {
        id: true,
        title: true,
        slug: true,
        coverPhoto: true,
        photos: true,
        city: true,
        country: true,
        averageRating: true,
        reviewCount: true,
        totalBookings: true,
        schedulesAndPricing: true,
        createdAt: true,
        supplier: {
          select: { id: true, name: true, photoURL: true }
        }
      },
    });

    const tourMap = Object.fromEntries(tours.map(t => [t.id, t]));
    tours = tourIds.map(id => tourMap[id]).filter(Boolean);
  }

  res.status(200).json({
    status: 'success',
    results: tours.length,
    data: { tours }
  });
});

exports.toggleWishlist = catchAsync(async (req, res, next) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return next(new AppError('User not found', 404));

  const tourId = req.params.tourId;

  const tour = await prisma.tour.findUnique({
    where: { id: tourId },
    select: { id: true, status: true }
  });
  if (!tour) return next(new AppError('Tour not found', 404));

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

  res.status(200).json({
    status: 'success',
    data: {
      wishlist: updatedUser.wishlist,
      isWishlisted: !isWishlisted
    }
  });
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
  // User already exists at this point (protect middleware ensures it)
  res.status(200).json({ status: 'success', data: { user: req.user } });
});

exports.syncMe = catchAsync(async (req, res) => {
  const user = await prisma.user.update({
    where: { id: req.user.id },
    data: {
      lastLoginAt: new Date(),
    },
  });

  await logActivity({
    userId: user.id,
    action: 'user.synced',
    resource: 'User',
    resourceId: user.id,
  });

  res.status(200).json({ status: 'success', data: { user } });
});

module.exports = exports;
