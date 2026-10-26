/**
 * Stays special offers — supplier CRUD.
 *
 * A parallel model to tour SpecialOffer because the targets are properties and
 * rooms, not tours and options. Responses use the supplier dashboard's shapes:
 * save returns the full refreshed list, toggle returns the single offer.
 */

const prisma = require('../../core/services/prismaClient');
const AppError = require('../../core/services/appError');
const catchAsync = require('../../core/services/catchAsync');
const {
  supplierIdFor,
  objectOrEmpty,
  serializeStayOffer,
  stayOfferInclude,
} = require('./staysShared');

const OFFER_TYPES = new Set(['LIMITED_TIME', 'EARLY_BIRD', 'LAST_MINUTE']);
const DISCOUNT_TYPES = new Set(['PERCENTAGE', 'FIXED_AMOUNT']);
const CAPACITY_TYPES = new Set(['UNLIMITED', 'CAPPED']);
const TIME_SLOT_MODES = new Set(['ALL_DAYS', 'SPECIFIC_WEEKDAYS']);

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function optionalInt(value, min = 0) {
  const number = optionalNumber(value);
  if (number === null) return null;
  const int = Math.trunc(number);
  return int >= min ? int : null;
}

function dateOrNull(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00.000Z`);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function normalizeTargets(rawTargets, supplierId) {
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
    throw new AppError('At least one property or room is required', 400);
  }

  const propertyIds = [...new Set(rawTargets.map((target) => target?.propertyId).filter(Boolean))];
  if (propertyIds.length === 0) {
    throw new AppError('At least one property or room is required', 400);
  }

  const properties = await prisma.stayProperty.findMany({
    where: { id: { in: propertyIds }, supplierId, status: { not: 'ARCHIVED' } },
  });
  const byId = new Map(properties.map((property) => [property.id, property]));

  const seen = new Set();
  const targets = [];

  for (const target of rawTargets) {
    const property = byId.get(target?.propertyId);
    if (!property) throw new AppError('Offer target property not found', 400);

    const data = objectOrEmpty(property.data);
    const rooms = Array.isArray(data.rooms) ? data.rooms : [];
    const roomId = target.roomId || null;
    const room = roomId ? rooms.find((row) => row.id === roomId) : null;
    if (roomId && !room) throw new AppError('Offer target room not found', 400);

    const key = `${property.id}|${roomId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    targets.push({
      propertyId: property.id,
      propertyName: property.name,
      roomId,
      roomLabel: room ? room.name || room.kind || null : null,
    });
  }

  return targets;
}

function buildOfferData(body, existing = null) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new AppError('Offer name is required', 400);

  const offerType = String(body.offerType || existing?.offerType || 'LIMITED_TIME').toUpperCase();
  if (!OFFER_TYPES.has(offerType)) throw new AppError('Invalid offer type', 400);

  const discountType = String(body.discountType || existing?.discountType || 'PERCENTAGE').toUpperCase();
  if (!DISCOUNT_TYPES.has(discountType)) throw new AppError('Invalid discount type', 400);

  const capacityType = String(body.capacityType || existing?.capacityType || 'UNLIMITED').toUpperCase();
  if (!CAPACITY_TYPES.has(capacityType)) throw new AppError('Invalid capacity type', 400);

  const timeSlotMode = String(body.timeSlotMode || existing?.timeSlotMode || 'ALL_DAYS').toUpperCase();
  if (!TIME_SLOT_MODES.has(timeSlotMode)) throw new AppError('Invalid weekday mode', 400);

  const startDate = body.startDate !== undefined ? dateOrNull(body.startDate) : existing?.startDate || null;
  const endDate = body.endDate !== undefined ? dateOrNull(body.endDate) : existing?.endDate || null;
  if (startDate && endDate && endDate < startDate) {
    throw new AppError('Offer end date cannot be before its start date', 400);
  }

  const discountPercentage = optionalInt(body.discountPercentage, 0);
  const fixedDiscountValue = optionalNumber(body.fixedDiscountValue);
  if (discountType === 'PERCENTAGE') {
    const pct = discountPercentage === null ? (existing?.discountPercentage ?? 10) : discountPercentage;
    if (pct < 0 || pct > 100) throw new AppError('Discount percentage must be between 0 and 100', 400);
  } else if (fixedDiscountValue !== null && fixedDiscountValue < 0) {
    throw new AppError('Fixed discount cannot be negative', 400);
  }

  const maxSpots = optionalInt(body.maxSpots, 1);
  if (capacityType === 'CAPPED' && maxSpots === null) {
    throw new AppError('Set the maximum number of spots for a capped offer', 400);
  }

  const promoCode = typeof body.promoCode === 'string' && body.promoCode.trim()
    ? body.promoCode.trim()
    : null;

  return {
    name,
    offerType,
    discountType,
    discountPercentage: discountPercentage === null ? 10 : discountPercentage,
    fixedDiscountValue,
    startDate,
    endDate,
    isActive: body.isActive === undefined ? (existing?.isActive ?? true) : Boolean(body.isActive),
    capacityType,
    maxSpots: capacityType === 'CAPPED' ? maxSpots : null,
    timeSlotMode,
    specificWeekdays: Array.isArray(body.specificWeekdays)
      ? body.specificWeekdays.map((day) => String(day).toLowerCase())
      : (existing?.specificWeekdays || []),
    earlyBirdAdvanceDays: optionalInt(body.earlyBirdAdvanceDays, 1),
    lastMinuteWindowHours: optionalInt(body.lastMinuteWindowHours, 1),
    promoCode,
    minQuantity: optionalInt(body.minQuantity, 1),
    minSpendAmount: optionalNumber(body.minSpendAmount),
    maxRedemptionsPerCustomer: optionalInt(body.maxRedemptionsPerCustomer, 1),
    stackable: Boolean(body.stackable),
  };
}

