const { COUNTED_SOURCES, combineExternalStats, combineTourStats } = require('./externalReviewCombine');

/**
 * Compute the denormalized combined fields (in-app + counted external) for a
 * tour about to be written. Kept in the same transaction as the rating write
 * so Tour.combinedRating / combinedReviewCount can never drift from the
 * internal stats.
 */
async function combinedFieldsFor(tx, tourId, averageRating, reviewCount) {
  const external = await tx.tourExternalReviewStat.findMany({
    where: { tourId, source: { in: COUNTED_SOURCES } },
    select: { source: true, rating: true, reviewCount: true, distribution: true },
  });

  const combined = combineTourStats(averageRating, reviewCount, combineExternalStats(external));
  return {
    combinedRating: combined.reviewCount > 0 ? combined.rating : null,
    combinedReviewCount: combined.reviewCount,
  };
}

async function addApprovedRating(tx, tourId, rating) {
  const tour = await tx.tour.findUnique({
    where: { id: tourId },
    select: { averageRating: true, reviewCount: true }
  });

  const oldCount = tour.reviewCount;
  const oldAvg = parseFloat(tour.averageRating || 0);
  const newCount = oldCount + 1;
  const sum = (oldAvg * oldCount) + rating;
  const newAvg = Math.round((sum / newCount) * 100) / 100;

  const combined = await combinedFieldsFor(tx, tourId, newAvg, newCount);

  await tx.tour.update({
    where: { id: tourId },
    data: { averageRating: newAvg, reviewCount: newCount, ...combined }
  });
}

async function removeApprovedRating(tx, tourId, rating) {
  const tour = await tx.tour.findUnique({
    where: { id: tourId },
    select: { averageRating: true, reviewCount: true }
  });

  const oldCount = tour.reviewCount;

  if (oldCount <= 1) {
    const combined = await combinedFieldsFor(tx, tourId, null, 0);
    await tx.tour.update({
      where: { id: tourId },
      data: { averageRating: null, reviewCount: 0, ...combined }
    });
    return;
  }

  const oldAvg = parseFloat(tour.averageRating || 0);
  const newCount = oldCount - 1;
  const sum = (oldAvg * oldCount) - rating;
  const newAvg = Math.round((sum / newCount) * 100) / 100;

  const combined = await combinedFieldsFor(tx, tourId, newAvg, newCount);

  await tx.tour.update({
    where: { id: tourId },
    data: { averageRating: newAvg, reviewCount: newCount, ...combined }
  });
}

async function updateApprovedRating(tx, tourId, oldRating, newRating) {
  const tour = await tx.tour.findUnique({
    where: { id: tourId },
    select: { averageRating: true, reviewCount: true }
  });

  const count = tour.reviewCount;
  const oldAvg = parseFloat(tour.averageRating || 0);
  const sum = (oldAvg * count) - oldRating + newRating;
  const newAvg = Math.round((sum / count) * 100) / 100;

  const combined = await combinedFieldsFor(tx, tourId, newAvg, count);

  await tx.tour.update({
    where: { id: tourId },
    data: { averageRating: newAvg, ...combined }
  });
}

async function recalculateSupplierRating(tx, supplierId) {
  const stats = await tx.review.aggregate({
    where: {
      tour: { supplierId },
      status: 'APPROVED'
    },
    _avg: { rating: true }
  });

  await tx.supplierProfile.update({
    where: { userId: supplierId },
    data: { averageRating: stats._avg.rating }
  });
}

module.exports = {
  addApprovedRating,
  removeApprovedRating,
  updateApprovedRating,
  recalculateSupplierRating
};
