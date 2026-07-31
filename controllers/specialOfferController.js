const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { logActivity } = require('../utils/auditLogger');
const cache = require('../utils/cacheHelper');

function computeStatus(offer) {
  const now = new Date();
  if (!offer.isActive) return 'inactive';
  if (offer.startDate && now < new Date(offer.startDate)) return 'scheduled';
  if (offer.endDate && now > new Date(offer.endDate)) return 'expired';
  return 'active';
}

exports.createOffer = catchAsync(async (req, res, next) => {
  const supplierId = req.supplierId;
  const {
    name, offerType, discountType, discountPercentage, fixedDiscountValue,
    startDate, endDate, isActive, capacityType, maxSpots,
    timeSlotMode, specificWeekdays, targets,
    earlyBirdAdvanceDays, lastMinuteWindowHours,
    promoCode, minQuantity, minSpendAmount, maxRedemptionsPerCustomer, stackable,
  } = req.body;

  if (!name || !name.trim()) return next(new AppError('Offer name is required', 400));
  if (!offerType) return next(new AppError('Offer type is required', 400));
  if (offerType === 'LIMITED_TIME') {
    if (!startDate || !endDate) return next(new AppError('Start and end dates are required', 400));
    if (new Date(startDate) >= new Date(endDate)) return next(new AppError('Start date must be before end date', 400));
  }
  if (!targets || targets.length === 0) return next(new AppError('At least one target product is required', 400));

  const dType = discountType || 'PERCENTAGE';
  if (dType === 'PERCENTAGE') {
    if (!discountPercentage || discountPercentage < 1 || discountPercentage > 100)
      return next(new AppError('Discount percentage must be between 1 and 100', 400));
  } else {
    if (!fixedDiscountValue || fixedDiscountValue <= 0)
      return next(new AppError('Fixed discount value must be greater than 0', 400));
  }

  if (offerType === 'EARLY_BIRD' && earlyBirdAdvanceDays !== undefined && (earlyBirdAdvanceDays < 1 || earlyBirdAdvanceDays > 365))
    return next(new AppError('Early bird advance days must be between 1 and 365', 400));
  if (offerType === 'LAST_MINUTE' && lastMinuteWindowHours !== undefined && (lastMinuteWindowHours < 1 || lastMinuteWindowHours > 720))
    return next(new AppError('Last minute window hours must be between 1 and 720', 400));

  if (promoCode && promoCode.length < 3) return next(new AppError('Promo code must be at least 3 characters', 400));
  if (promoCode) {
    const existing = await prisma.specialOffer.findUnique({ where: { promoCode } });
    if (existing) return next(new AppError('Promo code already in use', 409));
  }

  const offer = await prisma.$transaction(async (tx) => {
    const created = await tx.specialOffer.create({
      data: {
        supplierId,
        name: name.trim(),
        offerType,
        discountType: dType,
        discountPercentage: dType === 'PERCENTAGE' ? discountPercentage : 0,
        fixedDiscountValue: dType === 'FIXED_AMOUNT' ? fixedDiscountValue : null,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        isActive: isActive !== false,
        capacityType: capacityType || 'UNLIMITED',
        maxSpots: capacityType === 'CAPPED' ? (maxSpots || null) : null,
        timeSlotMode: timeSlotMode || 'ALL_DAYS',
        specificWeekdays: specificWeekdays || [],
        earlyBirdAdvanceDays: offerType === 'EARLY_BIRD' ? (earlyBirdAdvanceDays || 7) : null,
        lastMinuteWindowHours: offerType === 'LAST_MINUTE' ? (lastMinuteWindowHours || 72) : null,
        promoCode: promoCode || null,
        minQuantity: minQuantity || null,
        minSpendAmount: minSpendAmount || null,
        maxRedemptionsPerCustomer: maxRedemptionsPerCustomer || null,
        stackable: stackable || false,
        targets: {
          create: targets.map((t) => ({
            tourId: t.tourId,
            tourOptionKey: t.tourOptionKey || null,
            tourOptionLabel: t.tourOptionLabel || null,
          })),
        },
      },
      include: { targets: { include: { tour: { select: { id: true, title: true, photos: true, schedulesAndPricing: true } } } } },
    });
    return created;
  });

  cache.invalidateTourCaches();
  await logActivity({
    userId: req.user.id, action: 'special-offer.created', resource: 'SpecialOffer', resourceId: offer.id,
    newValues: { name, offerType, discountType: dType, discountPercentage, fixedDiscountValue },
  });

  // Targeted invalidation: clear caches only for affected tours
  const tourIds = offer.targets?.map((t) => t.tourId).filter(Boolean) || [];
  for (const tid of tourIds) {
    cache.invalidateKey(cache.TOUR_DETAIL_PREFIX(tid)).catch(() => {});
  }

  res.status(201).json({ status: 'success', data: { offer } });
});

