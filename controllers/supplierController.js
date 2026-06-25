/**
 * Supplier Controller - Production Ready
 * Handles supplier application, dashboard, earnings, and admin management
 *
 * @author Tour Platform Team
 * @version 1.0.0
 */

const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { logActivity } = require('../utils/auditLogger');
const { sendSupplierStatusEmail } = require('../utils/emailService');
const { notifyAdmin } = require('../utils/adminNotificationService');
const { enqueueNotification } = require('../utils/queue');
const { cloudinaryUrl } = require('../utils/imageOptimizer');
const { deleteCloudinaryImage, isValidCloudinaryUrl } = require('../utils/cloudinaryHelper');
const admin = require('../config/firebaseAdmin');

// ================================
// SUPPLIER APPLICATION
// ================================

/**
 * POST /suppliers/apply
 * Submit a supplier application
 */
exports.applyToBeSupplier = catchAsync(async (req, res, next) => {
  const userId = req.user.id;

  // Check if application already exists
  const existing = await prisma.supplierProfile.findUnique({ where: { userId } });
  if (existing) {
    return next(new AppError('You already have a supplier application', 400));
  }

  const {
    businessInfo,
    operatingInfo,
    representativeInfo,
    payoutInfo,
    compliance,
  } = req.body;

  if (!businessInfo || !operatingInfo || !representativeInfo || !payoutInfo) {
    return next(new AppError('businessInfo, operatingInfo, representativeInfo, and payoutInfo are required', 400));
  }

  // Parse JSON strings if sent as multipart form data
  const parse = (val) => {
    if (typeof val === 'string') {
      try { return JSON.parse(val); } catch { return val; }
    }
    return val;
  };

  // Collect uploaded document URLs
  const businessDocuments = {};
  if (req.files) {
    if (req.files.registrationDocument?.[0]) businessDocuments.registrationDocument = req.files.registrationDocument[0].path;
    if (req.files.taxDocument?.[0]) businessDocuments.taxDocument = req.files.taxDocument[0].path;
    if (req.files.proofOfAddress?.[0]) businessDocuments.proofOfAddress = req.files.proofOfAddress[0].path;
    if (req.files.idDocument?.[0]) businessDocuments.idDocument = req.files.idDocument[0].path;
    if (req.files.licenses) businessDocuments.licenses = req.files.licenses.map(f => f.path);
  }

  Object.keys(businessDocuments).forEach(key => {
    const val = businessDocuments[key];
    if (Array.isArray(val)) {
      businessDocuments[key] = val.filter(isValidCloudinaryUrl);
    } else if (val && !isValidCloudinaryUrl(val)) {
      delete businessDocuments[key];
    }
  });

  const supplierProfile = await prisma.supplierProfile.create({
    data: {
      userId,
      status: 'PENDING',
      businessInfo: parse(businessInfo),
      operatingInfo: parse(operatingInfo),
      representativeInfo: parse(representativeInfo),
      payoutInfo: parse(payoutInfo),
      businessDocuments,
      compliance: parse(compliance) || { termsAccepted: false },
    },
  });

  // Add supplier role to user
  await prisma.user.update({
    where: { id: userId },
    data: { roles: { push: 'supplier' } },
  });

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
  notifyAdmin({
    type: 'NEW_SUPPLIER_APPLICATION',
    title: 'New Supplier Application',
    message: `${user?.name || 'A user'} (${user?.email || userId}) has submitted a supplier application.`,
    data: { supplierId: supplierProfile.id, userId, applicantName: user?.name, applicantEmail: user?.email },
  }).catch((err) => console.error('[Notification] notifyAdmin (new supplier) failed:', err.message));

  await logActivity({
    userId,
    action: 'supplier.applied',
    resource: 'SupplierProfile',
    resourceId: supplierProfile.id,
  });

  res.status(201).json({
    status: 'success',
    message: 'Supplier application submitted successfully',
    data: { supplierProfile },
  });
});

/**
 * GET /suppliers/application/status
 * Get the authenticated user's application status
 */
exports.getApplicationStatus = catchAsync(async (req, res, next) => {
  const supplierProfile = await prisma.supplierProfile.findUnique({
    where: { userId: req.user.id },
  });

  if (!supplierProfile) {
    return next(new AppError('No supplier application found', 404));
  }

  res.status(200).json({
    status: 'success',
    data: { supplierProfile },
  });
});

/**
 * PATCH /suppliers/application
 * Update application (only if PENDING or UNDER_REVIEW)
 */
