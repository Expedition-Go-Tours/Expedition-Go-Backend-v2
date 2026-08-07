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
      await deleteCloudinaryImage(user.photoURL, 3, { userId: req.user.id });
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

  if (req.file?.path) {
    prisma.media.updateMany({
      where: { url: req.file.path },
      data: { status: 'ATTACHED', entity: 'user', entityId: updatedUser.id },
    }).catch(() => {});
  }

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
  let user;
  try {
    user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { supplierProfile: { select: { id: true, status: true } } },
    });
    if (!user) {
      return next(new AppError('User not found', 404));
    }
    if (user.supplierProfile) {
      return next(new AppError(
        'Supplier accounts cannot be hard-deleted because it would destroy their tours, bookings, and history. Use POST /suppliers/admin/:id/archive to soft-delete the account instead.',
        409
      ));
    }
    await prisma.user.delete({ where: { id: req.params.id } });
  } catch {
    return next(new AppError('User not found', 404));
  }

  // Log activity
  await logActivity({
    userId: req.user.id,
    action: 'user.deleted_by_admin',
    resource: 'User',
    resourceId: req.params.id,
    oldValues: user ? {
      name: user.name,
      email: user.email,
      role: user.role,
      isVerified: user.isVerified,
    } : null,
  });

  res.status(204).json({ status: 'success', data: null });
});

// Wishlist tours are returned raw (not transformForListing-shaped) so the
// mini-site's listing mapper can render price, duration and location. These
// are the fields it reads; addedAt is merged per item from WishlistItem.
const WISHLIST_TOUR_SELECT = {
  id: true,
  title: true,
  slug: true,
  description: true,
  status: true,
  coverPhoto: true,
  photos: true,
  category: true,
  durationMinutes: true,
  averageRating: true,
  reviewCount: true,
  totalBookings: true,
  city: true,
  country: true,
  schedulesAndPricing: true,
  productContent: true,
  bookingAndTickets: true,
  supplier: {
    select: { id: true, name: true, photoURL: true }
  }
};

exports.getWishlist = catchAsync(async (req, res, next) => {
  const items = await prisma.wishlistItem.findMany({
    where: {
      userId: req.user.id,
      tour: { status: { not: 'DRAFT' } },
    },
    orderBy: { addedAt: 'desc' },
    include: { tour: { select: WISHLIST_TOUR_SELECT } },
  });

  const tours = items
    .filter((i) => i.tour)
    .map((i) => ({ ...i.tour, addedAt: i.addedAt }));

  res.status(200).json({
    status: 'success',
    results: tours.length,
    data: { tours }
  });
});

exports.addWishlist = catchAsync(async (req, res, next) => {
  const { tourId } = req.params;

  const tour = await prisma.tour.findFirst({
    where: { id: tourId, status: { not: 'DRAFT' } },
    select: { id: true },
  });
  if (!tour) return next(new AppError('Tour not found', 404));

  const existing = await prisma.wishlistItem.findUnique({
    where: { userId_tourId: { userId: req.user.id, tourId } },
    select: { id: true },
  });
  if (!existing) {
    await prisma.wishlistItem.create({ data: { userId: req.user.id, tourId } });

    await logActivity({
      userId: req.user.id,
      action: 'user.wishlist_added',
      resource: 'User',
      resourceId: req.user.id,
      metadata: { tourId }
    });
  }

  res.status(200).json({
    status: 'success',
    data: { isWishlisted: true }
  });
});

exports.removeWishlist = catchAsync(async (req, res, next) => {
  const { tourId } = req.params;

  const deleted = await prisma.wishlistItem.deleteMany({
    where: { userId: req.user.id, tourId },
  });
  if (deleted.count > 0) {
    await logActivity({
      userId: req.user.id,
      action: 'user.wishlist_removed',
      resource: 'User',
      resourceId: req.user.id,
      metadata: { tourId }
    });
  }

  res.status(200).json({
    status: 'success',
    data: { isWishlisted: false }
  });
});

exports.toggleWishlist = catchAsync(async (req, res, next) => {
  const { tourId } = req.params;

  const tour = await prisma.tour.findFirst({
    where: { id: tourId, status: { not: 'DRAFT' } },
    select: { id: true },
  });
  if (!tour) return next(new AppError('Tour not found', 404));

  const existing = await prisma.wishlistItem.findUnique({
    where: { userId_tourId: { userId: req.user.id, tourId } },
    select: { id: true },
  });

  if (existing) {
    await prisma.wishlistItem.delete({ where: { id: existing.id } });

    await logActivity({
      userId: req.user.id,
      action: 'user.wishlist_removed',
      resource: 'User',
      resourceId: req.user.id,
      metadata: { tourId }
    });

    return res.status(200).json({
      status: 'success',
      data: { isWishlisted: false }
    });
  }

  await prisma.wishlistItem.create({ data: { userId: req.user.id, tourId } });

  await logActivity({
    userId: req.user.id,
    action: 'user.wishlist_added',
    resource: 'User',
    resourceId: req.user.id,
    metadata: { tourId }
  });

  res.status(200).json({
    status: 'success',
    data: { isWishlisted: true }
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
