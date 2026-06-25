/**
 * Review Controller - Production Ready
 * Handles tour reviews, ratings, and supplier responses
 * 
 * Features:
 * - Customer reviews with photos
 * - Supplier responses to reviews
 * - Review moderation system
 * - Rating calculations and analytics
 * - Real-time notifications
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { enqueueNotification } = require('../utils/queue');
const { notifyAdmin } = require('../utils/adminNotificationService');
const { logActivity } = require('../utils/auditLogger');
const { deleteCloudinaryImage, isValidCloudinaryUrl } = require('../utils/cloudinaryHelper');
const { cloudinaryUrl } = require('../utils/imageOptimizer');
const { addApprovedRating, removeApprovedRating, recalculateSupplierRating } = require('../utils/ratingHelper');
const cache = require('../utils/cacheHelper');
const crypto = require('crypto');
const event = require('../utils/eventEmitter');

// ================================
// CUSTOMER REVIEW ENDPOINTS
// ================================

/**
 * Create review for completed booking
 */
exports.createReview = catchAsync(async (req, res, next) => {
  const customerId = req.user.id;
  const {
    bookingId,
    tourId: bodyTourId,
    rating,
    title,
    comment,
    valueForMoneyRating,
    guideRating,
    meetingRating,
    travelMonth,
    companions = []
  } = req.body;

  const photos = (req.files || []).map((f) => f.path || f.secure_url || f.url).filter(isValidCloudinaryUrl);

  const parsedRating = parseInt(rating);
  if (!parsedRating || parsedRating < 1 || parsedRating > 5) {
    return next(new AppError('Rating must be between 1 and 5', 400));
  }

  if (comment && comment.trim().length < 20) {
    return next(new AppError('Review comment must be at least 20 characters', 400));
  }

  let tourId;
  let supplierId;
  let tourTitle;
  let verified = false;

  if (bookingId) {
    const booking = await prisma.booking.findFirst({
      where: {
        id: bookingId,
        customerId,
        status: 'COMPLETED',
        paymentStatus: 'SUCCEEDED',
        selectedDate: { lte: new Date() }
      },
      include: {
        tour: { include: { supplier: true } },
        review: true
      }
    });

    if (!booking) {
      return next(new AppError('Booking not found or not eligible for review', 404));
    }
    if (booking.review) {
      return next(new AppError('Review already exists for this booking', 400));
    }

    tourId = booking.tourId;
    supplierId = booking.tour.supplierId;
    tourTitle = booking.tour.title;
    verified = true;
  } else {
    if (!bodyTourId) {
      return next(new AppError('Either bookingId or tourId is required', 400));
    }
    const tour = await prisma.tour.findUnique({
      where: { id: bodyTourId },
      include: { supplier: { select: { id: true } } }
    });
    if (!tour) {
      return next(new AppError('Tour not found', 404));
    }
    tourId = bodyTourId;
    supplierId = tour.supplier.id;
    tourTitle = tour.title;
  }

  const parsedCompanions = Array.isArray(companions)
    ? companions
    : typeof companions === 'string'
      ? companions.split(',').map((c) => c.trim()).filter(Boolean)
      : [];

  const result = await prisma.$transaction(async (tx) => {
    const review = await tx.review.create({
      data: {
        bookingId: bookingId || null,
        customerId,
        tourId,
        rating: parsedRating,
        title,
        comment,
        photos,
        valueForMoneyRating: valueForMoneyRating ? parseInt(valueForMoneyRating) : null,
        guideRating: guideRating ? parseInt(guideRating) : null,
        meetingRating: meetingRating ? parseInt(meetingRating) : null,
        travelMonth: travelMonth || null,
        companions: parsedCompanions,
        status: 'APPROVED',
        verified
      },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            photoURL: true
          }
        },
        tour: {
          select: {
            id: true,
            title: true
          }
        }
      }
    });

    await addApprovedRating(tx, tourId, parsedRating);
    await recalculateSupplierRating(tx, supplierId);

    return review;
  });

  enqueueNotification({
    userId: supplierId,
    type: 'REVIEW_RECEIVED',
    title: 'New Review Received',
    message: `You received a ${parsedRating}-star review for "${tourTitle}"`,
    data: {
      reviewId: result.id,
      tourId,
      rating: parsedRating
    },
    sendEmail: true
  }).catch((err) => console.error('[Notification] enqueueNotification (review) failed:', err.message));

  await logActivity({
    userId: customerId,
    action: 'review.created',
    resource: 'Review',
    resourceId: result.id,
    metadata: { tourId, rating: parsedRating, bookingId: bookingId || null }
  });

  event.emit({
    name: 'review.submitted',
    userId: customerId,
    req,
    resource: 'Review',
    resourceId: result.id,
    properties: { tourId, rating: parsedRating, bookingId: bookingId || null, supplierId },
  });

  res.status(201).json({
    status: 'success',
    data: { review: result }
  });
});

