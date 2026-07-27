const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { deleteCloudinaryImage, isValidCloudinaryUrl } = require('../utils/cloudinaryHelper');

exports.cleanupPending = catchAsync(async (req, res, next) => {
  const { urls } = req.body;

  if (!Array.isArray(urls) || urls.length === 0) {
    return next(new AppError('Provide an array of URLs to clean up', 400));
  }

  const validUrls = urls.filter(isValidCloudinaryUrl);
  if (validUrls.length === 0) {
    return res.status(200).json({ status: 'success', data: { deleted: 0 } });
  }

  const pending = await prisma.media.findMany({
    where: { url: { in: validUrls }, status: 'PENDING' },
  });

  await Promise.allSettled(pending.map(m => deleteCloudinaryImage(m.url)));

  await prisma.media.updateMany({
    where: { id: { in: pending.map(m => m.id) } },
    data: { status: 'ORPHANED' },
  });

  res.status(200).json({
    status: 'success',
    data: { deleted: pending.length },
  });
});

exports.cleanupOrphaned = catchAsync(async (req, res, next) => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const orphaned = await prisma.media.findMany({
    where: { status: 'PENDING', createdAt: { lt: cutoff } },
  });

  await Promise.allSettled(orphaned.map(m => deleteCloudinaryImage(m.url)));

  await prisma.media.updateMany({
    where: { id: { in: orphaned.map(m => m.id) } },
    data: { status: 'ORPHANED' },
  });

  res.status(200).json({
    status: 'success',
    data: { cleaned: orphaned.length },
  });
});
