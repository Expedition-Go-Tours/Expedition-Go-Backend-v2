const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { enqueueNotification, enqueueEmail } = require('../utils/queue');
const { notifyAdmin } = require('../utils/adminNotificationService');
const { logActivity } = require('../utils/auditLogger');
const getConfig = require('../utils/getConfig');

/**
 * Get payout history for the authenticated supplier
 */
exports.getMyPayouts = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 20, status } = req.query;

  const where = { supplierId: req.supplierId };
  if (status) where.status = status;

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [payouts, totalCount, summary] = await Promise.all([
    prisma.payout.findMany({
      where,
      include: {
        booking: {
          select: {
            bookingNumber: true,
            grossAmount: true,
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
      where: { supplierId: req.supplierId },
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
  const { page = 1, limit = 20, status, search, startDate, endDate, supplierId } = req.query;

  const where = {};
  if (status) where.status = status;
  if (supplierId) where.supplierId = supplierId;
  if (startDate || endDate) {
    where.OR = [
      { paidAt: {} },
      { createdAt: {} }
    ];
    if (startDate) {
      where.OR[0].paidAt.gte = new Date(startDate);
      where.OR[1].createdAt.gte = new Date(startDate);
    }
    if (endDate) {
      where.OR[0].paidAt.lte = new Date(endDate);
      where.OR[1].createdAt.lte = new Date(endDate);
    }
  }
  if (search) {
    const term = search.trim();
    if (term) {
      where.AND = [
        {
          OR: [
            { supplier: { name: { contains: term, mode: 'insensitive' } } },
            { supplier: { email: { contains: term, mode: 'insensitive' } } },
            { booking: { bookingNumber: { contains: term, mode: 'insensitive' } } }
          ]
        }
      ];
    }
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [payouts, totalCount, summary, statusCounts, requestInFlight] = await Promise.all([
    prisma.payout.findMany({
      where,
      include: {
        supplier: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            photoURL: true,
            supplierProfile: {
              select: {
                status: true,
                payoutInfo: true,
                businessInfo: true,
              }
            }
          }
        },
        booking: {
          select: {
            bookingNumber: true,
            grossAmount: true,
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
    }),
    prisma.payout.groupBy({
      by: ['status'],
      _count: { _all: true }
    }),
    // Finance v2: batch withdrawal requests that haven't been paid out yet.
    // These never appear as Payout ledger rows until an admin marks the
    // request as sent, so surface them here to keep the register complete.
    prisma.payoutRequest.groupBy({
      by: ['status'],
      where: { status: { in: ['PROCESSING', 'APPROVED'] } },
      _count: { _all: true },
      _sum: { amount: true }
    })
  ]);

  const totalPages = Math.ceil(totalCount / parseInt(limit));
  const counts = { PENDING: 0, APPROVED: 0, PROCESSING: 0, PAID: 0, FAILED: 0, CANCELLED: 0 };
  statusCounts.forEach((row) => {
    if (counts[row.status] !== undefined) counts[row.status] = row._count._all;
  });

  const inFlight = { awaitingApproval: { count: 0, total: 0 }, approvedAwaitingTransfer: { count: 0, total: 0 } };
  requestInFlight.forEach((row) => {
    if (row.status === 'PROCESSING') {
      inFlight.awaitingApproval.count = row._count._all;
      inFlight.awaitingApproval.total = parseFloat(row._sum.amount || 0);
    } else if (row.status === 'APPROVED') {
      inFlight.approvedAwaitingTransfer.count = row._count._all;
      inFlight.approvedAwaitingTransfer.total = parseFloat(row._sum.amount || 0);
    }
  });

  res.status(200).json({
    status: 'success',
    data: {
      payouts,
      statusCounts: counts,
      inFlight,
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

  // Check payout meets minimum threshold from system config
  const minThreshold = parseFloat(await getConfig('payout.min_threshold', '0'));
  if (parseFloat(payout.amount) < minThreshold) {
    return next(new AppError(
      `Payout amount (${payout.currency} ${parseFloat(payout.amount).toFixed(2)}) is below the minimum threshold of ${payout.currency} ${minThreshold.toFixed(2)}`,
      400
    ));
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
  }).catch((err) => console.error('[Notification] enqueueNotification failed:', err.message));

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

  enqueueEmail({
    type: 'supplier-payout-scheduled',
    bookingId: payout.bookingId,
    data: {
      payout: {
        amount: payout.amount,
        id: payout.id,
        methodLabel: payout.paymentMethod ? payout.paymentMethod.replace('_', ' ') : '',
      },
      payoutDate: new Date().toISOString(),
    },
  }).catch((err) => console.error('[Email] Payout approved email failed:', err.message));

  res.status(200).json({
    status: 'success',
    data: { payout: updated }
  });
});

/**
 * Release a payout (admin only) — moves APPROVED → PROCESSING.
 * The payment is initiated (in transit); a separate settle action confirms
 * the funds actually landed. Records which specific payout method was used
 * for a complete audit trail.
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

  // totalEarnings was already incremented in handlePaymentSucceeded, no double-counting
  const [updated] = await prisma.$transaction([
    prisma.payout.update({
      where: { id },
      data: {
        status: 'PROCESSING',
        processedBy: adminId,
        processedAt: new Date(),
        payoutMethodId: method.id,
        paymentMethod,
        reference: reference || null,
        notes: notes || null
      }
    })
  ]);

  enqueueNotification({
    userId: payout.supplierId,
    type: 'PAYOUT_PROCESSED',
    title: 'Payout In Transit',
    message: `Your payout of ${payout.currency} ${payout.amount} is being sent via ${method.type.replace('_', ' ')} and will reflect shortly.`,
    data: { payoutId: payout.id, amount: payout.amount, paymentMethod, payoutMethodId: method.id }
  }).catch((err) => console.error('[Notification] enqueueNotification failed:', err.message));

  enqueueEmail({
    type: 'supplier-payout-scheduled',
    bookingId: payout.bookingId,
    data: {
      payout: {
        amount: payout.amount,
        id: payout.id,
        methodLabel: method.type.replace('_', ' '),
      },
      payoutDate: new Date().toISOString(),
    },
  }).catch((err) => console.error('[Email] Payout released email failed:', err.message));

  await notifyAdmin({
    type: 'PAYOUT_NEEDS_APPROVAL',
    title: 'Payout In Transit',
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
 * Settle a payout (admin only) — moves PROCESSING → PAID.
 * Confirms the funds have been received by the supplier.
 */
exports.settlePayout = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const adminId = req.user.id;
  const { reference, notes } = req.body;

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

  if (payout.status !== 'PROCESSING') {
    return next(new AppError('Only processing payouts can be settled', 400));
  }

  const updated = await prisma.payout.update({
    where: { id },
    data: {
      status: 'PAID',
      paidAt: new Date(),
      processedBy: adminId,
      processedAt: new Date(),
      reference: reference || payout.reference || null,
      notes: notes || payout.notes || null
    }
  });

  enqueueNotification({
    userId: payout.supplierId,
    type: 'PAYOUT_PROCESSED',
    title: 'Payout Paid',
    message: `Your payout of ${payout.currency} ${payout.amount} has been sent via ${(payout.paymentMethod || 'your payout method').replace('_', ' ')}.`,
    data: { payoutId: payout.id, amount: payout.amount, paymentMethod: payout.paymentMethod }
  }).catch((err) => console.error('[Notification] enqueueNotification failed:', err.message));

  enqueueEmail({
    type: 'supplier-payout-completed',
    bookingId: payout.bookingId,
    data: {
      payout: {
        amount: payout.amount,
        id: payout.id,
        methodLabel: payout.paymentMethod ? payout.paymentMethod.replace('_', ' ') : '',
      },
      payoutDate: new Date().toISOString(),
    },
  }).catch((err) => console.error('[Email] Payout settled email failed:', err.message));

  await notifyAdmin({
    type: 'PAYOUT_NEEDS_APPROVAL',
    title: 'Payout Settled',
    message: `${payout.supplier.name}: Payout of ${payout.currency} ${payout.amount} was confirmed paid`,
    data: { payoutId: payout.id, supplierId: payout.supplierId, amount: payout.amount, action: 'settled' },
  });

  await logActivity({
    userId: adminId,
    action: 'payout.settled',
    resource: 'Payout',
    resourceId: payout.id,
    metadata: {
      supplierId: payout.supplierId,
      amount: payout.amount,
      paymentMethod: payout.paymentMethod,
      payoutMethodId: payout.payoutMethodId,
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
  }).catch((err) => console.error('[Notification] enqueueNotification failed:', err.message));

  enqueueEmail({
    type: 'supplier-payout-failed',
    bookingId: payout.bookingId,
    data: {
      payout: { amount: payout.amount, id: payout.id },
      reason,
    },
  }).catch((err) => console.error('[Email] Payout failed email failed:', err.message));

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
  const [pending, approved, processing, failed, paidThisMonth, monthlyBreakdown, requestStages, outstandingFromBookings] = await Promise.all([
    prisma.payout.aggregate({
      where: { status: 'PENDING' },
      _count: true,
      _sum: { amount: true }
    }),
    prisma.payout.aggregate({
      where: { status: 'APPROVED' },
      _count: true,
      _sum: { amount: true }
    }),
    prisma.payout.aggregate({
      where: { status: 'PROCESSING' },
      _count: true,
      _sum: { amount: true }
    }),
    prisma.payout.aggregate({
      where: { status: 'FAILED' },
      _count: true,
      _sum: { amount: true }
    }),
    prisma.payout.aggregate({
      where: {
        status: 'PAID',
        paidAt: {
          gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
        }
      },
      _sum: { amount: true, commissionAmount: true },
      _count: true
    }),
    prisma.$queryRaw`
      SELECT
        DATE_TRUNC('month', "paidAt") as month,
        COUNT(*)::int as count,
        SUM("amount") as "totalAmount",
        SUM("commissionAmount") as commission
      FROM "Payout"
      WHERE "status" = 'PAID'
        AND "paidAt" >= NOW() - INTERVAL '12 months'
      GROUP BY DATE_TRUNC('month', "paidAt")
      ORDER BY month DESC
    `,
    prisma.payoutRequest.groupBy({
      by: ['status'],
      where: { status: { in: ['PROCESSING', 'APPROVED'] } },
      _count: { _all: true },
      _sum: { amount: true }
    }),
    prisma.$queryRaw`
      SELECT
        COALESCE(SUM(b."supplierPayout"), 0)::float AS "totalOwed",
        COUNT(*)::int AS "bookingCount"
      FROM "Booking" b
      WHERE b."paymentStatus" = 'SUCCEEDED'
        AND NOT EXISTS (
          SELECT 1 FROM "Payout" p WHERE p."bookingId" = b.id AND p."status" = 'PAID'
        )
    `
  ]);

  const paidCount = paidThisMonth._count;
  const paidTotal = paidThisMonth._sum.amount || 0;
  const paidCommission = paidThisMonth._sum.commissionAmount || 0;
  const approvedTotal = approved._sum.amount || 0;
  const processingTotal = processing._sum.amount || 0;

  const requests = { awaitingApproval: { count: 0, total: 0 }, approvedAwaitingTransfer: { count: 0, total: 0 } };
  requestStages.forEach((row) => {
    if (row.status === 'PROCESSING') {
      requests.awaitingApproval.count = row._count._all;
      requests.awaitingApproval.total = parseFloat(row._sum.amount || 0);
    } else if (row.status === 'APPROVED') {
      requests.approvedAwaitingTransfer.count = row._count._all;
      requests.approvedAwaitingTransfer.total = parseFloat(row._sum.amount || 0);
    }
  });

  res.status(200).json({
    status: 'success',
    data: {
      pending: {
        count: pending._count,
        total: pending._sum.amount || 0
      },
      approved: {
        count: approved._count,
        total: approvedTotal
      },
      processing: {
        count: processing._count,
        total: processingTotal
      },
      failed: {
        count: failed._count,
        total: failed._sum.amount || 0
      },
      outstanding: {
        count: outstandingFromBookings[0]?.bookingCount || 0,
        total: outstandingFromBookings[0]?.totalOwed || 0
      },
      paidThisMonth: {
        count: paidCount,
        total: paidTotal,
        commission: paidCommission
      },
      avgCommission: paidCount ? paidCommission / paidTotal : 0,
      monthlyBreakdown,
      requests
    }
  });
});

/**
 * Export payouts as CSV (admin only)
 */
exports.exportPayouts = catchAsync(async (req, res, next) => {
  const { status, supplierId, startDate, endDate, search } = req.query;

  const where = {};
  if (status) where.status = status;
  if (supplierId) where.supplierId = supplierId;
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }
  const term = search?.trim();
  if (term) {
    where.AND = [
      {
        OR: [
          { supplier: { name: { contains: term, mode: 'insensitive' } } },
          { supplier: { email: { contains: term, mode: 'insensitive' } } },
          { booking: { bookingNumber: { contains: term, mode: 'insensitive' } } }
        ]
      }
    ];
  }

  const payouts = await prisma.payout.findMany({
    where,
    include: {
      supplier: { select: { name: true, email: true } },
      booking: {
        select: {
          bookingNumber: true,
          grossAmount: true,
          tour: { select: { title: true } }
        }
      },
      payoutMethod: {
        select: { type: true, bankName: true, paypalEmail: true }
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