/**
 * Update customer's own review
 */
exports.updateReview = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const customerId = req.user.id;
  const {
    rating,
    title,
    comment,
    valueForMoneyRating,
    guideRating,
    meetingRating,
    travelMonth,
    companions
  } = req.body;

  const photos = (req.files || []).length > 0
    ? (req.files || []).map((f) => f.path || f.secure_url || f.url).filter(isValidCloudinaryUrl)
    : undefined;

  const existingReview = await prisma.review.findFirst({
    where: { id, customerId },
    include: { tour: { select: { supplierId: true } } }
  });

  if (!existingReview) {
    return next(new AppError('Review not found or access denied', 404));
  }

  const parsedUpdateRating = rating !== undefined ? parseInt(rating) : undefined;
  if (parsedUpdateRating !== undefined && (parsedUpdateRating < 1 || parsedUpdateRating > 5)) {
    return next(new AppError('Rating must be between 1 and 5', 400));
  }

  if (comment !== undefined && comment !== null && comment.trim().length < 20) {
    return next(new AppError('Review comment must be at least 20 characters', 400));
  }

  if (photos !== undefined) {
    const oldPhotos = existingReview.photos || [];
    const removedPhotos = oldPhotos.filter(url => !photos.includes(url));
    await Promise.all(removedPhotos.map(url => deleteCloudinaryImage(url)));
  }

  const updateData = {};
  if (parsedUpdateRating !== undefined) updateData.rating = parsedUpdateRating;
  if (title !== undefined) updateData.title = title;
  if (comment !== undefined) updateData.comment = comment;
  if (photos !== undefined) updateData.photos = photos;
  if (valueForMoneyRating !== undefined) updateData.valueForMoneyRating = valueForMoneyRating ? parseInt(valueForMoneyRating) : null;
  if (guideRating !== undefined) updateData.guideRating = guideRating ? parseInt(guideRating) : null;
  if (meetingRating !== undefined) updateData.meetingRating = meetingRating ? parseInt(meetingRating) : null;
  if (travelMonth !== undefined) updateData.travelMonth = travelMonth || null;
  if (companions !== undefined) {
    updateData.companions = Array.isArray(companions)
      ? companions
      : typeof companions === 'string'
        ? companions.split(',').map((c) => c.trim()).filter(Boolean)
        : [];
  }

  const ratingChanged = parsedUpdateRating !== undefined && parsedUpdateRating !== existingReview.rating;

  if (ratingChanged && existingReview.status === 'APPROVED') {
    updateData.status = 'PENDING';
  }

  const review = await prisma.$transaction(async (tx) => {
    const updated = await tx.review.update({
      where: { id },
      data: updateData,
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            photoURL: true
          }
        },
        tour: {
          select: {
            id: true,
            title: true
          }
        }
      }
    });

    if (existingReview.status === 'APPROVED' && ratingChanged) {
      await removeApprovedRating(tx, existingReview.tourId, existingReview.rating);
      await recalculateSupplierRating(tx, existingReview.tour.supplierId);
    }

    return updated;
  });

  if (existingReview.status === 'APPROVED' && ratingChanged) {
    cache.invalidateReviewCaches(existingReview.tourId).catch(() => {});
    cache.invalidateTourCaches(existingReview.tourId).catch(() => {});
  }

  await logActivity({
    userId: customerId,
    action: 'review.updated',
    resource: 'Review',
    resourceId: review.id,
    oldValues: existingReview,
    newValues: review
  });

  res.status(200).json({
    status: 'success',
    data: { review }
  });
});

/**
 * Delete customer's own review
 */
