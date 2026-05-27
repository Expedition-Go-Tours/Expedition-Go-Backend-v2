/**
 * Supplier Controller - Production Ready
 * Handles supplier verification, onboarding, and management
 * 
 * Features:
 * - Supplier application and verification process
 * - Stripe Connect integration for payouts
 * - Document upload and verification
 * - Admin approval workflow
 * - Supplier dashboard and analytics
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const cloudinary = require('cloudinary').v2;

const { enqueueNotification, enqueueEmail } = require('../utils/queue');
const { notifyAdmin } = require('../utils/adminNotificationService');
const { logActivity } = require('../utils/auditLogger');
const { validateSupplierData } = require('../utils/supplierHelpers');

const MULTER_FILE_FIELDS = ['registrationDocument', 'taxDocument', 'proofOfAddress', 'idDocument', 'licenses'];

function extractFileUrls(files) {
  if (!files) return {};
  const result = {};
  for (const [field, fileList] of Object.entries(files)) {
    if (field === 'licenses') {
      result.licenses = fileList.map((f) => f.path);
    } else {
      result[`${field}Url`] = fileList[0]?.path;
    }
  }
  return result;
}

const JSON_FIELDS = ['businessInfo', 'operatingInfo', 'representativeInfo', 'businessDocuments', 'payoutInfo', 'compliance'];
function parseSupplierFields(obj) {
  if (!obj) return obj;
  for (const field of JSON_FIELDS) {
    if (typeof obj[field] === 'string') {
      try { obj[field] = JSON.parse(obj[field]); } catch {}
    }
  }
  return obj;
}

// ================================
// SUPPLIER APPLICATION PROCESS
// ================================

/**
 * Submit supplier application
 */
exports.applyToBeSupplier = catchAsync(async (req, res, next) => {
  const userId = req.user.id;

  // Check if user already has a supplier profile
  const existingProfile = await prisma.supplierProfile.findUnique({
    where: { userId }
  });

  if (existingProfile) {
    return next(new AppError('Supplier application already exists', 400));
  }

  // Parse JSON string fields from multipart form data
  for (const field of JSON_FIELDS) {
    if (typeof req.body[field] === 'string') {
      try { req.body[field] = JSON.parse(req.body[field]); } catch {}
    }
  }

  // Merge uploaded file URLs from multer into the body before validation
  const fileUrls = extractFileUrls(req.files);
  req.body.businessDocuments = {
    registrationDocumentUrl: fileUrls.registrationDocumentUrl,
    taxDocumentUrl: fileUrls.taxDocumentUrl,
    proofOfAddressUrl: fileUrls.proofOfAddressUrl,
    licenses: fileUrls.licenses || [],
  };
  if (req.body.representativeInfo && fileUrls.idDocumentUrl) {
    req.body.representativeInfo.idDocumentUrl = fileUrls.idDocumentUrl;
  }

  // Validate application data
  const validationResult = validateSupplierData(req.body);
  if (!validationResult.isValid) {
    return next(new AppError(`Validation failed: ${validationResult.errors.join(', ')}`, 400));
  }

  let {
    businessInfo,
    operatingInfo,
    representativeInfo,
    businessDocuments,
    payoutInfo
  } = req.body;

  // Create supplier profile with PENDING status
  const supplierProfile = await prisma.supplierProfile.create({
    data: {
      userId,
      status: 'PENDING',
      businessInfo,
      operatingInfo,
      representativeInfo,
      businessDocuments,
      payoutInfo: payoutInfo || {},
      compliance: {
        acceptedTerms: true,
        agreedToPayoutTerms: true,
        verified: false,
        reviewStatus: 'PENDING'
      }
    }
  });

  // Update user roles to include supplier and save phone
  await prisma.user.update({
    where: { id: userId },
    data: {
      roles: {
        push: 'supplier'
      },
      phone: req.body.representativeInfo?.phoneNumber || req.user.phone
    }
  });

  // Notify admins
  await notifyAdmin({
    type: 'NEW_SUPPLIER_APPLICATION',
    title: 'New Supplier Application',
    message: `${req.user.name} has applied to become a supplier`,
    data: {
      supplierId: userId,
      supplierProfileId: supplierProfile.id,
      businessName: supplierProfile.businessInfo?.legalBusinessName,
    },
  });

  // Log activity
  await logActivity({
    userId,
    action: 'supplier.application_submitted',
    resource: 'SupplierProfile',
    resourceId: supplierProfile.id,
    metadata: {
      businessName: businessInfo.legalBusinessName
    }
  });

  res.status(201).json({
    status: 'success',
    message: 'Supplier application submitted successfully. You will be notified once reviewed.',
    data: {
      supplierProfile: {
        id: supplierProfile.id,
        status: supplierProfile.status,
        createdAt: supplierProfile.createdAt
      }
    }
  });
});

