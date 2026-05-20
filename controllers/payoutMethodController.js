const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { enqueueNotification } = require('../utils/queue');
const { logActivity } = require('../utils/auditLogger');

const VALID_TYPES = ['BANK_TRANSFER', 'MOBILE_MONEY', 'PAYPAL'];

function validatePayoutMethodData(data) {
  const errors = [];

  if (!data.type || !VALID_TYPES.includes(data.type)) {
    errors.push(`Type must be one of: ${VALID_TYPES.join(', ')}`);
    return errors;
  }

  switch (data.type) {
    case 'BANK_TRANSFER':
      if (!data.accountName) errors.push('Account name is required for bank transfers');
      if (!data.accountNumber && !data.iban) errors.push('Account number or IBAN is required for bank transfers');
      if (!data.bankName) errors.push('Bank name is required for bank transfers');
      if (!data.bankCountry) errors.push('Bank country code is required (e.g., GH, NG, US)');
      break;
    case 'MOBILE_MONEY':
      if (!data.mobileProvider) errors.push('Mobile provider is required (e.g., MTN, Orange, Airtel)');
      if (!data.mobileNumber) errors.push('Mobile number is required');
      break;
    case 'PAYPAL':
      if (!data.paypalEmail) errors.push('PayPal email is required');
      break;
  }

  return errors;
}

/**
 * Get all payout methods for the authenticated supplier
 */
exports.getMyMethods = catchAsync(async (req, res, next) => {
  const methods = await prisma.payoutMethod.findMany({
    where: { supplierId: req.user.id },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }]
  });

  res.status(200).json({
    status: 'success',
    data: { methods }
  });
});

/**
 * Add a new payout method
 */
exports.addMethod = catchAsync(async (req, res, next) => {
  const supplierId = req.user.id;
  const data = req.body;

  const errors = validatePayoutMethodData(data);
  if (errors.length > 0) {
    return next(new AppError(`Validation failed: ${errors.join('; ')}`, 400));
  }

  // If this is the first method, make it default automatically
  const existingCount = await prisma.payoutMethod.count({ where: { supplierId } });
  const isDefault = existingCount === 0 ? true : (data.isDefault === true);

  if (data.isDefault && existingCount > 0) {
    await prisma.payoutMethod.updateMany({
      where: { supplierId },
      data: { isDefault: false }
    });
  }

  const method = await prisma.payoutMethod.create({
    data: {
      supplierId,
      type: data.type,
      isDefault,
      currency: data.currency || 'USD',
      bankName: data.bankName || null,
      bankAddress: data.bankAddress || null,
      bankCountry: data.bankCountry || null,
      accountName: data.accountName || null,
      accountNumber: data.accountNumber || null,
      routingNumber: data.routingNumber || null,
      swiftCode: data.swiftCode || null,
      iban: data.iban || null,
      sortCode: data.sortCode || null,
      branchCode: data.branchCode || null,
      mobileProvider: data.mobileProvider || null,
      mobileNumber: data.mobileNumber || null,
      paypalEmail: data.paypalEmail || null
    }
  });

  await logActivity({
    userId: supplierId,
    action: 'payout_method.added',
    resource: 'PayoutMethod',
    resourceId: method.id,
    metadata: { type: data.type }
  });

  res.status(201).json({
    status: 'success',
    data: { method }
  });
});

/**
 * Update a payout method
 */
exports.updateMethod = catchAsync(async (req, res, next) => {
  const supplierId = req.user.id;
  const { id } = req.params;
  const data = req.body;

  const existing = await prisma.payoutMethod.findUnique({
    where: { id }
  });

  if (!existing || existing.supplierId !== supplierId) {
    return next(new AppError('Payout method not found', 404));
  }

  const type = data.type || existing.type;
  const errors = validatePayoutMethodData({ ...existing, ...data, type });
  if (errors.length > 0) {
    return next(new AppError(`Validation failed: ${errors.join('; ')}`, 400));
  }

  if (data.isDefault) {
    await prisma.payoutMethod.updateMany({
      where: { supplierId, id: { not: id } },
      data: { isDefault: false }
    });
  }

  const method = await prisma.payoutMethod.update({
    where: { id },
    data: {
      type: data.type || undefined,
      isDefault: data.isDefault !== undefined ? data.isDefault : undefined,
      currency: data.currency || undefined,
      bankName: data.bankName !== undefined ? data.bankName : undefined,
      bankAddress: data.bankAddress !== undefined ? data.bankAddress : undefined,
      bankCountry: data.bankCountry !== undefined ? data.bankCountry : undefined,
      accountName: data.accountName !== undefined ? data.accountName : undefined,
      accountNumber: data.accountNumber !== undefined ? data.accountNumber : undefined,
      routingNumber: data.routingNumber !== undefined ? data.routingNumber : undefined,
      swiftCode: data.swiftCode !== undefined ? data.swiftCode : undefined,
      iban: data.iban !== undefined ? data.iban : undefined,
      sortCode: data.sortCode !== undefined ? data.sortCode : undefined,
      branchCode: data.branchCode !== undefined ? data.branchCode : undefined,
      mobileProvider: data.mobileProvider !== undefined ? data.mobileProvider : undefined,
      mobileNumber: data.mobileNumber !== undefined ? data.mobileNumber : undefined,
      paypalEmail: data.paypalEmail !== undefined ? data.paypalEmail : undefined
    }
  });

  await logActivity({
    userId: supplierId,
    action: 'payout_method.updated',
    resource: 'PayoutMethod',
    resourceId: method.id,
    metadata: { type: method.type }
  });

  res.status(200).json({
    status: 'success',
    data: { method }
  });
});