exports.deleteReview = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const customerId = req.user.id;

  const review = await prisma.review.findFirst({
    where: { id, customerId },
    include: { tour: { select: { supplierId: true } } }
  });

  if (!review) {
    return next(new AppError('Review not found or access denied', 404));
  }

  if (review.photos && review.photos.length > 0) {
    for (const photoUrl of review.photos) {
      await deleteCloudinaryImage(photoUrl);
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.review.delete({ where: { id } });

    if (review.status === 'APPROVED') {
      await removeApprovedRating(tx, review.tourId, review.rating);
      await recalculateSupplierRating(tx, review.tour.supplierId);
    }
  });

  cache.invalidateReviewCaches(review.tourId).catch(() => {});
  cache.invalidateTourCaches(review.tourId).catch(() => {});

  await logActivity({
    userId: customerId,
    action: 'review.deleted',
    resource: 'Review',
    resourceId: review.id,
    metadata: {
      tourId: review.tourId,
      rating: review.rating
    }
  });

  res.status(204).json({
    status: 'success',
    data: null
  });
});

// ================================
// PUBLIC REVIEW ENDPOINTS
// ================================

/**
 * Get reviews for a tour
 */
exports.getTourReviews = catchAsync(async (req, res, next) => {
  const { tourId } = req.params;
  const {
    page = 1,
    limit = 10,
    rating,
    sortBy = 'createdAt',
    sortOrder = 'desc'
  } = req.query;

  const cacheKey = 'reviews:tour:' + tourId + ':' + crypto.createHash('md5').update(JSON.stringify(req.query)).digest('hex');

  const result = await cache.getOrSet(cacheKey, async () => {
    const where = {
      tourId,
      status: 'APPROVED'
    };

    if (rating) {
      where.rating = parseInt(rating);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [reviews, totalCount, ratingDistribution] = await Promise.all([
      prisma.review.findMany({
        where,
        include: {
          customer: {
            select: {
              id: true,
              name: true,
              photoURL: true
            }
          }
        },
        orderBy: {
          [sortBy]: sortOrder
        },
        skip,
        take: parseInt(limit)
      }),
      prisma.review.count({ where }),
      prisma.review.groupBy({
        by: ['rating'],
        where: {
          tourId,
          status: 'APPROVED'
        },
        _count: true,
        orderBy: {
          rating: 'desc'
        }
      })
    ]);

    const totalPages = Math.ceil(totalCount / parseInt(limit));

    const optimizedReviews = reviews.map((review) => ({
      ...review,
      photos: Array.isArray(review.photos)
        ? review.photos.map((url) => cloudinaryUrl(url, 600))
        : review.photos,
      customer: {
        ...review.customer,
        photoURL: review.customer.photoURL
          ? cloudinaryUrl(review.customer.photoURL, 150)
          : review.customer.photoURL,
      },
    }));

    return {
      status: 'success',
      data: {
        reviews: optimizedReviews,
        pagination: {
          currentPage: parseInt(page),
          totalPages,
          totalCount,
          limit: parseInt(limit)
        },
        ratingDistribution
      }
    };
  }, 300);

  res.status(200).json(result);
});

/**
 * Get single review details
 */
exports.getReview = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const review = await prisma.review.findFirst({
    where: {
      id,
      status: 'APPROVED'
    },
    include: {
      customer: {
        select: {
          id: true,
          name: true,
          photoURL: true
        }
      },
      tour: {
        select: {
          id: true,
          title: true,
              supplier: {
                select: {
                  name: true,
                  photoURL: true
                }
              }
        }
      }
    }
  });

  if (!review) {
    return next(new AppError('Review not found', 404));
  }

  res.status(200).json({
    status: 'success',
    data: { review }
  });
});

// ================================
// SUPPLIER RESPONSE ENDPOINTS
// ================================

/**
 * Add supplier response to review
 */
exports.addSupplierResponse = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { response } = req.body;
  const supplierId = req.supplierId;

  if (!response || response.trim().length === 0) {
    return next(new AppError('Response cannot be empty', 400));
  }

  // Verify review exists and belongs to supplier's tour
  const review = await prisma.review.findFirst({
    where: {
      id,
      tour: {
        supplierId
      },
      status: 'APPROVED'
    },
    include: {
      customer: true,
      tour: true
    }
  });

  if (!review) {
    return next(new AppError('Review not found or access denied', 404));
  }

  if (review.supplierResponse) {
    return next(new AppError('Response already exists for this review', 400));
  }

  const updatedReview = await prisma.review.update({
    where: { id },
    data: {
      supplierResponse: response,
      supplierResponseAt: new Date()
    },
    include: {
      customer: {
        select: {
          id: true,
          name: true,
          photoURL: true
        }
      },
      tour: {
        select: {
          id: true,
          title: true
        }
      }
    }
  });

  // Send notification to customer through the queue
  enqueueNotification({
    userId: review.customerId,
    type: 'REVIEW_RECEIVED',
    title: 'Supplier Responded to Your Review',
    message: `The supplier responded to your review for "${review.tour.title}"`,
    data: {
      reviewId: review.id,
      tourId: review.tourId
    }
  }).catch((err) => console.error('[Notification] enqueueNotification (review response) failed:', err.message));

  // Log activity
  await logActivity({
    userId: supplierId,
    action: 'review.response_added',
    resource: 'Review',
    resourceId: review.id,
    metadata: {
      tourId: review.tourId,
      customerId: review.customerId
    }
  });

  res.status(200).json({
    status: 'success',
    data: { review: updatedReview }
  });
});

