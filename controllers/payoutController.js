const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { enqueueNotification, enqueueEmail } = require('../utils/queue');
const { notifyAdmin } = require('../utils/adminNotificationService');
const { logActivity } = require('../utils/auditLogger');

/**
 * Get payout history for the authenticated supplier
 */
exports.getMyPayouts = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 20, status } = req.query;

  const where = { supplierId: req.user.id };
  if (status) where.status = status;

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [payouts, totalCount, summary] = await Promise.all([
    prisma.payout.findMany({
      where,
      include: {
        booking: {
          select: {
            bookingNumber: true,
            total: true,
            tour: { select: { title: true } }
          }
        },
        payoutMethod: {
          select: {
            id: true,
            type: true,
            bankName: true,
            bankCountry: true,
            accountName: true,
            accountNumber: true,
            sortCode: true,
            branchCode: true,
            swiftCode: true,
            mobileProvider: true,
            mobileNumber: true,
            paypalEmail: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit)
    }),
    prisma.payout.count({ where }),
    prisma.payout.aggregate({
      where: { supplierId: req.user.id },
      _sum: { amount: true },
      _count: true
    })
  ]);

  const totalPages = Math.ceil(totalCount / parseInt(limit));

  res.status(200).json({
    status: 'success',
    data: {
      payouts,
      summary: {
        totalEarned: summary._sum.amount || 0,
        totalPayouts: summary._count
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

/**
 * Get all pending/approved payouts (admin only)
 */
exports.getAllPayouts = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 20, status } = req.query;

  const where = {};
  if (status) where.status = status;

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [payouts, totalCount, summary] = await Promise.all([
    prisma.payout.findMany({
      where,
      include: {
        supplier: {
          select: {
            id: true,
            name: true,
            email: true,
            supplierProfile: {
              select: { payoutInfo: true }
            }
          }
        },
        booking: {
          select: {
            bookingNumber: true,
            total: true,
            paidAt: true,
            tour: { select: { title: true } }
          }
        },
        payoutMethod: {
          select: {
            id: true,
            type: true,
            verified: true,
            bankName: true,
            bankCountry: true,
            accountName: true,
            accountNumber: true,
            sortCode: true,
            branchCode: true,
            swiftCode: true,
            mobileProvider: true,
            mobileNumber: true,
            paypalEmail: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit)
    }),
    prisma.payout.count({ where }),
    prisma.payout.aggregate({
      where,
      _sum: { amount: true, commissionAmount: true },
      _count: true
    })
  ]);

  const totalPages = Math.ceil(totalCount / parseInt(limit));

  res.status(200).json({
    status: 'success',
    data: {
      payouts,
      summary: {
        totalAmount: summary._sum.amount || 0,
        totalCommission: summary._sum.commissionAmount || 0,
        totalCount: summary._count
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

/**
 * Approve a payout (admin only) — moves from PENDING → APPROVED
 */
exports.approvePayout = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const adminId = req.user.id;

  const payout = await prisma.payout.findUnique({
    where: { id },
    include: {
      supplier: { select: { id: true, name: true, email: true } },
      booking: {
        select: { tour: { select: { title: true } } }
      }
    }
  });

  if (!payout) {
    return next(new AppError('Payout not found', 404));
  }

  if (payout.status !== 'PENDING') {
    return next(new AppError('Only pending payouts can be approved', 400));
  }

  const updated = await prisma.payout.update({
    where: { id },
    data: {
      status: 'APPROVED',
      approvedAt: new Date(),
      approvedBy: adminId
    }
  });

  enqueueNotification({
    userId: payout.supplierId,
    type: 'PAYOUT_APPROVED',
    title: 'Payout Approved',
    message: `${payout.booking?.tour?.title || 'Tour'}: Your payout of ${payout.currency} ${payout.amount} has been approved and is being processed.`,
    data: { payoutId: payout.id, amount: payout.amount }
  }).catch(() => {});

  await notifyAdmin({
    type: 'PAYOUT_NEEDS_APPROVAL',
    title: 'Payout Approved',
    message: `${payout.supplier.name}: Payout of ${payout.currency} ${payout.amount} for "${payout.booking?.tour?.title || 'Tour'}" was approved`,
    data: { payoutId: payout.id, supplierId: payout.supplierId, amount: payout.amount, action: 'approved' },
  });

  await logActivity({
    userId: adminId,
    action: 'payout.approved',
    resource: 'Payout',
    resourceId: payout.id,
    metadata: {
      supplierId: payout.supplierId,
      amount: payout.amount,
      currency: payout.currency
    }
  });

  const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';

  enqueueEmail({
    to: payout.supplier.email,
    subject: 'Payout Approved - Travio Africa',
    template: 'payout-notification',
    data: {
      title: 'Payout Approved',
      message: `Your payout of ${payout.currency} ${payout.amount} has been approved and is being processed.`,
      statusLabel: 'Approved',
      supplierName: payout.supplier.name,
      tourTitle: payout.booking?.tour?.title || '',
      payoutAmount: payout.amount,
      currency: payout.currency,
      payoutDate: new Date().toISOString(),
      payoutId: payout.id,
      dashboardUrl: `${CLIENT_URL}/supplier/earnings`
    }
  }).catch(() => {});

  res.status(200).json({
    status: 'success',
    data: { payout: updated }
  });
});

/**
 * Mark payout as paid (admin only) — moves APPROVED → PAID
 * Records which specific payout method was used for a complete audit trail.
 */
exports.releasePayout = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const adminId = req.user.id;
  const { payoutMethodId, reference, notes } = req.body;

  const payout = await prisma.payout.findUnique({
    where: { id },
    include: {
      supplier: { select: { id: true, name: true, email: true } },
      booking: {
        select: { tour: { select: { title: true } } }
      }
    }
  });

  if (!payout) {
    return next(new AppError('Payout not found', 404));
  }

  if (payout.status !== 'APPROVED') {
    return next(new AppError('Only approved payouts can be released', 400));
  }

  // Resolve which payout method to use
  let method;
  if (payoutMethodId) {
    method = await prisma.payoutMethod.findFirst({
      where: { id: payoutMethodId, supplierId: payout.supplierId, verified: true }
    });
    if (!method) {
      return next(new AppError('Payout method not found, does not belong to this supplier, or is not verified', 400));
    }
  } else {
    method = await prisma.payoutMethod.findFirst({
      where: { supplierId: payout.supplierId, verified: true },
      orderBy: { isDefault: 'desc' }
    });
    if (!method) {
      return next(new AppError('Supplier has no verified payout method. Please verify their payout method first.', 400));
    }
  }

  const paymentMethod = method.type;

  const updated = await prisma.payout.update({
    where: { id },
    data: {
      status: 'PAID',
      paidAt: new Date(),
      processedBy: adminId,
      processedAt: new Date(),
      payoutMethodId: method.id,
      paymentMethod,
      reference: reference || null,
      notes: notes || null
    }
  });

  enqueueNotification({
    userId: payout.supplierId,
    type: 'PAYOUT_PROCESSED',
    title: 'Payout Completed',
    message: `Your payout of ${payout.currency} ${payout.amount} has been sent via ${method.type.replace('_', ' ')}.`,
    data: { payoutId: payout.id, amount: payout.amount, paymentMethod, payoutMethodId: method.id }
  }).catch(() => {});

  const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';

  enqueueEmail({
    to: payout.supplier.email,
    subject: 'Payout Released - Travio Africa',
    template: 'payout-notification',
    data: {
      supplierName: payout.supplier.name,
      tourTitle: payout.booking?.tour?.title || '',
      payoutAmount: payout.amount,
      currency: payout.currency,
      payoutDate: new Date().toISOString(),
      payoutId: payout.id,
      payoutMethod: method.type.replace('_', ' '),
      dashboardUrl: `${CLIENT_URL}/supplier/earnings`
    }
  }).catch(() => {});

  await notifyAdmin({
    type: 'PAYOUT_NEEDS_APPROVAL',
    title: 'Payout Released',
    message: `${payout.supplier.name}: Payout of ${payout.currency} ${payout.amount} was released via ${method.type.replace('_', ' ')}`,
    data: { payoutId: payout.id, supplierId: payout.supplierId, amount: payout.amount, action: 'released' },
  });

  await logActivity({
    userId: adminId,
    action: 'payout.released',
    resource: 'Payout',
    resourceId: payout.id,
    metadata: {
      supplierId: payout.supplierId,
      amount: payout.amount,
      paymentMethod,
      payoutMethodId: method.id,
      reference
    }
  });

  res.status(200).json({
    status: 'success',
    data: { payout: updated }
  });
});

/**
 * Mark payout as failed (admin only)
 */
exports.failPayout = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const adminId = req.user.id;
  const { reason } = req.body;

  const payout = await prisma.payout.findUnique({
    where: { id },
    include: {
      supplier: { select: { id: true, name: true, email: true } },
      booking: {
        select: { tour: { select: { title: true } } }
      }
    }
  });

  if (!payout) {
    return next(new AppError('Payout not found', 404));
  }

  if (!['APPROVED', 'PROCESSING'].includes(payout.status)) {
    return next(new AppError('Only approved or processing payouts can be marked as failed', 400));
  }

  const updated = await prisma.payout.update({
    where: { id },
    data: {
      status: 'FAILED',
      processedBy: adminId,
      processedAt: new Date(),
      notes: reason || 'Payment failed'
    }
  });

  enqueueNotification({
    userId: payout.supplierId,
    type: 'SYSTEM_ALERT',
    title: 'Payout Failed',
    message: `Your payout of ${payout.currency} ${payout.amount} has failed. Please contact support.`,
    data: { payoutId: payout.id, reason }
  }).catch(() => {});

  const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';

  enqueueEmail({
    to: payout.supplier.email,
    subject: 'Payout Failed - Travio Africa',
    template: 'payout-notification',
    data: {
      title: 'Payout Failed',
      message: `Your payout of ${payout.currency} ${payout.amount} has failed. Please contact support for more information.`,
      statusLabel: 'Failed',
      statusColor: '#FEF2F2',
      statusTextColor: '#DC2626',
      supplierName: payout.supplier.name,
      tourTitle: payout.booking?.tour?.title || '',
      payoutAmount: payout.amount,
      currency: payout.currency,
      payoutDate: new Date().toISOString(),
      payoutId: payout.id,
      dashboardUrl: `${CLIENT_URL}/supplier/earnings`
    }
  }).catch(() => {});

  await notifyAdmin({
    type: 'PAYOUT_NEEDS_APPROVAL',
    title: 'Payout Failed',
    message: `${payout.supplier.name}: Payout of ${payout.currency} ${payout.amount} for "${payout.booking?.tour?.title || 'Tour'}" failed${reason ? ` — ${reason}` : ''}`,
    data: { payoutId: payout.id, supplierId: payout.supplierId, amount: payout.amount, action: 'failed', reason },
  });

  await logActivity({
    userId: adminId,
    action: 'payout.failed',
    resource: 'Payout',
    resourceId: payout.id,
    metadata: {
      supplierId: payout.supplierId,
      amount: payout.amount,
      reason
    }
  });

  res.status(200).json({
    status: 'success',
    data: { payout: updated }
  });
});

/**
 * Get payout summary / stats for the admin dashboard
 */
exports.getPayoutSummary = catchAsync(async (req, res, next) => {
  const [pendingCount, pendingTotal, paidThisMonth, monthlyBreakdown] = await Promise.all([
    prisma.payout.count({ where: { status: 'PENDING' } }),
    prisma.payout.aggregate({
      where: { status: 'PENDING' },
      _sum: { amount: true }
    }),
    prisma.payout.aggregate({
      where: {
        status: 'PAID',
        paidAt: {
          gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
        }
      },
      _sum: { amount: true },
      _count: true
    }),
    prisma.$queryRaw`
      SELECT
        DATE_TRUNC('month', "paidAt") as month,
        COUNT(*) as count,
        SUM("amount") as total
      FROM "Payout"
      WHERE "status" = 'PAID'
        AND "paidAt" >= NOW() - INTERVAL '12 months'
      GROUP BY DATE_TRUNC('month', "paidAt")
      ORDER BY month DESC
    `
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      pending: {
        count: pendingCount,
        total: pendingTotal._sum.amount || 0
      },
      paidThisMonth: {
        count: paidThisMonth._count,
        total: paidThisMonth._sum.amount || 0
      },
      monthlyBreakdown
    }
  });
});

/**
 * Export payouts as CSV (admin only)
 */
exports.exportPayouts = catchAsync(async (req, res, next) => {
  const { status, supplierId, startDate, endDate } = req.query;

  const where = {};
  if (status) where.status = status;
  if (supplierId) where.supplierId = supplierId;
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  const payouts = await prisma.payout.findMany({
    where,
    include: {
      supplier: { select: { name: true, email: true } },
      booking: {
        select: {
          bookingNumber: true,
          total: true,
          tour: { select: { title: true } }
        }
      },
      payoutMethod: {
        select: { type: true, bankName: true, mobileProvider: true, paypalEmail: true }
      }
    },
    orderBy: { createdAt: 'desc' }
  });

  const headers = [
    'ID', 'Supplier Name', 'Supplier Email', 'Booking Number',
    'Tour Title', 'Amount', 'Currency', 'Commission', 'Status',
    'Payment Method', 'Method Detail', 'Reference', 'Notes',
    'Created At', 'Approved At', 'Paid At'
  ];

  const rows = payouts.map(p => {
    let methodDetail = '';
    if (p.payoutMethod) {
      if (p.payoutMethod.type === 'BANK_TRANSFER') methodDetail = p.payoutMethod.bankName || '';
      else if (p.payoutMethod.type === 'MOBILE_MONEY') methodDetail = p.payoutMethod.mobileProvider || '';
      else if (p.payoutMethod.type === 'PAYPAL') methodDetail = p.payoutMethod.paypalEmail || '';
    }

    return [
      p.id,
      p.supplier.name,
      p.supplier.email,
      p.booking?.bookingNumber || '',
      p.booking?.tour?.title || '',
      p.amount.toString(),
      p.currency,
      p.commissionAmount.toString(),
      p.status,
      p.paymentMethod || '',
      methodDetail,
      p.reference || '',
      p.notes || '',
      p.createdAt.toISOString(),
      p.approvedAt ? p.approvedAt.toISOString() : '',
      p.paidAt ? p.paidAt.toISOString() : ''
    ];
  });

  const csvEscape = (val) => {
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(csvEscape).join(','))
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="payouts-${new Date().toISOString().split('T')[0]}.csv"`);
  res.status(200).send(csvContent);
});

module.exports = exports;