exports.updateApplication = catchAsync(async (req, res, next) => {
  const supplierProfile = await prisma.supplierProfile.findUnique({
    where: { userId: req.user.id },
  });

  if (!supplierProfile) {
    return next(new AppError('No supplier application found', 404));
  }

  if (!['PENDING', 'UNDER_REVIEW'].includes(supplierProfile.status)) {
    return next(new AppError(`Application cannot be modified in ${supplierProfile.status} status`, 400));
  }

  const parse = (val) => {
    if (typeof val === 'string') {
      try { return JSON.parse(val); } catch { return val; }
    }
    return val;
  };

  const updateData = {};
  if (req.body.businessInfo) updateData.businessInfo = parse(req.body.businessInfo);
  if (req.body.operatingInfo) updateData.operatingInfo = parse(req.body.operatingInfo);
  if (req.body.representativeInfo) updateData.representativeInfo = parse(req.body.representativeInfo);
  if (req.body.payoutInfo) updateData.payoutInfo = parse(req.body.payoutInfo);

  if (req.files) {
    const oldDocs = supplierProfile.businessDocuments || {};
    const newDocs = {};
    if (req.files.registrationDocument?.[0]) newDocs.registrationDocument = req.files.registrationDocument[0].path;
    if (req.files.taxDocument?.[0]) newDocs.taxDocument = req.files.taxDocument[0].path;
    if (req.files.proofOfAddress?.[0]) newDocs.proofOfAddress = req.files.proofOfAddress[0].path;
    if (req.files.idDocument?.[0]) newDocs.idDocument = req.files.idDocument[0].path;
    if (req.files.licenses) newDocs.licenses = req.files.licenses.map(f => f.path);

    Object.keys(newDocs).forEach(key => {
      if (oldDocs[key] && oldDocs[key] !== newDocs[key]) {
        const oldVal = oldDocs[key];
        if (Array.isArray(oldVal)) {
          oldVal.forEach(url => deleteCloudinaryImage(url).catch(() => {}));
        } else {
          deleteCloudinaryImage(oldVal).catch(() => {});
        }
      }
    });

    updateData.businessDocuments = { ...oldDocs, ...newDocs };
  }

  const updated = await prisma.supplierProfile.update({
    where: { userId: req.user.id },
    data: updateData,
  });

  res.status(200).json({
    status: 'success',
    data: { supplierProfile: updated },
  });
});

// ================================
// SUPPLIER DASHBOARD
// ================================

/**
 * GET /suppliers/dashboard
 * Supplier dashboard summary
 */
exports.getDashboard = catchAsync(async (req, res, next) => {
  const supplierId = req.supplierId;

  const supplierProfile = await prisma.supplierProfile.findUnique({
    where: { userId: supplierId },
  });

  if (!supplierProfile) {
    return next(new AppError('Supplier profile not found', 404));
  }

  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const [tourStats, bookingStats, recentReviews, reviewCount] = await Promise.all([
    // Tour counts by status
    prisma.tour.groupBy({
      by: ['status'],
      where: { supplierId },
      _count: true,
    }),

    // Booking counts by status (last 90 days)
    prisma.booking.groupBy({
      by: ['status'],
      where: { tour: { supplierId }, createdAt: { gte: ninetyDaysAgo } },
      _count: true,
    }),

    // Recent reviews
    prisma.review.findMany({
      where: { tour: { supplierId }, status: 'APPROVED' },
      include: {
        customer: { select: { id: true, name: true, photoURL: true } },
        tour: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),

    // Total review count
    prisma.review.count({
      where: { tour: { supplierId }, status: 'APPROVED' },
    }),
  ]);

  const tourMap = Object.fromEntries(tourStats.map(t => [t.status, t._count]));
  const bookingMap = Object.fromEntries(bookingStats.map(b => [b.status, b._count]));

  res.status(200).json({
    status: 'success',
    data: {
      earnings: {
        totalEarnings: Number(supplierProfile.totalEarnings),
        currency: 'USD',
      },
      tours: {
        total: Object.values(tourMap).reduce((a, b) => a + b, 0),
        active: tourMap.ACTIVE || 0,
        draft: tourMap.DRAFT || 0,
        paused: tourMap.PAUSED || 0,
        archived: tourMap.ARCHIVED || 0,
      },
      bookings: {
        total: Object.values(bookingMap).reduce((a, b) => a + b, 0),
        pending: bookingMap.PENDING || 0,
        confirmed: bookingMap.CONFIRMED || 0,
        completed: bookingMap.COMPLETED || 0,
        cancelled: bookingMap.CANCELLED || 0,
      },
      reviews: {
        averageRating: Number(supplierProfile.averageRating) || 0,
        totalReviews: reviewCount,
        recentReviews,
      },
    },
  });
});

/**
 * GET /suppliers/earnings
 * Supplier earnings summary
 */
exports.getEarnings = catchAsync(async (req, res) => {
  const supplierId = req.supplierId;
  const { page = 1, limit = 20, startDate, endDate } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const where = { tour: { supplierId } };
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  const [bookings, totalCount, profile, aggregates] = await Promise.all([
    prisma.booking.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit),
      include: {
        tour: { select: { id: true, title: true } },
        customer: { select: { id: true, name: true, email: true } },
        payouts: { select: { id: true, status: true, paidAt: true } },
      },
    }),
    prisma.booking.count({ where }),
    prisma.supplierProfile.findUnique({ where: { userId: supplierId } }),
    prisma.booking.aggregate({
      where,
      _sum: { total: true, commissionAmount: true, supplierPayout: true },
    }),
  ]);

  const totalPages = Math.ceil(totalCount / parseInt(limit));

  res.status(200).json({
    status: 'success',
    data: {
      summary: {
        totalEarnings: Number(profile?.totalEarnings || 0),
        totalRevenue: Number(aggregates._sum.total || 0),
        totalCommission: Number(aggregates._sum.commissionAmount || 0),
        totalBookings: totalCount,
        currency: 'USD',
      },
      earnings: bookings.map((b) => ({
        id: b.id,
        bookingNumber: b.bookingNumber,
        selectedDate: b.selectedDate,
        paidAt: b.paidAt,
        total: Number(b.total),
        supplierPayout: Number(b.supplierPayout),
        commissionAmount: Number(b.commissionAmount),
        commissionRate: Number(b.commissionRate),
        currency: b.currency,
        tour: b.tour,
        customer: b.customer,
      })),
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCount,
        limit: parseInt(limit),
      },
    },
  });
});