/**
 * Update supplier response
 */
exports.updateSupplierResponse = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { response } = req.body;
  const supplierId = req.supplierId;

  if (!response || response.trim().length === 0) {
    return next(new AppError('Response cannot be empty', 400));
  }

  // Verify review exists and belongs to supplier's tour
  const review = await prisma.review.findFirst({
    where: {
      id,
      tour: {
        supplierId
      },
      status: 'APPROVED'
    }
  });

  if (!review) {
    return next(new AppError('Review not found or access denied', 404));
  }

  if (!review.supplierResponse) {
    return next(new AppError('No existing response to update', 404));
  }

  const updatedReview = await prisma.review.update({
    where: { id },
    data: {
      supplierResponse: response,
      supplierResponseAt: new Date()
    },
    include: {
      customer: {
        select: {
          id: true,
          name: true,
          photoURL: true
        }
      },
      tour: {
        select: {
          id: true,
          title: true
        }
      }
    }
  });

  // Log activity
  await logActivity({
    userId: supplierId,
    action: 'review.response_updated',
    resource: 'Review',
    resourceId: review.id,
    oldValues: { supplierResponse: review.supplierResponse },
    newValues: { supplierResponse: response }
  });

  res.status(200).json({
    status: 'success',
    data: { review: updatedReview }
  });
});

/**
 * Delete supplier response
 */
exports.deleteSupplierResponse = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const supplierId = req.supplierId;

  // Verify review exists and belongs to supplier's tour
  const review = await prisma.review.findFirst({
    where: {
      id,
      tour: {
        supplierId
      }
    }
  });

  if (!review) {
    return next(new AppError('Review not found or access denied', 404));
  }

  if (!review.supplierResponse) {
    return next(new AppError('No response to delete', 404));
  }

  const updatedReview = await prisma.review.update({
    where: { id },
    data: {
      supplierResponse: null,
      supplierResponseAt: null
    }
  });

  // Log activity
  await logActivity({
    userId: supplierId,
    action: 'review.response_deleted',
    resource: 'Review',
    resourceId: review.id
  });

  res.status(200).json({
    status: 'success',
    data: { review: updatedReview }
  });
});

// ================================
// SUPPLIER REVIEW MANAGEMENT
// ================================

/**
 * Get reviews for supplier's tours
 */
exports.getSupplierReviews = catchAsync(async (req, res, next) => {
  const supplierId = req.supplierId;
  const {
    tourId,
    status = 'APPROVED',
    page = 1,
    limit = 10,
    rating
  } = req.query;

  const where = {
    tour: {
      supplierId
    }
  };

  if (status) where.status = status;
  if (tourId) where.tourId = tourId;
  if (rating) where.rating = parseInt(rating);

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [reviews, totalCount] = await Promise.all([
    prisma.review.findMany({
      where,
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            photoURL: true
          }
        },
        tour: {
          select: {
            id: true,
            title: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit)
    }),
    prisma.review.count({ where })
  ]);

  const totalPages = Math.ceil(totalCount / parseInt(limit));

  res.status(200).json({
    status: 'success',
    data: {
      reviews,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCount,
        limit: parseInt(limit)
      }
    }
  });
});

// ================================
// ADMIN MODERATION ENDPOINTS
// ================================

/**
 * Get reviews pending moderation (admin only)
 */