/**
 * Get supplier application status
 */
exports.getApplicationStatus = catchAsync(async (req, res, next) => {
  const userId = req.user.id;

  const supplierProfile = await prisma.supplierProfile.findUnique({
    where: { userId },
    select: {
      id: true,
      status: true,
      adminNotes: true,
      reviewedAt: true,
      createdAt: true,
      updatedAt: true
    }
  });

  if (!supplierProfile) {
    return next(new AppError('No supplier application found', 404));
  }

  res.status(200).json({
    status: 'success',
    data: { supplierProfile }
  });
});

/**
 * Update supplier application (only if PENDING or UNDER_REVIEW)
 */
exports.updateApplication = catchAsync(async (req, res, next) => {
  const userId = req.user.id;

  const supplierProfile = await prisma.supplierProfile.findUnique({
    where: { userId }
  });

  if (!supplierProfile) {
    return next(new AppError('No supplier application found', 404));
  }

  if (!['PENDING', 'UNDER_REVIEW'].includes(supplierProfile.status)) {
    return next(new AppError('Application cannot be modified in current status', 400));
  }

  // Parse JSON string fields from multipart form data
  for (const field of JSON_FIELDS) {
    if (typeof req.body[field] === 'string') {
      try { req.body[field] = JSON.parse(req.body[field]); } catch {}
    }
  }

  // Validate update data
  // Merge uploaded file URLs from multer into the data
  const fileUrls = extractFileUrls(req.files);
  if (fileUrls.registrationDocumentUrl || fileUrls.taxDocumentUrl || fileUrls.proofOfAddressUrl || fileUrls.licenses) {
    req.body.businessDocuments = {
      registrationDocumentUrl: fileUrls.registrationDocumentUrl,
      taxDocumentUrl: fileUrls.taxDocumentUrl,
      proofOfAddressUrl: fileUrls.proofOfAddressUrl,
      licenses: fileUrls.licenses || [],
    };
  }
  if (req.body.representativeInfo && fileUrls.idDocumentUrl) {
    req.body.representativeInfo.idDocumentUrl = fileUrls.idDocumentUrl;
  }

  const validationResult = validateSupplierData(req.body, true); // partial validation
  if (!validationResult.isValid) {
    return next(new AppError(`Validation failed: ${validationResult.errors.join(', ')}`, 400));
  }

  const updateData = { ...req.body };

  // Reset status to PENDING if significant changes made
  if (req.body.businessInfo || req.body.representativeInfo || req.body.businessDocuments) {
    updateData.status = 'PENDING';
    updateData.reviewedAt = null;
    updateData.reviewedBy = null;
    updateData.adminNotes = null;
  }

  const updatedProfile = await prisma.supplierProfile.update({
    where: { userId },
    data: updateData
  });

  // Log activity
  await logActivity({
    userId,
    action: 'supplier.application_updated',
    resource: 'SupplierProfile',
    resourceId: supplierProfile.id,
    oldValues: supplierProfile,
    newValues: updatedProfile
  });

  res.status(200).json({
    status: 'success',
    data: { supplierProfile: parseSupplierFields(updatedProfile) }
  });
});

// ================================
// SUPPLIER DASHBOARD
// ================================