exports.getOffers = catchAsync(async (req, res, next) => {
  const supplierId = req.supplierId;
  const { productId, optionKey, activeOnly } = req.query;

  const where = { supplierId };
  if (productId) where.targets = { some: { tourId: productId } };
  if (optionKey) where.targets = { some: { tourOptionKey: optionKey } };

  const offers = await prisma.specialOffer.findMany({
    where,
    include: {
      targets: {
        include: {
          tour: { select: { id: true, title: true, photos: true, coverPhoto: true, schedulesAndPricing: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  let result = offers.map((o) => ({ ...o, status: computeStatus(o) }));
  if (activeOnly === 'true') result = result.filter((o) => o.status === 'active');

  res.json({ status: 'success', data: { offers: result } });
});

exports.getOffer = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const offer = await prisma.specialOffer.findFirst({
    where: { id, supplierId: req.supplierId },
    include: {
      targets: {
        include: {
          tour: { select: { id: true, title: true, photos: true, coverPhoto: true, schedulesAndPricing: true } },
        },
      },
    },
  });

  if (!offer) return next(new AppError('Offer not found', 404));
  res.json({ status: 'success', data: { offer: { ...offer, status: computeStatus(offer) } } });
});

exports.updateOffer = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const existing = await prisma.specialOffer.findFirst({ where: { id, supplierId: req.supplierId } });
  if (!existing) return next(new AppError('Offer not found', 404));

  const {
    name, offerType, discountType, discountPercentage, fixedDiscountValue,
    startDate, endDate, isActive, capacityType, maxSpots,
    timeSlotMode, specificWeekdays, targets,
    earlyBirdAdvanceDays, lastMinuteWindowHours,
    promoCode, minQuantity, minSpendAmount, maxRedemptionsPerCustomer, stackable,
  } = req.body;

  if (startDate && endDate && new Date(startDate) >= new Date(endDate))
    return next(new AppError('Start date must be before end date', 400));

  const dType = discountType || existing.discountType;
  if (discountPercentage !== undefined && dType === 'PERCENTAGE' && (discountPercentage < 1 || discountPercentage > 100))
    return next(new AppError('Discount percentage must be between 1 and 100', 400));
  if (fixedDiscountValue !== undefined && dType === 'FIXED_AMOUNT' && fixedDiscountValue <= 0)
    return next(new AppError('Fixed discount value must be greater than 0', 400));

  if (earlyBirdAdvanceDays != null && (earlyBirdAdvanceDays < 1 || earlyBirdAdvanceDays > 365))
    return next(new AppError('Early bird advance days must be between 1 and 365', 400));
  if (lastMinuteWindowHours != null && (lastMinuteWindowHours < 1 || lastMinuteWindowHours > 720))
    return next(new AppError('Last minute window hours must be between 1 and 720', 400));

  if (promoCode && promoCode.length < 3) return next(new AppError('Promo code must be at least 3 characters', 400));
  if (promoCode && promoCode !== existing.promoCode) {
    const taken = await prisma.specialOffer.findUnique({ where: { promoCode } });
    if (taken) return next(new AppError('Promo code already in use', 409));
  }

  const offer = await prisma.$transaction(async (tx) => {
    if (targets) {
      await tx.specialOfferTarget.deleteMany({ where: { specialOfferId: id } });
      await tx.specialOfferTarget.createMany({
        data: targets.map((t) => ({
          specialOfferId: id,
          tourId: t.tourId,
          tourOptionKey: t.tourOptionKey || null,
          tourOptionLabel: t.tourOptionLabel || null,
        })),
      });
    }

    const updated = await tx.specialOffer.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(offerType !== undefined && { offerType }),
        ...(discountType !== undefined && { discountType }),
        ...(discountPercentage !== undefined && { discountPercentage: dType === 'PERCENTAGE' ? discountPercentage : 0 }),
        ...(fixedDiscountValue !== undefined && { fixedDiscountValue: dType === 'FIXED_AMOUNT' ? fixedDiscountValue : null }),
        ...(startDate !== undefined && { startDate: new Date(startDate) }),
        ...(endDate !== undefined && { endDate: new Date(endDate) }),
        ...(isActive !== undefined && { isActive }),
        ...(capacityType !== undefined && { capacityType }),
        ...(maxSpots !== undefined && { maxSpots: capacityType === 'CAPPED' ? maxSpots : null }),
        ...(timeSlotMode !== undefined && { timeSlotMode }),
        ...(specificWeekdays !== undefined && { specificWeekdays }),
        ...(earlyBirdAdvanceDays !== undefined && { earlyBirdAdvanceDays }),
        ...(lastMinuteWindowHours !== undefined && { lastMinuteWindowHours }),
        ...(promoCode !== undefined && { promoCode: promoCode || null }),
        ...(minQuantity !== undefined && { minQuantity }),
        ...(minSpendAmount !== undefined && { minSpendAmount }),
        ...(maxRedemptionsPerCustomer !== undefined && { maxRedemptionsPerCustomer }),
        ...(stackable !== undefined && { stackable }),
      },
      include: { targets: { include: { tour: { select: { id: true, title: true, photos: true, schedulesAndPricing: true } } } } },
    });
    return updated;
  });

  cache.invalidateTourCaches();
  await logActivity({
    userId: req.user.id, action: 'special-offer.updated', resource: 'SpecialOffer', resourceId: id,
    oldValues: { name: existing.name }, newValues: { name },
  });

  // Targeted invalidation: clear caches only for affected tours
  const updatedTourIds = offer.targets?.map((t) => t.tourId).filter(Boolean) || [];
  const existingTourIds = existing.targets?.map((t) => t.tourId).filter(Boolean) || [];
  const allTourIds = [...new Set([...updatedTourIds, ...existingTourIds])];
  for (const tid of allTourIds) {
    cache.invalidateKey(cache.TOUR_DETAIL_PREFIX(tid)).catch(() => {});
  }

  res.json({ status: 'success', data: { offer: { ...offer, status: computeStatus(offer) } } });
});