exports.getPendingReviews = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 20, status } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const statusFilter = status && status !== 'ALL' ? status : undefined;

  const [reviews, filteredCount, pendingCount, flaggedCount, moderatedTodayCount] = await Promise.all([
    prisma.review.findMany({
      where: { ...(statusFilter && { status: statusFilter }) },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            email: true,
            photoURL: true
          }
        },
        tour: {
          select: {
            id: true,
            title: true,
            coverPhoto: true,
            supplier: {
              select: {
                id: true,
                name: true,
                photoURL: true
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'asc' },
      skip,
      take: parseInt(limit)
    }),
    prisma.review.count({ where: { ...(statusFilter && { status: statusFilter }) } }),
    prisma.review.count({ where: { status: 'PENDING' } }),
    prisma.review.count({ where: { status: 'FLAGGED' } }),
    prisma.review.count({ where: { moderatedAt: { gte: todayStart } } }),
  ]);

  const totalPages = Math.ceil(filteredCount / parseInt(limit));

  res.status(200).json({
    status: 'success',
    data: {
      reviews,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCount: filteredCount,
        limit: parseInt(limit)
      },
      counts: {
        pending: pendingCount,
        flagged: flaggedCount,
        moderatedToday: moderatedTodayCount,
      }
    }
  });
});

/**
 * Moderate review (admin only)
 */
exports.moderateReview = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { action, reason } = req.body;
  const adminId = req.user.id;

  if (!['approve', 'reject', 'flag'].includes(action)) {
    return next(new AppError('Invalid moderation action', 400));
  }

  const review = await prisma.review.findUnique({
    where: { id },
    include: { tour: { select: { supplierId: true } } }
  });

  if (!review) {
    return next(new AppError('Review not found', 404));
  }

  const statusMap = {
    approve: 'APPROVED',
    reject: 'REJECTED',
    flag: 'FLAGGED'
  };

  const [updatedReview] = await prisma.$transaction(async (tx) => {
    const updated = await tx.review.update({
      where: { id },
      data: {
        status: statusMap[action],
        moderatedBy: adminId,
        moderatedAt: new Date(),
        flagReason: action === 'flag' ? reason : null
      }
    });

    if (action === 'approve' && review.status !== 'APPROVED') {
      await addApprovedRating(tx, review.tourId, review.rating);
      await recalculateSupplierRating(tx, review.tour.supplierId);
    } else if (action !== 'approve' && review.status === 'APPROVED') {
      await removeApprovedRating(tx, review.tourId, review.rating);
      await recalculateSupplierRating(tx, review.tour.supplierId);
    }

    return [updated];
  });

  cache.invalidateReviewCaches(review.tourId).catch(() => {});
  cache.invalidateTourCaches(review.tourId).catch(() => {});

  const notificationMessages = {
    approve: 'Your review has been approved and is now visible',
    reject: 'Your review was not approved',
    flag: 'Your review has been flagged for review'
  };

  enqueueNotification({
    userId: review.customerId,
    type: 'REVIEW_RECEIVED',
    title: 'Review Status Update',
    message: notificationMessages[action],
    data: {
      reviewId: review.id,
      action,
      reason
    }
  }).catch((err) => console.error('[Notification] enqueueNotification (review moderation) failed:', err.message));

  await notifyAdmin({
    type: 'REVIEW_NEEDS_MODERATION',
    title: `Review ${action === 'approve' ? 'Approved' : action === 'reject' ? 'Rejected' : 'Flagged'}`,
    message: `Review #${review.id.slice(0, 8)} by customer ${review.customerId.slice(0, 8)} was ${action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'flagged'}${reason ? ` — ${reason}` : ''}`,
    data: { reviewId: review.id, action, reason, customerId: review.customerId, tourId: review.tourId },
  });

  await logActivity({
    userId: adminId,
    action: `review.${action}`,
    resource: 'Review',
    resourceId: review.id,
    metadata: {
      reason,
      customerId: review.customerId,
      tourId: review.tourId
    }
  });

  event.emit({
    name: `review.${action}`,
    userId: adminId,
    req,
    resource: 'Review',
    resourceId: review.id,
    properties: { reason, customerId: review.customerId, tourId: review.tourId, rating: review.rating },
    source: 'web',
  });

  res.status(200).json({
    status: 'success',
    data: { review: updatedReview }
  });
});

// ================================
// ADMIN REVIEW MANAGEMENT
// ================================

/**
 * Admin: update any review content
 */