/**
 * Delete a payout method
 */
exports.deleteMethod = catchAsync(async (req, res, next) => {
  const supplierId = req.user.id;
  const { id } = req.params;

  const existing = await prisma.payoutMethod.findUnique({ where: { id } });
  if (!existing || existing.supplierId !== supplierId) {
    return next(new AppError('Payout method not found', 404));
  }

  await prisma.payoutMethod.delete({ where: { id } });

  // If the deleted method was default, assign default to the next available
  if (existing.isDefault) {
    const nextMethod = await prisma.payoutMethod.findFirst({
      where: { supplierId },
      orderBy: { createdAt: 'desc' }
    });
    if (nextMethod) {
      await prisma.payoutMethod.update({
        where: { id: nextMethod.id },
        data: { isDefault: true }
      });
    }
  }

  await logActivity({
    userId: supplierId,
    action: 'payout_method.deleted',
    resource: 'PayoutMethod',
    resourceId: id,
    metadata: { type: existing.type }
  });

  res.status(200).json({
    status: 'success',
    message: 'Payout method deleted'
  });
});

/**
 * Admin: get all payout methods for a specific supplier
 */
exports.getSupplierMethods = catchAsync(async (req, res, next) => {
  const { supplierId } = req.params;

  const supplier = await prisma.user.findUnique({
    where: { id: supplierId },
    select: { id: true, name: true, email: true, supplierProfile: true }
  });

  if (!supplier || !supplier.supplierProfile) {
    return next(new AppError('Supplier not found', 404));
  }

  const methods = await prisma.payoutMethod.findMany({
    where: { supplierId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }]
  });

  res.status(200).json({
    status: 'success',
    data: { supplier, methods }
  });
});

/**
 * Admin: list all suppliers with their payout methods (finance dashboard)
 */
exports.getAllSuppliersMethods = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 20, hasMethod } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const where = {
    supplierProfile: { isNot: null }
  };

  const [suppliers, totalCount] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        supplierProfile: {
          select: {
            status: true,
            totalEarnings: true,
            totalBookings: true,
            businessInfo: true,
            payoutInfo: true
          }
        },
        payoutMethods: {
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }]
        }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit)
    }),
    prisma.user.count({ where })
  ]);

  // Optionally filter to only those with at least one payout method
  let filtered = suppliers;
  if (hasMethod === 'true') {
    filtered = suppliers.filter(s => s.payoutMethods.length > 0);
  } else if (hasMethod === 'false') {
    filtered = suppliers.filter(s => s.payoutMethods.length === 0);
  }

  const totalPages = Math.ceil(totalCount / parseInt(limit));

  res.status(200).json({
    status: 'success',
    data: {
      suppliers: filtered,
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
 * Admin: verify a supplier's payout method
 */
exports.verifyPayoutMethod = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const adminId = req.user.id;
  const { verified = true } = req.body;

  const method = await prisma.payoutMethod.findUnique({
    where: { id },
    include: { supplier: { select: { id: true, name: true, email: true } } }
  });

  if (!method) {
    return next(new AppError('Payout method not found', 404));
  }

  if (method.verified === verified) {
    return next(new AppError(`Payout method is already ${verified ? 'verified' : 'unverified'}`, 400));
  }

  const updated = await prisma.payoutMethod.update({
    where: { id },
    data: { verified }
  });

  const action = verified ? 'payout_method.verified' : 'payout_method.unverified';

  enqueueNotification({
    userId: method.supplierId,
    type: 'SYSTEM_ALERT',
    title: verified ? 'Payout Method Verified' : 'Payout Method Unverified',
    message: verified
      ? `Your ${method.type.replace('_', ' ')} payout method has been verified by the finance team.`
      : `Your ${method.type.replace('_', ' ')} payout method was marked as unverified. Please contact support.`,
    data: { methodId: method.id, type: method.type, verified }
  }).catch(() => {});

  await logActivity({
    userId: adminId,
    action,
    resource: 'PayoutMethod',
    resourceId: method.id,
    metadata: {
      supplierId: method.supplierId,
      type: method.type,
      verified
    }
  });

  res.status(200).json({
    status: 'success',
    data: { method: updated }
  });
});

module.exports = exports;
