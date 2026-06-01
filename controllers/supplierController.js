/**
 * Supplier Controller - Production Ready
 * Handles supplier-specific operations
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');

exports.getPayouts = catchAsync(async (req, res, next) => {
  const userId = req.user.id;
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