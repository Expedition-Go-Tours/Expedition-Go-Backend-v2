const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const prisma = require('../utils/prismaClient');
const { upsertAttraction, selectHeroImage } = require('../utils/aiContentAnalyzer');

/**
 * GET /admin/attractions
 * List all attractions with metadata.
 */
exports.getAttractions = catchAsync(async (req, res) => {
  const attractions = await prisma.attraction.findMany({
    orderBy: [
      { isFeatured: 'desc' },
      { tourCount: 'desc' },
    ],
  });

  res.json({ status: 'success', data: { attractions } });
});

/**
 * PATCH /admin/attractions/:id
 * Update an attraction — manual image override, featured flag, etc.
 */
exports.updateAttraction = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const { heroImage, isFeatured, manualOverride } = req.body;

  const attraction = await prisma.attraction.findUnique({ where: { id } });
  if (!attraction) return next(new AppError('Attraction not found', 404));

  const updateData = {};

  if (heroImage !== undefined) {
    updateData.heroImage = heroImage;
    updateData.heroImageSource = 'manual';
    updateData.manualOverride = true;
  }

  if (isFeatured !== undefined) {
    updateData.isFeatured = Boolean(isFeatured);
  }

  if (manualOverride !== undefined) {
    updateData.manualOverride = Boolean(manualOverride);
    if (!manualOverride) {
      // Re-select image via AI when unlocking
      const imageSelection = await selectHeroImage(attraction.name);
      Object.assign(updateData, imageSelection);
    }
  }

  const updated = await prisma.attraction.update({
    where: { id },
    data: updateData,
  });

  // Invalidate homepage cache
  try {
    const { invalidateHomepageCaches } = require('../utils/cacheHelper');
    await invalidateHomepageCaches();
  } catch { /* non-fatal */ }

  res.json({ status: 'success', data: { attraction: updated } });
});

/**
 * POST /admin/attractions/:id/recompute
 * Force AI re-selection of hero image for an attraction.
 */
exports.recomputeAttraction = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const attraction = await prisma.attraction.findUnique({ where: { id } });
  if (!attraction) return next(new AppError('Attraction not found', 404));

  if (attraction.manualOverride) {
    return next(new AppError('Cannot recompute: attraction has manual override. Remove override first.', 400));
  }

  await upsertAttraction(attraction.name, {});

  const refreshed = await prisma.attraction.findUnique({ where: { id } });

  // Invalidate homepage cache
  try {
    const { invalidateHomepageCaches } = require('../utils/cacheHelper');
    await invalidateHomepageCaches();
  } catch { /* non-fatal */ }

  res.json({ status: 'success', data: { attraction: refreshed } });
});