/**
 * GET /suppliers/payouts
 * Supplier payout history
 */
exports.getPayouts = catchAsync(async (req, res) => {
  const userId = req.supplierId;
  const { page = 1, limit = 20, status } = req.query;

  const where = { supplierId: userId };
  if (status) where.status = status;

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [payouts, totalCount] = await Promise.all([
    prisma.payout.findMany({
      where,
      include: {
        booking: {
          select: { tour: { select: { title: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit),
    }),
    prisma.payout.count({ where }),
  ]);

  const totalPages = Math.ceil(totalCount / parseInt(limit));

  res.status(200).json({
    status: 'success',
    data: {
      payouts,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCount,
        limit: parseInt(limit),
      },
    },
  });
});

// ================================
// ADMIN SUPPLIER MANAGEMENT
// ================================

/**
 * GET /suppliers/admin/applications
 * List all supplier applications (admin)
 */
exports.getAllApplications = catchAsync(async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const where = {};
  if (status) where.status = status;

  const [applications, totalCount] = await Promise.all([
    prisma.supplierProfile.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, email: true, photoURL: true, firebaseUid: true, createdAt: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit),
    }),
    prisma.supplierProfile.count({ where }),
  ]);

  const totalPages = Math.ceil(totalCount / parseInt(limit));

  const transformed = await Promise.all(applications.map(async (app) => {
    let photoURL = app.user?.photoURL || '';
    if (!photoURL && app.user?.firebaseUid) {
      try {
        const firebaseRecord = await admin.auth().getUser(app.user.firebaseUid);
        photoURL = firebaseRecord.photoURL || '';
      } catch { /* ignore */ }
    }
    return {
      ...app,
      user: app.user
        ? { ...app.user, photoURL: photoURL ? cloudinaryUrl(photoURL, 150) : photoURL }
        : app.user,
    };
  }));

  res.status(200).json({
    status: 'success',
    data: {
      applications: transformed,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCount,
        hasNextPage: parseInt(page) < totalPages,
        limit: parseInt(limit),
      },
    },
  });
});

/**
 * PATCH /suppliers/admin/applications/:id/review
 * Review a supplier application (admin)
 */