exports.adminUpdateReview = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const adminId = req.user.id;
  const { rating, title, comment, photos } = req.body;

  const review = await prisma.review.findUnique({
    where: { id },
    include: { tour: { select: { supplierId: true } } }
  });

  if (!review) {
    return next(new AppError('Review not found', 404));
  }

  const parsedAdminRating = rating !== undefined ? parseInt(rating) : undefined;
  if (parsedAdminRating !== undefined && (parsedAdminRating < 1 || parsedAdminRating > 5)) {
    return next(new AppError('Rating must be between 1 and 5', 400));
  }

  const updateData = {};
  if (parsedAdminRating !== undefined) updateData.rating = parsedAdminRating;
  if (title !== undefined) updateData.title = title;
  if (comment !== undefined) updateData.comment = comment;
  if (photos !== undefined) updateData.photos = Array.isArray(photos) ? photos.filter(isValidCloudinaryUrl) : [];

  const ratingChanged = parsedAdminRating !== undefined && parsedAdminRating !== review.rating;

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.review.update({
      where: { id },
      data: updateData,
      include: {
        customer: { select: { id: true, name: true, photoURL: true } },
        tour: { select: { id: true, title: true } }
      }
    });

    if (review.status === 'APPROVED' && ratingChanged) {
      await removeApprovedRating(tx, review.tourId, review.rating);
      await addApprovedRating(tx, review.tourId, parsedAdminRating);
      await recalculateSupplierRating(tx, review.tour.supplierId);
    }

    return result;
  });

  if (review.status === 'APPROVED' && ratingChanged) {
    cache.invalidateReviewCaches(review.tourId).catch(() => {});
    cache.invalidateTourCaches(review.tourId).catch(() => {});
  }

  await logActivity({
    userId: adminId,
    action: 'review.admin_updated',
    resource: 'Review',
    resourceId: review.id,
    oldValues: { rating: review.rating, title: review.title, comment: review.comment },
    newValues: updateData,
  });

  res.status(200).json({
    status: 'success',
    data: { review: updated }
  });
});

/**
 * Admin: delete any review
 */
exports.adminDeleteReview = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const adminId = req.user.id;

  const review = await prisma.review.findUnique({
    where: { id },
    include: { tour: { select: { supplierId: true } } }
  });

  if (!review) {
    return next(new AppError('Review not found', 404));
  }

  if (review.photos && review.photos.length > 0) {
    for (const photoUrl of review.photos) {
      await deleteCloudinaryImage(photoUrl);
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.review.delete({ where: { id } });

    if (review.status === 'APPROVED') {
      await removeApprovedRating(tx, review.tourId, review.rating);
      await recalculateSupplierRating(tx, review.tour.supplierId);
    }
  });

  cache.invalidateReviewCaches(review.tourId).catch(() => {});
  cache.invalidateTourCaches(review.tourId).catch(() => {});

  await logActivity({
    userId: adminId,
    action: 'review.admin_deleted',
    resource: 'Review',
    resourceId: review.id,
    metadata: {
      tourId: review.tourId,
      rating: review.rating,
      customerId: review.customerId,
    },
  });

  res.status(204).json({ status: 'success', data: null });
});

/**
 * Admin: update any supplier response
 */
exports.adminUpdateSupplierResponse = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { response } = req.body;
  const adminId = req.user.id;

  if (!response || response.trim().length === 0) {
    return next(new AppError('Response cannot be empty', 400));
  }

  const review = await prisma.review.findUnique({ where: { id } });

  if (!review) {
    return next(new AppError('Review not found', 404));
  }

  const updated = await prisma.review.update({
    where: { id },
    data: {
      supplierResponse: response,
      supplierResponseAt: new Date(),
    },
    include: {
      customer: { select: { id: true, name: true, photoURL: true } },
      tour: { select: { id: true, title: true } },
    },
  });

  await logActivity({
    userId: adminId,
    action: 'review.admin_response_updated',
    resource: 'Review',
    resourceId: review.id,
    oldValues: { supplierResponse: review.supplierResponse },
    newValues: { supplierResponse: response },
  });

  res.status(200).json({
    status: 'success',
    data: { review: updated },
  });
});

/**
 * Admin: delete any supplier response
 */
exports.adminDeleteSupplierResponse = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const adminId = req.user.id;

  const review = await prisma.review.findUnique({ where: { id } });

  if (!review) {
    return next(new AppError('Review not found', 404));
  }

  if (!review.supplierResponse) {
    return next(new AppError('No response to delete', 404));
  }

  const updated = await prisma.review.update({
    where: { id },
    data: {
      supplierResponse: null,
      supplierResponseAt: null,
    },
    include: {
      customer: { select: { id: true, name: true, photoURL: true } },
      tour: { select: { id: true, title: true } },
    },
  });

  await logActivity({
    userId: adminId,
    action: 'review.admin_response_deleted',
    resource: 'Review',
    resourceId: review.id,
  });

  res.status(200).json({
    status: 'success',
    data: { review: updated },
  });
});

module.exports = exports;