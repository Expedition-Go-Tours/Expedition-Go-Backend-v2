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

  await tx.tour.update({
    where: { id: tourId },
    data: { averageRating: newAvg, reviewCount: newCount }
  });
}

async function removeApprovedRating(tx, tourId, rating) {
  const tour = await tx.tour.findUnique({
    where: { id: tourId },
    select: { averageRating: true, reviewCount: true }
  });

  const oldCount = tour.reviewCount;

  if (oldCount <= 1) {
    await tx.tour.update({
      where: { id: tourId },
      data: { averageRating: null, reviewCount: 0 }
    });
    return;
  }

  const oldAvg = parseFloat(tour.averageRating || 0);
  const newCount = oldCount - 1;
  const sum = (oldAvg * oldCount) - rating;
  const newAvg = Math.round((sum / newCount) * 100) / 100;

  await tx.tour.update({
    where: { id: tourId },
    data: { averageRating: newAvg, reviewCount: newCount }
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

  await tx.tour.update({
    where: { id: tourId },
    data: { averageRating: newAvg }
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
