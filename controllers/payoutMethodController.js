/**
 * Payout Method Controller - Production Ready
 * Handles supplier payout method management (bank, PayPal)
 *
 * @author Tour Platform Team
 * @version 1.0.0
 */

const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { notifyAdmin } = require('../utils/adminNotificationService');
const { logActivity } = require('../utils/auditLogger');
const admin = require('../config/firebaseAdmin');

// ================================
// SUPPLIER ROUTES
// ================================

/**
 * GET /payout-methods/me
 * Returns all payout methods for the authenticated supplier
 */
exports.getMyMethods = catchAsync(async (req, res) => {
  const supplierId = req.supplierId;

  const methods = await prisma.payoutMethod.findMany({
    where: { supplierId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });

  res.status(200).json({
    status: 'success',
    data: { methods },
  });
});

/**
 * POST /payout-methods
 * Add a new payout method for the authenticated supplier
 */
exports.addMethod = catchAsync(async (req, res, next) => {
  const supplierId = req.supplierId;

  const {
    type,
    currency = 'USD',
    // Bank Transfer
    bankName,
    bankAddress,
    bankCountry,
    accountName,
    accountNumber,
    routingNumber,
    swiftCode,
    iban,
    sortCode,
    branchCode,
    branchName,
    // PayPal
    paypalEmail,
  } = req.body;

  if (!type) {
    return next(new AppError('Payout method type is required', 400));
  }

  if (!['BANK_TRANSFER', 'PAYPAL'].includes(type)) {
    return next(new AppError('Unsupported payout method type', 400));
  }

  // Validate required fields per type
  if (type === 'BANK_TRANSFER' && (!accountName || !accountNumber)) {
    return next(new AppError('Bank transfer requires accountName and accountNumber', 400));
  }
  if (type === 'PAYPAL' && !paypalEmail) {
    return next(new AppError('PayPal requires paypalEmail', 400));
  }

  // Check if this is the first method (auto-set as default)
  const existingCount = await prisma.payoutMethod.count({ where: { supplierId } });
  const isDefault = existingCount === 0;

  const method = await prisma.payoutMethod.create({
    data: {
      supplierId,
      type,
      currency,
      isDefault,
      bankName,
      bankAddress,
      bankCountry,
      accountName,
      accountNumber,
      routingNumber,
      swiftCode,
      iban,
      sortCode,
      branchCode,
      branchName,
      paypalEmail,
    },
    include: {
      supplier: { select: { id: true, name: true, email: true } },
    },
  });

  await logActivity({
    userId: supplierId,
    action: 'payout_method.added',
    resource: 'PayoutMethod',
    resourceId: method.id,
    metadata: { type, currency },
  });

  // Notify admin of new payout method
  notifyAdmin({
    type: 'SYSTEM_ALERT',
    title: 'New Payout Method Added',
    message: `${method.supplier.name} (${method.supplier.email}) added a new payout method: ${method.type}.`,
    data: {
      supplierId,
      payoutMethodId: method.id,
      type: method.type,
    },
  }).catch((err) => console.error('[AdminNotification] notifyAdmin failed:', err.message));

  res.status(201).json({
    status: 'success',
    data: { method },
  });
});

/**
 * PATCH /payout-methods/:id
 * Update a payout method (supplier can only update their own)
 */
exports.updateMethod = catchAsync(async (req, res, next) => {
  const supplierId = req.supplierId;
  const { id } = req.params;

  const existing = await prisma.payoutMethod.findFirst({
    where: { id, supplierId },
  });

  if (!existing) {
    return next(new AppError('Payout method not found or access denied', 404));
  }

  const {
    currency,
    bankName,
    bankAddress,
    bankCountry,
    accountName,
    accountNumber,
    routingNumber,
    swiftCode,
    iban,
    sortCode,
    branchCode,
    branchName,
    paypalEmail,
    isDefault,
  } = req.body;

  // If setting as default, unset all others first
  if (isDefault === true) {
    await prisma.payoutMethod.updateMany({
      where: { supplierId, id: { not: id } },
      data: { isDefault: false },
    });
  }

  const method = await prisma.payoutMethod.update({
    where: { id },
    data: {
      ...(currency !== undefined && { currency }),
      ...(bankName !== undefined && { bankName }),
      ...(bankAddress !== undefined && { bankAddress }),
      ...(bankCountry !== undefined && { bankCountry }),
      ...(accountName !== undefined && { accountName }),
      ...(accountNumber !== undefined && { accountNumber }),
      ...(routingNumber !== undefined && { routingNumber }),
      ...(swiftCode !== undefined && { swiftCode }),
      ...(iban !== undefined && { iban }),
      ...(sortCode !== undefined && { sortCode }),
      ...(branchCode !== undefined && { branchCode }),
      ...(branchName !== undefined && { branchName }),
      ...(paypalEmail !== undefined && { paypalEmail }),
      ...(isDefault !== undefined && { isDefault }),
      // Reset verification when details change
      verified: false,
    },
  });

  await logActivity({
    userId: supplierId,
    action: 'payout_method.updated',
    resource: 'PayoutMethod',
    resourceId: method.id,
  });

  res.status(200).json({
    status: 'success',
    data: { method },
  });
});

/**
 * DELETE /payout-methods/:id
 * Delete a payout method (auto-reassigns default if needed)
 */
exports.deleteMethod = catchAsync(async (req, res, next) => {
  const supplierId = req.supplierId;
  const { id } = req.params;

  const existing = await prisma.payoutMethod.findFirst({
    where: { id, supplierId },
  });

  if (!existing) {
    return next(new AppError('Payout method not found or access denied', 404));
  }

  await prisma.payoutMethod.delete({ where: { id } });

  // If deleted method was default, assign default to the next available
  if (existing.isDefault) {
    const next = await prisma.payoutMethod.findFirst({
      where: { supplierId },
      orderBy: { createdAt: 'asc' },
    });
    if (next) {
      await prisma.payoutMethod.update({
        where: { id: next.id },
        data: { isDefault: true },
      });
    }
  }

  await logActivity({
    userId: supplierId,
    action: 'payout_method.deleted',
    resource: 'PayoutMethod',
    resourceId: id,
    oldValues: {
      type: existing.type,
      bankName: existing.bankName,
      accountName: existing.accountName,
      isDefault: existing.isDefault,
    },
    metadata: { type: existing.type },
  });

  res.status(200).json({
    status: 'success',
    message: 'Payout method deleted',
  });
});

// ================================
// ADMIN ROUTES
// ================================

/**
 * GET /payout-methods/admin/suppliers/:supplierId
 * Get a specific supplier's payout methods (admin)
 */
exports.getSupplierMethods = catchAsync(async (req, res, next) => {
  const { supplierId } = req.params;

  const supplier = await prisma.user.findUnique({
    where: { id: supplierId },
    select: { id: true, name: true, email: true },
  });

  if (!supplier) {
    return next(new AppError('Supplier not found', 404));
  }

  const methods = await prisma.payoutMethod.findMany({
    where: { supplierId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });

  res.status(200).json({
    status: 'success',
    data: { supplier, methods },
  });
});

/**
 * GET /payout-methods/admin
 * List all suppliers with their payout methods (admin / finance dashboard)
 */
exports.getAllSuppliersMethods = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, hasMethod } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  // Build supplier filter
  const supplierWhere = { roles: { has: 'supplier' } };

  if (hasMethod === 'true') {
    supplierWhere.payoutMethods = { some: {} };
  } else if (hasMethod === 'false') {
    supplierWhere.payoutMethods = { none: {} };
  }

  const [suppliers, totalCount] = await Promise.all([
    prisma.user.findMany({
      where: supplierWhere,
      select: {
        id: true,
        name: true,
        email: true,
        photoURL: true,
        firebaseUid: true,
        supplierProfile: {
          select: { status: true },
        },
        payoutMethods: {
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit),
    }),
    prisma.user.count({ where: supplierWhere }),
  ]);

  const totalPages = Math.ceil(totalCount / parseInt(limit));

  const transformed = await Promise.all(suppliers.map(async (s) => {
    let photoURL = s.photoURL || '';
    if (!photoURL && s.firebaseUid) {
      try {
        const firebaseRecord = await admin.auth().getUser(s.firebaseUid);
        photoURL = firebaseRecord.photoURL || '';
      } catch { /* not a Firebase auth user or not found */ }
    }
    const { firebaseUid: _uid, ...rest } = s; // eslint-disable-line no-unused-vars
    return { ...rest, photoURL: photoURL ? photoURL : photoURL };
  }));

  res.status(200).json({
    status: 'success',
    data: {
      suppliers: transformed,
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
 * GET /payout-methods/admin/summary
 * Payout method coverage + readiness for the finance dashboard
 */
exports.getPayoutMethodSummary = catchAsync(async (req, res) => {
  const suppliers = await prisma.user.findMany({
    where: { roles: { has: 'supplier' } },
    select: {
      id: true,
      name: true,
      email: true,
      payoutMethods: {
        select: { id: true, type: true, verified: true, isDefault: true },
      },
    },
  });

  let withMethod = 0;
  let needSetup = 0;
  let unverified = 0;
  const typeMix = {};
  const verifiedMix = {};

  suppliers.forEach((s) => {
    const methods = s.payoutMethods || [];
    const methodCount = methods.length;
    if (methodCount > 0) {
      withMethod += 1;
      const unverifiedCount = methods.filter((m) => !m.verified).length;
      if (unverifiedCount > 0) unverified += 1;
    } else {
      needSetup += 1;
    }
    methods.forEach((m) => {
      typeMix[m.type] = (typeMix[m.type] || 0) + 1;
      if (m.verified) verifiedMix[m.type] = (verifiedMix[m.type] || 0) + 1;
    });
  });

  const typeOrder = ['BANK_TRANSFER', 'PAYPAL'];
  const mix = typeOrder.reduce((acc, t) => {
    if (typeMix[t]) acc[t] = { total: typeMix[t], verified: verifiedMix[t] || 0 };
    return acc;
  }, {});

  res.status(200).json({
    status: 'success',
    data: {
      totalSuppliers: suppliers.length,
      withMethod,
      needSetup,
      unverified,
      hasDefault: suppliers.filter((s) => (s.payoutMethods || []).some((m) => m.isDefault)).length,
      typeMix: mix,
    },
  });
});

/**
 * PATCH /payout-methods/admin/:id/verify
 * Verify or unverify a payout method (admin / finance team)
 */
exports.verifyPayoutMethod = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { verified = true } = req.body;

  const existing = await prisma.payoutMethod.findUnique({
    where: { id },
    include: { supplier: { select: { id: true, name: true, email: true } } },
  });

  if (!existing) {
    return next(new AppError('Payout method not found', 404));
  }

  const method = await prisma.payoutMethod.update({
    where: { id },
    data: { verified: Boolean(verified) },
  });

  await logActivity({
    userId: req.user.id,
    action: verified ? 'payout_method.verified' : 'payout_method.unverified',
    resource: 'PayoutMethod',
    resourceId: id,
    metadata: { supplierId: existing.supplierId, type: existing.type },
  });

  res.status(200).json({
    status: 'success',
    data: { method },
  });
});
