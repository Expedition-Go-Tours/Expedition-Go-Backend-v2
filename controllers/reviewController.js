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
const { deleteCloudinaryImage } = require('../utils/cloudinaryHelper');
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
    rating,
    title,
    comment,
    photos = []
  } = req.body;

  // Validate booking exists, belongs to customer, paid and completed
  const booking = await prisma.booking.findFirst({
    where: {
      id: bookingId,
      customerId,
      status: 'COMPLETED',
      paymentStatus: 'SUCCEEDED',
      selectedDate: { lte: new Date() }
    },
    include: {
      tour: {
        include: {
          supplier: true
        }
      },
      review: true
    }
  });

  if (!booking) {
    return next(new AppError('Booking not found or not eligible for review', 404));
  }

  if (booking.review) {
    return next(new AppError('Review already exists for this booking', 400));
  }

  if (!rating || rating < 1 || rating > 5) {
    return next(new AppError('Rating must be between 1 and 5', 400));
  }

  // Create review (auto-approved, verified badge set)
  const result = await prisma.$transaction(async (tx) => {
    const review = await tx.review.create({
      data: {
        bookingId,
        customerId,
        tourId: booking.tourId,
        rating,
        title,
        comment,
        photos,
        status: 'APPROVED',
        verified: true
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

    // Update tour stats (review is APPROVED, so it counts)
    await addApprovedRating(tx, booking.tourId, rating);
    // Update supplier stats
    await recalculateSupplierRating(tx, booking.tour.supplierId);

    return review;
  });

  // Send notification to supplier through the queue
  enqueueNotification({
    userId: booking.tour.supplierId,
    type: 'REVIEW_RECEIVED',
    title: 'New Review Received',
    message: `You received a ${rating}-star review for "${booking.tour.title}"`,
    data: {
      reviewId: result.id,
      tourId: booking.tourId,
      rating
    },
    sendEmail: true
  }).catch(() => {});

  // Log activity
  await logActivity({
    userId: customerId,
    action: 'review.created',
    resource: 'Review',
    resourceId: result.id,
    metadata: {
      tourId: booking.tourId,
      rating,
      bookingId
    }
  });

  event.emit({
    name: 'review.submitted',
    userId: customerId,
    req,
    resource: 'Review',
    resourceId: result.id,
    properties: { tourId: booking.tourId, rating, bookingId, supplierId: booking.tour.supplierId },
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
    photos
  } = req.body;

  const existingReview = await prisma.review.findFirst({
    where: { id, customerId },
    include: { tour: { select: { supplierId: true } } }
  });

  if (!existingReview) {
    return next(new AppError('Review not found or access denied', 404));
  }

  if (rating && (rating < 1 || rating > 5)) {
    return next(new AppError('Rating must be between 1 and 5', 400));
  }

  const updateData = {};
  if (rating !== undefined) updateData.rating = rating;
  if (title !== undefined) updateData.title = title;
  if (comment !== undefined) updateData.comment = comment;
  if (photos !== undefined) updateData.photos = photos;

  const ratingChanged = rating !== undefined && rating !== existingReview.rating;
  const contentChanged = rating !== undefined || title !== undefined || comment !== undefined;

  if (contentChanged) {
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
              name: true
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
  const supplierId = req.user.id;

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
  }).catch(() => {});

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
  const supplierId = req.user.id;

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
  const supplierId = req.user.id;

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
  const supplierId = req.user.id;
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
  const { page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [reviews, totalCount] = await Promise.all([
    prisma.review.findMany({
      where: { status: 'PENDING' },
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
            supplier: {
              select: {
                name: true
              }
            }
          }
        }
      },
      orderBy: { createdAt: 'asc' },
      skip,
      take: parseInt(limit)
    }),
    prisma.review.count({ where: { status: 'PENDING' } })
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
  }).catch(() => {});

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

module.exports = exports;