/**
 * Get supplier dashboard data
 */
exports.getDashboard = catchAsync(async (req, res, next) => {
  const userId = req.user.id;

  // Verify supplier is active
  const supplierProfile = await prisma.supplierProfile.findUnique({
    where: { userId }
  });

  if (!supplierProfile) {
    return next(new AppError('Supplier profile not found', 404));
  }

  const [
    tourStats,
    bookingStats,
    revenueStats,
    recentBookings,
    recentReviews,
    monthlyRevenue
  ] = await Promise.all([
    // Tour statistics
    prisma.tour.groupBy({
      by: ['status'],
      where: { supplierId: userId },
      _count: true
    }),

    // Booking statistics
    prisma.booking.groupBy({
      by: ['status'],
      where: {
        tour: { supplierId: userId }
      },
      _count: true
    }),

    // Revenue statistics
    prisma.booking.aggregate({
      where: {
        tour: { supplierId: userId },
        status: 'CONFIRMED'
      },
      _sum: {
        supplierPayout: true,
        total: true
      },
      _count: true
    }),

    // Recent bookings
    prisma.booking.findMany({
      where: {
        tour: { supplierId: userId }
      },
      include: {
        customer: {
          select: {
            name: true,
            email: true,
            photoURL: true
          }
        },
        tour: {
          select: {
            title: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 5
    }),

    // Recent reviews
    prisma.review.findMany({
      where: {
        tour: { supplierId: userId },
        status: 'APPROVED'
      },
      include: {
        customer: {
          select: {
            name: true,
            photoURL: true
          }
        },
        tour: {
          select: {
            title: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 5
    }),

    // Monthly revenue trend (last 12 months)
    prisma.$queryRaw`
      SELECT 
        DATE_TRUNC('month', "selectedDate") as month,
        COUNT(*) as bookings,
        SUM("supplierPayout") as revenue
      FROM "Booking" b
      JOIN "Tour" t ON b."tourId" = t.id
      WHERE t."supplierId" = ${userId}
        AND b."selectedDate" >= NOW() - INTERVAL '12 months'
        AND b."status" = 'CONFIRMED'
      GROUP BY DATE_TRUNC('month', "selectedDate")
      ORDER BY month DESC
    `
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      supplierProfile: {
        id: supplierProfile.id,
        status: supplierProfile.status,
        averageRating: supplierProfile.averageRating,
        totalEarnings: supplierProfile.totalEarnings,
        totalBookings: supplierProfile.totalBookings
      },
      stats: {
        tours: tourStats,
        bookings: bookingStats,
        revenue: revenueStats
      },
      recentActivity: {
        bookings: recentBookings,
        reviews: recentReviews
      },
      analytics: {
        monthlyRevenue
      }
    }
  });
});

/**
 * Get supplier earnings and payout history
 */
exports.getEarnings = catchAsync(async (req, res, next) => {
  const userId = req.user.id;
  const { page = 1, limit = 20, startDate, endDate } = req.query;

  const where = {
    tour: { supplierId: userId },
    status: 'CONFIRMED'
  };

  // Add date filtering
  if (startDate || endDate) {
    where.selectedDate = {};
    if (startDate) where.selectedDate.gte = new Date(startDate);
    if (endDate) where.selectedDate.lte = new Date(endDate);
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [earnings, totalCount, summary] = await Promise.all([
    prisma.booking.findMany({
      where,
      select: {
        id: true,
        bookingNumber: true,
        selectedDate: true,
        total: true,
        supplierPayout: true,
        commissionAmount: true,
        commissionRate: true,
        currency: true,
        paidAt: true,
        tour: {
          select: {
            title: true
          }
        },
        customer: {
          select: {
            name: true
          }
        }
      },
      orderBy: { paidAt: 'desc' },
      skip,
      take: parseInt(limit)
    }),
    prisma.booking.count({ where }),
    prisma.booking.aggregate({
      where,
      _sum: {
        supplierPayout: true,
        commissionAmount: true,
        total: true
      },
      _count: true
    })
  ]);

  const totalPages = Math.ceil(totalCount / parseInt(limit));

  res.status(200).json({
    status: 'success',
    data: {
      earnings,
      summary: {
        totalEarnings: summary._sum.supplierPayout || 0,
        totalCommission: summary._sum.commissionAmount || 0,
        totalRevenue: summary._sum.total || 0,
        totalBookings: summary._count
      },
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
// ADMIN SUPPLIER MANAGEMENT
// ================================

/**
 * Get all supplier applications (admin only)
 */
exports.getAllApplications = catchAsync(async (req, res, next) => {
  const { status, page = 1, limit = 20 } = req.query;

  const where = {};
  if (status) where.status = status;

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [applications, totalCount] = await Promise.all([
    prisma.supplierProfile.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            photoURL: true,
            createdAt: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit)
    }),
    prisma.supplierProfile.count({ where })
  ]);

  const totalPages = Math.ceil(totalCount / parseInt(limit));

  res.status(200).json({
    status: 'success',
    data: {
      applications: applications.map(parseSupplierFields),
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
 * Review supplier application (admin only)
 */
exports.reviewApplication = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { action, notes } = req.body; // action: 'approve', 'reject', 'request_info'
  const adminId = req.user.id;

  if (!['approve', 'reject', 'request_info'].includes(action)) {
    return next(new AppError('Invalid review action', 400));
  }

  const supplierProfile = await prisma.supplierProfile.findUnique({
    where: { id },
    include: {
      user: true
    }
  });

  if (!supplierProfile) {
    return next(new AppError('Supplier application not found', 404));
  }

  const statusMap = {
    approve: 'APPROVED',
    reject: 'REJECTED',
    request_info: 'UNDER_REVIEW'
  };

  const updatedProfile = await prisma.supplierProfile.update({
    where: { id },
    data: {
      status: statusMap[action],
      adminNotes: notes,
      reviewedBy: adminId,
      reviewedAt: new Date()
    }
  });

  // Send notification to supplier
  const notificationMessages = {
    approve: 'Your supplier application has been approved! Please set up your payout methods in your account settings to start receiving payments.',
    reject: 'Your supplier application was not approved.',
    request_info: 'Additional information is required for your supplier application.'
  };

  enqueueNotification({
    userId: supplierProfile.userId,
    type: action === 'approve' ? 'SUPPLIER_APPROVED' : 'SUPPLIER_REJECTED',
    title: 'Supplier Application Update',
    message: notificationMessages[action],
    data: {
      supplierId: supplierProfile.userId,
      action,
      notes
    }
  }).catch(() => {});

  // Send email notification through the queue
  enqueueEmail({
    type: 'supplier-status-email',
    email: supplierProfile.user.email,
    status: statusMap[action],
    data: { name: supplierProfile.user.name, notes }
  }).catch(() => {});

  // Notify admins of status change
  await notifyAdmin({
    type: 'SUPPLIER_STATUS_CHANGE',
    title: `Supplier ${action === 'approve' ? 'Approved' : action === 'reject' ? 'Rejected' : 'Requested Info'}`,
    message: `${supplierProfile.user?.name || supplierProfile.businessInfo?.legalBusinessName || 'A supplier'}'s application was ${action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'requested additional information'}`,
    data: {
      supplierId: supplierProfile.userId,
      supplierProfileId: supplierProfile.id,
      action,
      notes,
      businessName: supplierProfile.businessInfo?.legalBusinessName,
    },
  });

  // Log activity
  await logActivity({
    userId: adminId,
    action: `supplier.${action}`,
    resource: 'SupplierProfile',
    resourceId: supplierProfile.id,
    metadata: {
      supplierId: supplierProfile.userId,
      notes,
      businessName: supplierProfile.businessInfo?.legalBusinessName
    }
  });

  res.status(200).json({
    status: 'success',
    data: { supplierProfile: parseSupplierFields(updatedProfile) }
  });
});

/**
 * Activate a supplier directly (admin only)
 * Supplier must be APPROVED and have a verified payout method
 */
exports.activateSupplier = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const adminId = req.user.id;

  const supplierProfile = await prisma.supplierProfile.findUnique({
    where: { userId: id },
    include: { user: true }
  });

  if (!supplierProfile) {
    return next(new AppError('Supplier not found', 404));
  }

  if (supplierProfile.status !== 'APPROVED') {
    return next(new AppError('Supplier must be in APPROVED status to activate', 400));
  }

  // Check supplier has a verified payout method before activating
  const payoutMethod = await prisma.payoutMethod.findFirst({
    where: { supplierId: id, verified: true },
  });
  if (!payoutMethod) {
    return next(new AppError('Supplier must add a verified payout method before activation', 400));
  }

  const updatedProfile = await prisma.supplierProfile.update({
    where: { userId: id },
    data: { status: 'ACTIVE' }
  });

  enqueueNotification({
    userId: id,
    type: 'SUPPLIER_APPROVED',
    title: 'Supplier Account Activated',
    message: 'Your supplier account is now active! You can start creating tours.',
    data: { supplierId: id }
  }).catch(() => {});

  await notifyAdmin({
    type: 'SUPPLIER_STATUS_CHANGE',
    title: 'Supplier Activated',
    message: `${supplierProfile.user?.name || 'A supplier'}'s account was activated`,
    data: { supplierId: id, businessName: supplierProfile.businessInfo?.legalBusinessName },
  });

  enqueueEmail({
    type: 'supplier-status-email',
    email: supplierProfile.user.email,
    status: 'ACTIVE',
    data: { name: supplierProfile.user.name }
  }).catch(() => {});

  await logActivity({
    userId: adminId,
    action: 'supplier.activated',
    resource: 'SupplierProfile',
    resourceId: supplierProfile.id,
    metadata: {
      supplierId: id,
      businessName: supplierProfile.businessInfo?.legalBusinessName
    }
  });

  res.status(200).json({
    status: 'success',
    data: { supplierProfile: parseSupplierFields(updatedProfile) }
  });
});

/**
 * Suspend/unsuspend supplier (admin only)
 */
exports.suspendSupplier = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { suspend, reason } = req.body; // suspend: true/false
  const adminId = req.user.id;

  const supplierProfile = await prisma.supplierProfile.findUnique({
    where: { userId: id },
    include: {
      user: true
    }
  });

  if (!supplierProfile) {
    return next(new AppError('Supplier not found', 404));
  }

  const newStatus = suspend ? 'SUSPENDED' : 'ACTIVE';

  const updatedProfile = await prisma.supplierProfile.update({
    where: { userId: id },
    data: {
      status: newStatus,
      adminNotes: reason
    }
  });

  enqueueNotification({
    userId: id,
    type: 'SYSTEM_ALERT',
    title: suspend ? 'Account Suspended' : 'Account Reactivated',
    message: suspend 
      ? 'Your supplier account has been suspended.'
      : 'Your supplier account has been reactivated.',
    data: {
      reason,
      action: suspend ? 'suspended' : 'reactivated'
    }
  }).catch(() => {});

  await notifyAdmin({
    type: 'SUPPLIER_STATUS_CHANGE',
    title: suspend ? 'Supplier Suspended' : 'Supplier Reactivated',
    message: `${supplierProfile.user?.name || 'A supplier'}'s account was ${suspend ? 'suspended' : 'reactivated'}${reason ? ` — ${reason}` : ''}`,
    data: { supplierId: id, reason, action: suspend ? 'suspended' : 'reactivated' },
  });

  // Log activity
  await logActivity({
    userId: adminId,
    action: suspend ? 'supplier.suspended' : 'supplier.reactivated',
    resource: 'SupplierProfile',
    resourceId: supplierProfile.id,
    metadata: {
      supplierId: id,
      reason
    }
  });

  res.status(200).json({
    status: 'success',
    data: { supplierProfile: parseSupplierFields(updatedProfile) }
  });
});

module.exports = exports;