exports.reviewApplication = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { action, notes } = req.body;

  if (!['approve', 'reject', 'request_info'].includes(action)) {
    return next(new AppError('action must be approve, reject, or request_info', 400));
  }

  if (['reject', 'request_info'].includes(action) && !notes) {
    return next(new AppError('notes are required for reject and request_info actions', 400));
  }

  const supplierProfile = await prisma.supplierProfile.findUnique({
    where: { id },
    include: { user: { select: { id: true, name: true, email: true } } },
  });

  if (!supplierProfile) {
    return next(new AppError('Supplier application not found', 404));
  }

  const statusMap = {
    approve: 'APPROVED',
    reject: 'REJECTED',
    request_info: 'UNDER_REVIEW',
  };

  const updated = await prisma.supplierProfile.update({
    where: { id },
    data: {
      status: statusMap[action],
      adminNotes: notes,
      reviewedBy: req.user.id,
      reviewedAt: new Date(),
    },
  });

  // Send email notification
  try {
    await sendSupplierStatusEmail(supplierProfile.user.email, statusMap[action], {
      name: supplierProfile.user.name,
      notes,
    });
  } catch (err) {
    console.error('Supplier status email failed:', err.message);
  }

  await logActivity({
    userId: req.user.id,
    action: `supplier.${action}`,
    resource: 'SupplierProfile',
    resourceId: id,
    metadata: { action, notes },
  });

  res.status(200).json({
    status: 'success',
    message: `Application ${action.replace('_', ' ')}d successfully`,
    data: { supplierProfile: updated },
  });
});

/**
 * PATCH /suppliers/admin/:id/suspend
 * Suspend or reactivate a supplier (admin)
 */
exports.suspendSupplier = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { suspend, reason } = req.body;

  if (suspend === true && !reason) {
    return next(new AppError('reason is required when suspending a supplier', 400));
  }

  const supplierProfile = await prisma.supplierProfile.findUnique({ where: { id } });
  if (!supplierProfile) {
    return next(new AppError('Supplier not found', 404));
  }

  const updated = await prisma.supplierProfile.update({
    where: { id },
    data: {
      status: suspend ? 'SUSPENDED' : 'ACTIVE',
      adminNotes: reason || supplierProfile.adminNotes,
    },
  });

  await logActivity({
    userId: req.user.id,
    action: suspend ? 'supplier.suspended' : 'supplier.reactivated',
    resource: 'SupplierProfile',
    resourceId: id,
    metadata: { reason },
  });

  res.status(200).json({
    status: 'success',
    message: suspend ? 'Supplier suspended successfully' : 'Supplier reactivated successfully',
    data: { supplierProfile: updated },
  });
});

/**
 * PATCH /suppliers/admin/:id/activate
 * Activate a supplier (admin)
 */
exports.activateSupplier = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const supplierProfile = await prisma.supplierProfile.findUnique({
    where: { id },
    include: { user: { select: { id: true, name: true, email: true } } },
  });

  if (!supplierProfile) {
    return next(new AppError('Supplier not found', 404));
  }

  if (supplierProfile.status !== 'APPROVED') {
    return next(new AppError(`Supplier must be in APPROVED status to activate. Current: ${supplierProfile.status}`, 400));
  }

  const updated = await prisma.supplierProfile.update({
    where: { id },
    data: { status: 'ACTIVE' },
  });

  // Send welcome email
  try {
    await sendSupplierStatusEmail(supplierProfile.user.email, 'ACTIVE', {
      name: supplierProfile.user.name,
    });
  } catch (err) {
    console.error('Supplier activation email failed:', err.message);
  }

  // Notify supplier
  enqueueNotification({
    userId: supplierProfile.user.id,
    type: 'SUPPLIER_APPROVED',
    title: 'Account Activated',
    message: 'Your supplier account has been activated. You can now start receiving bookings and managing your tours.',
    data: { supplierId: id, status: 'ACTIVE' },
  }).catch((err) => console.error('[Notification] enqueueNotification (activate) failed:', err.message));

  // Notify admins
  notifyAdmin({
    type: 'SUPPLIER_STATUS_CHANGE',
    title: 'Supplier Activated',
    message: `${supplierProfile.user.name} has been activated as a supplier.`,
    data: { supplierId: id, supplierName: supplierProfile.user.name },
  }).catch((err) => console.error('[Notification] notifyAdmin (activate) failed:', err.message));

  await logActivity({
    userId: req.user.id,
    action: 'supplier.activated',
    resource: 'SupplierProfile',
    resourceId: id,
  });

  res.status(200).json({
    status: 'success',
    data: { supplierProfile: updated },
  });
});