async function assertPromoCodeFree(promoCode, supplierId, selfId = null) {
  if (!promoCode) return;
  const existing = await prisma.stayOffer.findFirst({
    where: {
      promoCode,
      ...(selfId ? { NOT: { id: selfId } } : {}),
    },
    select: { id: true, supplierId: true },
  });
  if (existing) throw new AppError('That promo code is already in use', 400);
}

async function listAllOffers(supplierId) {
  const rows = await prisma.stayOffer.findMany({
    where: { supplierId },
    include: stayOfferInclude,
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(serializeStayOffer);
}

exports.listOffers = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const filter = String(req.query?.filter || 'All').toLowerCase();
  let offers = await listAllOffers(supplierId);
  if (filter !== 'all') offers = offers.filter((offer) => offer.status === filter);
  res.status(200).json({ status: 'success', data: { offers } });
});

exports.getOffer = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const offer = await prisma.stayOffer.findFirst({
    where: { id: req.params.id, supplierId },
    include: stayOfferInclude,
  });
  if (!offer) throw new AppError('Offer not found', 404);
  res.status(200).json({ status: 'success', data: { offer: serializeStayOffer(offer) } });
});

exports.saveOffer = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const body = objectOrEmpty(req.body);
  const offerId = req.params.id || body.id || null;

  const existing = offerId
    ? await prisma.stayOffer.findFirst({ where: { id: offerId, supplierId } })
    : null;
  if (offerId && !existing) throw new AppError('Offer not found', 404);

  const fields = buildOfferData(body, existing);
  await assertPromoCodeFree(fields.promoCode, supplierId, existing?.id || null);
  const targets = await normalizeTargets(body.targets, supplierId);

  await prisma.$transaction(async (tx) => {
    if (existing) {
      await tx.stayOffer.update({ where: { id: existing.id }, data: fields });
      await tx.stayOfferTarget.deleteMany({ where: { stayOfferId: existing.id } });
      await tx.stayOfferTarget.createMany({
        data: targets.map((target) => ({ ...target, stayOfferId: existing.id })),
      });
    } else {
      await tx.stayOffer.create({
        data: {
          ...fields,
          supplierId,
          targets: { create: targets },
        },
      });
    }
  });

  res.status(200).json({
    status: 'success',
    data: { offers: await listAllOffers(supplierId) },
  });
});

exports.toggleOffer = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const existing = await prisma.stayOffer.findFirst({
    where: { id: req.params.id, supplierId },
    select: { id: true, isActive: true },
  });
  if (!existing) throw new AppError('Offer not found', 404);

  const offer = await prisma.stayOffer.update({
    where: { id: existing.id },
    data: { isActive: !existing.isActive },
    include: stayOfferInclude,
  });

  res.status(200).json({ status: 'success', data: { offer: serializeStayOffer(offer) } });
});

exports.deleteOffer = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const deleted = await prisma.stayOffer.deleteMany({
    where: { id: req.params.id, supplierId },
  });
  if (!deleted.count) throw new AppError('Offer not found', 404);
  res.status(200).json({ status: 'success', data: { ok: true } });
});
