/**
 * Supplier Controller - Production Ready
 * Handles supplier application, dashboard, earnings, and admin management
 *
 * @author Tour Platform Team
 * @version 1.0.0
 */

const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const cache = require('../utils/cacheHelper');
const AppError = require('../utils/appError');
const { logActivity } = require('../utils/auditLogger');
const { sendSupplierStatusEmail } = require('../utils/emailService');
const { notifyAdmin } = require('../utils/adminNotificationService');
const { enqueueNotification } = require('../utils/queue');
const { deleteCloudinaryImage, isValidCloudinaryUrl } = require('../utils/cloudinaryHelper');
const {
  parseDocuments,
  parseVehiclePhotos,
  parseVehicles,
  parseGuides,
  upsertVerificationRecords,
} = require('../utils/supplierVerification');
const admin = require('../config/firebaseAdmin');
const logger = require('../utils/logger');

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

  const supplierType = req.body.supplierType
    ? String(req.body.supplierType).toUpperCase()
    : 'TOUR_COMPANY';

  const documents = parseDocuments(req);
  const vehiclePhotos = parseVehiclePhotos(req);
  const vehicles = parseVehicles(req.body);
  const guides = parseGuides(req.body);

  const supplierProfile = await prisma.$transaction(async (tx) => {
    const profile = await tx.supplierProfile.create({
      data: {
        userId,
        status: 'PENDING',
        supplierType,
        businessInfo: parse(businessInfo),
        operatingInfo: parse(operatingInfo),
        representativeInfo: parse(representativeInfo),
        payoutInfo: parse(payoutInfo),
        businessDocuments,
        compliance: parse(compliance) || { termsAccepted: false },
      },
    });

    await upsertVerificationRecords(tx, {
      profileId: profile.id,
      documents,
      vehicles,
      guides,
      vehiclePhotos,
      action: 'APPLICATION_SUBMITTED',
    });

    return profile;
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
    include: {
      documents: { orderBy: { createdAt: 'asc' } },
      vehicles: { orderBy: { createdAt: 'asc' } },
      guides: { orderBy: { createdAt: 'asc' } },
    },
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
          oldVal.forEach(url => deleteCloudinaryImage(url, 3, { userId: req.user.id }).catch((err) => logger.warn('[supplier] deleteCloudinaryImage failed:', err?.message)));
        } else {
          deleteCloudinaryImage(oldVal, 3, { userId: req.user.id }).catch((err) => logger.warn('[supplier] deleteCloudinaryImage failed:', err?.message));
        }
      }
    });

    updateData.businessDocuments = { ...oldDocs, ...newDocs };
  }

  if (req.body.supplierType) {
    updateData.supplierType = String(req.body.supplierType).toUpperCase();
  }

  const documents = parseDocuments(req);
  const vehiclePhotos = parseVehiclePhotos(req);
  const vehicles = parseVehicles(req.body);
  const guides = parseGuides(req.body);

  let updated;
  await prisma.$transaction(async (tx) => {
    updated = await tx.supplierProfile.update({
      where: { userId: req.user.id },
      data: updateData,
    });

    await upsertVerificationRecords(tx, {
      profileId: updated.id,
      documents,
      vehicles,
      guides,
      vehiclePhotos,
      action: 'APPLICATION_UPDATED',
    });
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
  const cacheKey = `supplier:dashboard:${supplierId}`;
  const bucket = Math.floor(Date.now() / 60000); // 1-minute buckets

  const result = await cache.getOrSet(`${cacheKey}:${bucket}`, async () => {
    const supplierProfile = await prisma.supplierProfile.findUnique({
      where: { userId: supplierId },
    });

    if (!supplierProfile) {
      return null;
    }

    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const [tourStats, bookingStats, recentReviews, reviewCount] = await Promise.all([
      prisma.tour.groupBy({
        by: ['status'],
        where: { supplierId },
        _count: true,
      }),
      prisma.booking.groupBy({
        by: ['status'],
        where: { tour: { supplierId }, createdAt: { gte: ninetyDaysAgo } },
        _count: true,
      }),
      prisma.review.findMany({
        where: { tour: { supplierId }, status: 'APPROVED' },
        include: {
          customer: { select: { id: true, name: true, photoURL: true } },
          tour: { select: { id: true, title: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      prisma.review.count({
        where: { tour: { supplierId }, status: 'APPROVED' },
      }),
    ]);

    const tourMap = Object.fromEntries(tourStats.map(t => [t.status, t._count]));
    const bookingMap = Object.fromEntries(bookingStats.map(b => [b.status, b._count]));

    return {
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
    };
  }, 60); // Cache for 1 minute

  if (!result) {
    return next(new AppError('Supplier profile not found', 404));
  }

  res.status(200).json(result);
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
      _sum: { grossAmount: true, platformCommission: true, supplierPayout: true },
    }),
  ]);

  const totalPages = Math.ceil(totalCount / parseInt(limit));

  res.status(200).json({
    status: 'success',
    data: {
      summary: {
        totalEarnings: Number(profile?.totalEarnings || 0),
        totalRevenue: Number(aggregates._sum.grossAmount || 0),
        totalCommission: Number(aggregates._sum.platformCommission || 0),
        totalBookings: totalCount,
        currency: 'USD',
      },
      earnings: bookings.map((b) => ({
        id: b.id,
        bookingNumber: b.bookingNumber,
        travelDate: b.travelDate,
        paidAt: b.paidAt,
        grossAmount: Number(b.grossAmount),
        supplierPayout: Number(b.supplierPayout),
        platformCommission: Number(b.platformCommission),
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
 * GET /suppliers/monthly-revenue
 * Returns monthly revenue breakdown for charts (gross amount per month).
 */
exports.getMonthlyRevenue = catchAsync(async (req, res) => {
  const supplierId = req.supplierId;
  const months = Math.min(24, Math.max(1, parseInt(req.query.months, 10) || 12));

  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months + 1, 1);
  startDate.setHours(0, 0, 0, 0);

  const bookings = await prisma.booking.findMany({
    where: {
      tour: { supplierId },
      createdAt: { gte: startDate },
      paymentStatus: 'SUCCEEDED',
    },
    select: { grossAmount: true, createdAt: true },
  });

  const grouped = {};
  for (const b of bookings) {
    const d = b.createdAt;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!grouped[key]) grouped[key] = { grossAmount: 0, bookingCount: 0 };
    grouped[key].grossAmount += Number(b.grossAmount);
    grouped[key].bookingCount += 1;
  }

  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const result = [];
  const cursor = new Date(startDate);
  const now = new Date();
  while (cursor <= now) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
    result.push({
      month: key,
      label: MONTH_NAMES[cursor.getMonth()],
      year: cursor.getFullYear(),
      grossAmount: Math.round((grouped[key]?.grossAmount || 0) * 100) / 100,
      bookingCount: grouped[key]?.bookingCount || 0,
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  res.json({ status: 'success', data: { months: result } });
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
        ? { ...app.user, photoURL: photoURL ? photoURL : photoURL }
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

  // Ghana-based suppliers get their tours auto-published immediately
  // (the periodic reconcile sweep covers it within 30 min regardless).
  if (action === 'approve' && supplierProfile.businessInfo?.country === 'Ghana') {
    try {
      const { enqueueGhanaPublish } = require('../utils/queue');
      const tours = await prisma.tour.findMany({
        where: { supplierId: supplierProfile.userId, status: 'ACTIVE' },
        select: { id: true },
      });
      for (const t of tours) {
        enqueueGhanaPublish(t.id, req.user.id).catch((err) => console.warn('[Ghana] enqueueGhanaPublish failed:', err.message));
      }
    } catch (err) {
      console.warn('[Ghana] supplier-approval publish enqueue failed:', err.message);
    }
  }

  // Non-Ghana African suppliers get their tours auto-published to TravioAfrica
  if (action === 'approve' && supplierProfile.businessInfo?.country && supplierProfile.businessInfo.country !== 'Ghana') {
    try {
      const { enqueueTravioAfricaPublish } = require('../utils/queue');
      const tours = await prisma.tour.findMany({
        where: { supplierId: supplierProfile.userId, status: 'ACTIVE' },
        select: { id: true },
      });
      for (const t of tours) {
        enqueueTravioAfricaPublish(t.id, req.user.id).catch((err) => console.warn('[Africa] enqueueTravioAfricaPublish failed:', err.message));
      }
    } catch (err) {
      console.warn('[Africa] supplier-approval publish enqueue failed:', err.message);
    }
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

  // Invalidate public tour/expedition caches so this supplier's tours
  // disappear from (or reappear in) listings immediately on status change.
  try {
    const supplierTours = await prisma.tour.findMany({
      where: { supplierId: supplierProfile.userId },
      select: { id: true, slug: true },
    });
    await Promise.all(supplierTours.map((t) => cache.invalidateTourCaches(t.id, t.slug)));
    await cache.invalidateKeys(['expedition:sitemap']);
  } catch (err) {
    logger.error('Failed to invalidate tour caches on supplier status change:', err);
  }

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

/**
 * POST /suppliers/admin/:id/archive
 * Soft-delete / archive a supplier (admin).
 *
 * Unlike hard deletion (which cascades and destroys tours, bookings, and
 * related records), archiving:
 *   - marks every tour as ARCHIVED (hidden from all public listings)
 *   - suspends the supplier profile (blocks new bookings)
 *   - deactivates the user account (blocks login)
 *   - preserves all bookings, payouts, reviews, and related records
 *
 * A snapshot of the affected tour IDs is stored on the profile so
 * POST /suppliers/admin/:id/restore can reactivate exactly those tours.
 */
exports.archiveSupplier = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const supplierProfile = await prisma.supplierProfile.findUnique({
    where: { id },
    include: { user: { select: { id: true, name: true, email: true, active: true } } },
  });

  if (!supplierProfile) {
    return next(new AppError('Supplier not found', 404));
  }

  if (supplierProfile.status === 'SUSPENDED' && !supplierProfile.user.active) {
    return next(new AppError('Supplier is already archived', 409));
  }

  const toursToArchive = await prisma.tour.findMany({
    where: { supplierId: supplierProfile.userId, status: { not: 'ARCHIVED' } },
    select: { id: true },
  });
  const tourIds = toursToArchive.map((t) => t.id);

  const archivedTours = await prisma.tour.updateMany({
    where: { supplierId: supplierProfile.userId, status: { not: 'ARCHIVED' } },
    data: { status: 'ARCHIVED' },
  });

  await prisma.supplierProfile.update({
    where: { id },
    data: {
      status: 'SUSPENDED',
      archiveSnapshot: tourIds.length > 0
        ? { archivedAt: new Date().toISOString(), tourIds }
        : null,
    },
  });

  await prisma.user.update({
    where: { id: supplierProfile.userId },
    data: { active: false },
  });

  // Invalidate public tour/expedition caches so archived tours disappear immediately.
  try {
    const supplierTours = await prisma.tour.findMany({
      where: { supplierId: supplierProfile.userId },
      select: { id: true, slug: true },
    });
    await Promise.all(supplierTours.map((t) => cache.invalidateTourCaches(t.id, t.slug)));
    await cache.invalidateKeys(['expedition:sitemap']);
  } catch (err) {
    logger.error('Failed to invalidate tour caches on supplier archive:', err);
  }

  await logActivity({
    userId: req.user.id,
    action: 'supplier.archived',
    resource: 'SupplierProfile',
    resourceId: id,
    metadata: {
      archivedTours: archivedTours.count,
      archivedTourIds: tourIds,
      supplierName: supplierProfile.user.name,
    },
  });

  res.status(200).json({
    status: 'success',
    message: 'Supplier archived. Tours are hidden and the account is deactivated; bookings are preserved.',
    data: {
      supplierId: id,
      archivedTours: archivedTours.count,
    },
  });
});

/**
 * POST /suppliers/admin/:id/restore
 * Restore a previously archived supplier (admin).
 *
 * Reverses the archive lifecycle:
 *   - reactivates the user account (login allowed again)
 *   - returns the profile to ACTIVE status
 *   - reactivates tours (bookings, payouts, reviews are untouched)
 *
 * Tour selection precedence (only tours currently in ARCHIVED status qualify):
 *   1. `tourIds` in the request body — manual per-tour override, useful for
 *      legacy suppliers archived before snapshots existed.
 *   2. The stored archiveSnapshot (the exact tours the archive action hid).
 *   3. Fallback for legacy records without a snapshot: all ARCHIVED tours.
 */
exports.restoreSupplier = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { tourIds: manualTourIds } = req.body;

  if (manualTourIds !== undefined) {
    if (!Array.isArray(manualTourIds) || manualTourIds.length === 0 || manualTourIds.some((t) => typeof t !== 'string' || !t.trim())) {
      return next(new AppError('tourIds must be a non-empty array of tour ID strings', 400));
    }
  }

  const supplierProfile = await prisma.supplierProfile.findUnique({
    where: { id },
    include: { user: { select: { id: true, name: true, email: true, active: true } } },
  });

  if (!supplierProfile) {
    return next(new AppError('Supplier not found', 404));
  }

  if (supplierProfile.status !== 'SUSPENDED' || supplierProfile.user.active) {
    return next(new AppError('Supplier is not archived and cannot be restored', 409));
  }

  const snapshot = supplierProfile.archiveSnapshot;
  const snapshotTourIds = Array.isArray(snapshot?.tourIds) && snapshot.tourIds.length > 0
    ? snapshot.tourIds
    : null;

  const tourIds = manualTourIds || snapshotTourIds;

  const restoredTours = await prisma.tour.updateMany({
    where: tourIds
      ? { id: { in: tourIds }, supplierId: supplierProfile.userId, status: 'ARCHIVED' }
      : { supplierId: supplierProfile.userId, status: 'ARCHIVED' },
    data: { status: 'ACTIVE' },
  });

  await prisma.supplierProfile.update({
    where: { id },
    data: { status: 'ACTIVE', archiveSnapshot: null },
  });

  await prisma.user.update({
    where: { id: supplierProfile.userId },
    data: { active: true },
  });

  // Invalidate public tour/expedition caches so restored tours reappear immediately.
  try {
    const supplierTours = await prisma.tour.findMany({
      where: { supplierId: supplierProfile.userId },
      select: { id: true, slug: true },
    });
    await Promise.all(supplierTours.map((t) => cache.invalidateTourCaches(t.id, t.slug)));
    await cache.invalidateKeys(['expedition:sitemap']);
  } catch (err) {
    logger.error('Failed to invalidate tour caches on supplier restore:', err);
  }

  // Notify the supplier that their account is back online.
  try {
    await sendSupplierStatusEmail(supplierProfile.user.email, 'ACTIVE', {
      name: supplierProfile.user.name,
    });
  } catch (err) {
    console.error('Supplier restore email failed:', err.message);
  }

  enqueueNotification({
    userId: supplierProfile.user.id,
    type: 'SUPPLIER_APPROVED',
    title: 'Account Restored',
    message: 'Your supplier account has been restored. Your tours are visible again and you can manage bookings.',
    data: { supplierId: id, status: 'ACTIVE' },
  }).catch((err) => console.error('[Notification] enqueueNotification (restore) failed:', err.message));

  await logActivity({
    userId: req.user.id,
    action: 'supplier.restored',
    resource: 'SupplierProfile',
    resourceId: id,
    metadata: {
      restoredTours: restoredTours.count,
      supplierName: supplierProfile.user.name,
      selection: manualTourIds ? 'manual' : (snapshotTourIds ? 'snapshot' : 'all-archived'),
      requestedTourIds: manualTourIds || undefined,
    },
  });

  res.status(200).json({
    status: 'success',
    message: 'Supplier restored. Account is active again and previously archived tours are visible.',
    data: {
      supplierId: id,
      restoredTours: restoredTours.count,
    },
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
      _sum: { platformCommission: true },
    }),
    prisma.tour.findMany({
      where: { supplierId: userId },
      select: {
        id: true,
        title: true,
        _count: { select: { bookings: true } },
        bookings: {
          select: { platformCommission: true, grossAmount: true, status: true },
          where: { status: { not: 'CANCELLED' } },
        },
      },
    }),
  ]);

  const tourMap = Object.fromEntries(tourStats.map(t => [t.status, t._count]));
  const bookingMap = Object.fromEntries(bookingStats.map(b => [b.status, b._count]));

  const tourCommissions = toursWithBooking.map((t) => {
    const totalCommission = t.bookings.reduce((sum, b) => sum + Number(b.platformCommission), 0);
    const totalRevenue = t.bookings.reduce((sum, b) => sum + Number(b.grossAmount), 0);
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
      totalCommission: Number(commissionSum._sum.platformCommission) || 0,
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

/**
 * GET /suppliers/admin/:id/profile
 * Full supplier profile for the admin detail page (admin)
 */
exports.getSupplierProfile = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const include = {
    user: { select: { id: true, name: true, email: true, phone: true, photoURL: true, firebaseUid: true, createdAt: true } },
  };

  let supplier = await prisma.supplierProfile.findUnique({
    where: { id },
    include,
  });

  if (!supplier) {
    supplier = await prisma.supplierProfile.findUnique({
      where: { userId: id },
      include,
    });
  }

  if (!supplier) {
    return next(new AppError('Supplier not found', 404));
  }

  let photoURL = supplier.user?.photoURL || '';
  if (!photoURL && supplier.user?.firebaseUid) {
    try {
      const firebaseRecord = await admin.auth().getUser(supplier.user.firebaseUid);
      photoURL = firebaseRecord.photoURL || '';
    } catch { /* ignore */ }
  }

  const { userId } = supplier;

  const [tourStats, bookingStats, reviewStats, bookingCount, commissionSum, toursWithBooking] = await Promise.all([
    prisma.tour.groupBy({ by: ['status'], where: { supplierId: userId }, _count: true }),
    prisma.booking.groupBy({ by: ['status'], where: { tour: { supplierId: userId } }, _count: true }),
    prisma.review.aggregate({ where: { tour: { supplierId: userId } }, _avg: { rating: true }, _count: true }),
    prisma.booking.count({ where: { tour: { supplierId: userId } } }),
    prisma.booking.aggregate({ where: { tour: { supplierId: userId } }, _sum: { platformCommission: true } }),
    prisma.tour.findMany({
      where: { supplierId: userId },
      select: {
        id: true,
        title: true,
        coverPhoto: true,
        status: true,
        _count: { select: { bookings: true } },
        bookings: {
          select: { platformCommission: true, grossAmount: true, status: true },
          where: { status: { not: 'CANCELLED' } },
        },
      },
    }),
  ]);

  const tourMap = Object.fromEntries(tourStats.map(t => [t.status, t._count]));
  const bookingMap = Object.fromEntries(bookingStats.map(b => [b.status, b._count]));

  const tourCommissions = toursWithBooking.map((t) => {
    const totalCommission = t.bookings.reduce((sum, b) => sum + Number(b.platformCommission), 0);
    const totalRevenue = t.bookings.reduce((sum, b) => sum + Number(b.grossAmount), 0);
    return {
      id: t.id,
      title: t.title,
      coverPhoto: t.coverPhoto,
      status: t.status,
      bookings: t._count.bookings,
      commission: totalCommission,
      revenue: totalRevenue,
    };
  });

  res.status(200).json({
    status: 'success',
    data: {
      supplier: {
        id: supplier.id,
        userId: supplier.userId,
        name: supplier.user?.name || 'Unnamed Supplier',
        email: supplier.user?.email || '',
        phone: supplier.user?.phone || '',
        photoURL,
        status: supplier.status,
        createdAt: supplier.createdAt,
        updatedAt: supplier.updatedAt,
        businessInfo: supplier.businessInfo,
        operatingInfo: supplier.operatingInfo,
        representativeInfo: supplier.representativeInfo,
        businessDocuments: supplier.businessDocuments,
        payoutInfo: supplier.payoutInfo,
        compliance: supplier.compliance,
        adminNotes: supplier.adminNotes,
        archivedAt: supplier.archiveSnapshot?.archivedAt || null,
      },
      stats: {
        earnings: Number(supplier.totalEarnings),
        totalBookings: bookingCount,
        totalCommission: Number(commissionSum._sum.platformCommission) || 0,
        averageRating: Number(supplier.averageRating) || Number(reviewStats._avg.rating) || 0,
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
    },
  });
});

/**
 * GET /suppliers/admin/:id/reviews
 * Supplier's reviews with rating summary + distribution (admin)
 */
exports.getSupplierReviews = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { page = 1, limit = 10 } = req.query;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 10));
  const skip = (pageNum - 1) * limitNum;

  const supplierProfile = await prisma.supplierProfile.findUnique({
    where: { id },
    select: { userId: true },
  });

  if (!supplierProfile) {
    return next(new AppError('Supplier not found', 404));
  }

  const where = { tour: { supplierId: supplierProfile.userId } };

  const [reviews, totalCount, aggregate, distribution] = await Promise.all([
    prisma.review.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limitNum,
      select: {
        id: true,
        rating: true,
        title: true,
        comment: true,
        travelMonth: true,
        createdAt: true,
        verified: true,
        supplierResponse: true,
        customer: { select: { id: true, name: true, photoURL: true } },
        tour: { select: { id: true, title: true, coverPhoto: true } },
      },
    }),
    prisma.review.count({ where }),
    prisma.review.aggregate({ where, _avg: { rating: true }, _count: true }),
    prisma.review.groupBy({ by: ['rating'], where, _count: true }),
  ]);

  const dist = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  distribution.forEach((d) => { dist[d.rating] = d._count; });

  res.status(200).json({
    status: 'success',
    data: {
      reviews,
      averageRating: Number(aggregate._avg.rating) || 0,
      totalReviews: aggregate._count,
      distribution: dist,
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(totalCount / limitNum),
        totalCount,
        hasNextPage: pageNum * limitNum < totalCount,
        limit: limitNum,
      },
    },
  });
});

/**
 * GET /suppliers/admin/:id/analytics
 * Monthly bookings / gross / commission trend (admin)
 */
exports.getSupplierAnalytics = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { months = 12 } = req.query;
  const monthsNum = Math.min(24, Math.max(3, parseInt(months, 10) || 12));

  const supplierProfile = await prisma.supplierProfile.findUnique({
    where: { id },
    select: { userId: true },
  });

  if (!supplierProfile) {
    return next(new AppError('Supplier not found', 404));
  }

  const since = new Date();
  since.setMonth(since.getMonth() - (monthsNum - 1));
  since.setDate(1);
  since.setHours(0, 0, 0, 0);

  const bookings = await prisma.booking.findMany({
    where: {
      tour: { supplierId: supplierProfile.userId },
      createdAt: { gte: since },
    },
    select: { createdAt: true, grossAmount: true, platformCommission: true, status: true },
    orderBy: { createdAt: 'asc' },
  });

  const monthMap = new Map();
  const cursor = new Date(since);
  const now = new Date();
  while (cursor <= now) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
    monthMap.set(key, { month: key, bookings: 0, gross: 0, commission: 0 });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  bookings.forEach((b) => {
    if (b.status === 'CANCELLED') return;
    const key = `${b.createdAt.getFullYear()}-${String(b.createdAt.getMonth() + 1).padStart(2, '0')}`;
    const entry = monthMap.get(key);
    if (!entry) return;
    entry.bookings += 1;
    entry.gross += Number(b.grossAmount);
    entry.commission += Number(b.platformCommission);
  });

  res.status(200).json({
    status: 'success',
    data: {
      months: monthsNum,
      series: Array.from(monthMap.values()),
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
    await deleteCloudinaryImage(user.logoUrl, 3, { userId: req.user.id });
  }

  const updatedUser = await prisma.user.update({
    where: { id: req.user.id },
    data: { logoUrl: req.file.path },
  });

  prisma.media.updateMany({
    where: { url: req.file.path },
    data: { status: 'ATTACHED', entity: 'user', entityId: updatedUser.id },
  }).catch(() => {});

  res.status(200).json({
    status: 'success',
    data: { logoUrl: updatedUser.logoUrl },
  });
});