exports.deleteOffer = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const existing = await prisma.specialOffer.findFirst({
    where: { id, supplierId: req.supplierId },
    include: { targets: { select: { tourId: true } } },
  });
  if (!existing) return next(new AppError('Offer not found', 404));

  await prisma.specialOffer.delete({ where: { id } });
  cache.invalidateTourCaches();
  await logActivity({
    userId: req.user.id,
    action: 'special-offer.deleted',
    resource: 'SpecialOffer',
    resourceId: id,
    oldValues: {
      name: existing.name,
      isActive: existing.isActive,
      offerType: existing.offerType,
      discountType: existing.discountType,
      discountPercentage: existing.discountPercentage,
      fixedDiscountValue: existing.fixedDiscountValue,
      startDate: existing.startDate,
      endDate: existing.endDate,
    },
  });

  // Targeted invalidation: clear caches only for affected tours
  const deletedTourIds = existing.targets?.map((t) => t.tourId).filter(Boolean) || [];
  for (const tid of deletedTourIds) {
    cache.invalidateKey(cache.TOUR_DETAIL_PREFIX(tid)).catch(() => {});
  }

  res.json({ status: 'success', message: 'Offer deleted' });
});

exports.toggleOffer = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const offer = await prisma.specialOffer.findFirst({
    where: { id, supplierId: req.supplierId },
    include: { targets: { select: { tourId: true } } },
  });
  if (!offer) return next(new AppError('Offer not found', 404));

  const updated = await prisma.specialOffer.update({
    where: { id },
    data: { isActive: !offer.isActive },
  });

  cache.invalidateTourCaches();
  await logActivity({
    userId: req.user.id, action: 'special-offer.toggled', resource: 'SpecialOffer', resourceId: id,
    newValues: { isActive: updated.isActive },
  });

  // Targeted invalidation: clear caches only for affected tours
  const toggledTourIds = offer.targets?.map((t) => t.tourId).filter(Boolean) || [];
  for (const tid of toggledTourIds) {
    cache.invalidateKey(cache.TOUR_DETAIL_PREFIX(tid)).catch(() => {});
  }

  res.json({ status: 'success', data: { offer: { ...updated, status: computeStatus(updated) } } });
});