exports.getSupplierOverview = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const supplierProfile = await prisma.supplierProfile.findUnique({
    where: { id },
    select: { id: true, userId: true, totalEarnings: true, totalBookings: true, averageRating: true },
  });

  if (!supplierProfile) {
    return next(new AppError('Supplier not found', 404));
  }

  const { userId } = supplierProfile;

  const [tourStats, bookingStats, reviewStats, bookingCount, commissionSum, toursWithBooking] = await Promise.all([
    prisma.tour.groupBy({
      by: ['status'],
      where: { supplierId: userId },
      _count: true,
    }),
    prisma.booking.groupBy({
      by: ['status'],
      where: { tour: { supplierId: userId } },
      _count: true,
    }),
    prisma.review.aggregate({
      where: { tour: { supplierId: userId } },
      _avg: { rating: true },
      _count: true,
    }),
    prisma.booking.count({ where: { tour: { supplierId: userId } } }),
    prisma.booking.aggregate({
      where: { tour: { supplierId: userId } },
      _sum: { commissionAmount: true },
    }),
    prisma.tour.findMany({
      where: { supplierId: userId },
      select: {
        id: true,
        title: true,
        _count: { select: { bookings: true } },
        bookings: {
          select: { commissionAmount: true, total: true, status: true },
          where: { status: { not: 'CANCELLED' } },
        },
      },
    }),
  ]);

  const tourMap = Object.fromEntries(tourStats.map(t => [t.status, t._count]));
  const bookingMap = Object.fromEntries(bookingStats.map(b => [b.status, b._count]));

  const tourCommissions = toursWithBooking.map((t) => {
    const totalCommission = t.bookings.reduce((sum, b) => sum + Number(b.commissionAmount), 0);
    const totalRevenue = t.bookings.reduce((sum, b) => sum + Number(b.total), 0);
    return {
      id: t.id,
      title: t.title,
      bookings: t._count.bookings,
      commission: totalCommission,
      revenue: totalRevenue,
    };
  });

  res.status(200).json({
    status: 'success',
    data: {
      earnings: Number(supplierProfile.totalEarnings),
      totalBookings: bookingCount,
      totalCommission: Number(commissionSum._sum.commissionAmount) || 0,
      averageRating: Number(supplierProfile.averageRating) || Number(reviewStats._avg.rating) || 0,
      totalReviews: reviewStats._count,
      tours: {
        total: Object.values(tourMap).reduce((a, b) => a + b, 0),
        active: tourMap.ACTIVE || 0,
        draft: tourMap.DRAFT || 0,
        paused: tourMap.PAUSED || 0,
        archived: tourMap.ARCHIVED || 0,
      },
      bookings: {
        total: Object.values(bookingMap).reduce((a, b) => a + b, 0),
        pending: bookingMap.PENDING || 0,
        confirmed: bookingMap.CONFIRMED || 0,
        completed: bookingMap.COMPLETED || 0,
        cancelled: bookingMap.CANCELLED || 0,
      },
      tourCommissions,
    },
  });
});

exports.getSupplierTours = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { page = 1, limit = 20, status } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const supplierProfile = await prisma.supplierProfile.findUnique({
    where: { id },
    select: { userId: true },
  });

  if (!supplierProfile) {
    return next(new AppError('Supplier not found', 404));
  }

  const where = { supplierId: supplierProfile.userId };
  if (status) where.status = status;

  const [tours, totalCount] = await Promise.all([
    prisma.tour.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit),
      select: {
        id: true,
        title: true,
        coverPhoto: true,
        slug: true,
        status: true,
        _count: { select: { bookings: true, reviews: true } },
        averageRating: true,
        city: true,
        country: true,
        createdAt: true,
      },
    }),
    prisma.tour.count({ where }),
  ]);

  const totalPages = Math.ceil(totalCount / parseInt(limit));

  const mapped = tours.map(({ _count, ...rest }) => ({
    ...rest,
    totalBookings: _count.bookings,
    reviewCount: _count.reviews,
  }));

  res.status(200).json({
    status: 'success',
    data: {
      tours: mapped,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCount,
        hasNextPage: parseInt(page) < totalPages,
        limit: parseInt(limit),
      },
    },
  });
});

exports.uploadLogo = catchAsync(async (req, res, next) => {
  if (!req.file) {
    return next(new AppError('No file uploaded', 400));
  }

  if (!isValidCloudinaryUrl(req.file.path)) {
    return next(new AppError('Upload failed: invalid image URL', 400));
  }

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (user?.logoUrl) {
    await deleteCloudinaryImage(user.logoUrl);
  }

  const updatedUser = await prisma.user.update({
    where: { id: req.user.id },
    data: { logoUrl: req.file.path },
  });

  res.status(200).json({
    status: 'success',
    data: { logoUrl: updatedUser.logoUrl },
  });
});
