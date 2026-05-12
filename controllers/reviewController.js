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
const { sendNotification } = require('../utils/notificationService');
const { logActivity } = require('../utils/auditLogger');
const { deleteCloudinaryImage } = require('../utils/cloudinaryHelper');

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

  // Validate booking exists and belongs to customer
  const booking = await prisma.booking.findFirst({
    where: {
      id: bookingId,
      customerId,
      status: 'COMPLETED'
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

  // Validate rating
  if (!rating || rating < 1 || rating > 5) {
    return next(new AppError('Rating must be between 1 and 5', 400));
  }

  // Create review in transaction
  const result = await prisma.$transaction(async (tx) => {
    // Create the review
    const review = await tx.review.create({
      data: {
        bookingId,
        customerId,
        tourId: booking.tourId,
        rating,
        title,
        comment,
        photos,
        status: 'PENDING' // Reviews need moderation
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

    // Update tour statistics
    const tourStats = await tx.review.aggregate({
      where: {
        tourId: booking.tourId,
        status: 'APPROVED'
      },
      _avg: {
        rating: true
      },
      _count: true
    });

    await tx.tour.update({
      where: { id: booking.tourId },
      data: {
        averageRating: tourStats._avg.rating,
        reviewCount: tourStats._count
      }
    });

    // Update supplier statistics
    const supplierStats = await tx.review.aggregate({
      where: {
        tour: {
          supplierId: booking.tour.supplierId
        },
        status: 'APPROVED'
      },
      _avg: {
        rating: true
      }
    });

    await tx.supplierProfile.update({
      where: { userId: booking.tour.supplierId },
      data: {
        averageRating: supplierStats._avg.rating
      }
    });

    return review;
  });

  // Send notification to supplier
  sendNotification({
    userId: booking.tour.supplierId,
    type: 'REVIEW_RECEIVED',
    title: 'New Review Received',
    message: `You received a ${rating}-star review for "${booking.tour.title}"`,
    data: {
      reviewId: result.id,
      tourId: booking.tourId,
      rating
    }
  }).catch(console.error);

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

  // Find review and verify ownership
  const existingReview = await prisma.review.findFirst({
    where: {
      id,
      customerId
    }
  });

  if (!existingReview) {
    return next(new AppError('Review not found or access denied', 404));
  }

  // Validate rating if provided
  if (rating && (rating < 1 || rating > 5)) {
    return next(new AppError('Rating must be between 1 and 5', 400));
  }

  const updateData = {};
  if (rating !== undefined) updateData.rating = rating;
  if (title !== undefined) updateData.title = title;
  if (comment !== undefined) updateData.comment = comment;
  if (photos !== undefined) updateData.photos = photos;

  // Reset status to pending if content changed
  if (rating !== undefined || title !== undefined || comment !== undefined) {
    updateData.status = 'PENDING';
  }

  const review = await prisma.review.update({
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

  // Log activity
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
    where: {
      id,
      customerId
    },
    include: {
      tour: true
    }
  });

  if (!review) {
    return next(new AppError('Review not found or access denied', 404));
  }

  // Delete review photos from Cloudinary
  if (review.photos && review.photos.length > 0) {
    for (const photoUrl of review.photos) {
      await deleteCloudinaryImage(photoUrl);
    }
  }

  // Delete review and update statistics
  await prisma.$transaction(async (tx) => {
    await tx.review.delete({
      where: { id }
    });

    // Recalculate tour statistics
    const tourStats = await tx.review.aggregate({
      where: {
        tourId: review.tourId,
        status: 'APPROVED'
      },
      _avg: {
        rating: true
      },
      _count: true
    });

    await tx.tour.update({
      where: { id: review.tourId },
      data: {
        averageRating: tourStats._avg.rating,
        reviewCount: tourStats._count
      }
    });

    // Recalculate supplier statistics
    const supplierStats = await tx.review.aggregate({
      where: {
        tour: {
          supplierId: review.tour.supplierId
        },
        status: 'APPROVED'
      },
      _avg: {
        rating: true
      }
    });

    await tx.supplierProfile.update({
      where: { userId: review.tour.supplierId },
      data: {
        averageRating: supplierStats._avg.rating
      }
    });
  });

  // Log activity
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

  const where = {
    tourId,
    status: 'APPROVED'
  };

  // Filter by rating if specified
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
    // Get rating distribution
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

  res.status(200).json({
    status: 'success',
    data: {
      reviews,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCount,
        limit: parseInt(limit)
      },
      ratingDistribution
    }
  });
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

  // Send notification to customer
  sendNotification({
    userId: review.customerId,
    type: 'REVIEW_RECEIVED',
    title: 'Supplier Responded to Your Review',
    message: `The supplier responded to your review for "${review.tour.title}"`,
    data: {
      reviewId: review.id,
      tourId: review.tourId
    }
  }).catch(console.error);

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
  const { action, reason } = req.body; // action: 'approve', 'reject', 'flag'
  const adminId = req.user.id;

  if (!['approve', 'reject', 'flag'].includes(action)) {
    return next(new AppError('Invalid moderation action', 400));
  }

  const review = await prisma.review.findUnique({
    where: { id },
    include: {
      customer: true,
      tour: true
    }
  });

  if (!review) {
    return next(new AppError('Review not found', 404));
  }

  const statusMap = {
    approve: 'APPROVED',
    reject: 'REJECTED',
    flag: 'FLAGGED'
  };

  const updatedReview = await prisma.review.update({
    where: { id },
    data: {
      status: statusMap[action],
      moderatedBy: adminId,
      moderatedAt: new Date(),
      flagReason: action === 'flag' ? reason : null
    }
  });

  // Update tour statistics if approved
  if (action === 'approve') {
    const tourStats = await prisma.review.aggregate({
      where: {
        tourId: review.tourId,
        status: 'APPROVED'
      },
      _avg: {
        rating: true
      },
      _count: true
    });

    await prisma.tour.update({
      where: { id: review.tourId },
      data: {
        averageRating: tourStats._avg.rating,
        reviewCount: tourStats._count
      }
    });
  }

  // Send notification to customer
  const notificationMessages = {
    approve: 'Your review has been approved and is now visible',
    reject: 'Your review was not approved',
    flag: 'Your review has been flagged for review'
  };

  sendNotification({
    userId: review.customerId,
    type: 'REVIEW_RECEIVED',
    title: 'Review Status Update',
    message: notificationMessages[action],
    data: {
      reviewId: review.id,
      action,
      reason
    }
  }).catch(console.error);

  // Log activity
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

  res.status(200).json({
    status: 'success',
    data: { review: updatedReview }
  });
});

module.exports = exports;