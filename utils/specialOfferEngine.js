const prisma = require('./prismaClient');

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function getDayName(date) {
  return WEEKDAY_NAMES[new Date(date).getDay()];
}

function hoursBefore(dateA, dateB) {
  return Math.round((new Date(dateB) - new Date(dateA)) / (1000 * 60 * 60));
}

function daysBefore(dateA, dateB) {
  return Math.round((new Date(dateB) - new Date(dateA)) / (1000 * 60 * 60 * 24));
}

async function findApplicableOffers({ tourId, tourOptionKey, selectedDate, promoCode, customerId }) {
  const where = {
    isActive: true,
    targets: {
      some: {
        tourId,
        ...(tourOptionKey ? { tourOptionKey } : {}),
      },
    },
  };

  if (promoCode) where.promoCode = promoCode;

  const offers = await prisma.specialOffer.findMany({
    where,
    include: {
      targets: {
        where: {
          tourId,
          ...(tourOptionKey ? { tourOptionKey } : {}),
        },
      },
    },
  });

  const filtered = offers.filter((offer) => {
    if (offer.startDate && new Date(selectedDate) < new Date(offer.startDate)) return false;
    if (offer.endDate && new Date(selectedDate) > new Date(offer.endDate)) return false;

    const dayName = getDayName(selectedDate);
    if (offer.timeSlotMode === 'SPECIFIC_WEEKDAYS' && !offer.specificWeekdays.includes(dayName)) {
      return false;
    }

    if (offer.capacityType === 'CAPPED' && offer.maxSpots !== null && offer.spotsSold >= offer.maxSpots) {
      return false;
    }

    return true;
  });

  if (customerId) {
    const eligible = [];
    for (const offer of filtered) {
      if (offer.maxRedemptionsPerCustomer) {
        const count = await prisma.booking.count({
          where: {
            customerId,
            appliedOfferId: offer.id,
            status: { in: ['CONFIRMED', 'PENDING'] },
          },
        });
        if (count >= offer.maxRedemptionsPerCustomer) continue;
      }
      eligible.push(offer);
    }
    return eligible;
  }

  return filtered;
}

async function findBestDiscount({ tourId, tourOptionKey, selectedDate, basePrice, promoCode, quantity, customerId }) {
  const offers = await findApplicableOffers({ tourId, tourOptionKey, selectedDate, promoCode, customerId });

  if (offers.length === 0) return { discountAmount: 0, finalPrice: basePrice, appliedOffer: null, discountType: null };

  const now = new Date();
  const diffHours = hoursBefore(now, selectedDate);
  const diffDays = daysBefore(now, selectedDate);

  const valid = offers.filter((offer) => {
    if (offer.offerType === 'EARLY_BIRD') {
      const minDays = offer.earlyBirdAdvanceDays || 7;
      if (diffDays < minDays) return false;
    }
    if (offer.offerType === 'LAST_MINUTE') {
      const maxHours = offer.lastMinuteWindowHours || 72;
      if (diffHours > maxHours) return false;
    }
    if (offer.minQuantity && (!quantity || quantity < offer.minQuantity)) return false;
    if (offer.minSpendAmount && basePrice < offer.minSpendAmount) return false;
    return true;
  });

  if (valid.length === 0) return { discountAmount: 0, finalPrice: basePrice, appliedOffer: null, discountType: null };

  const stackableOffers = valid.filter((o) => o.stackable);
  if (stackableOffers.length > 1) {
    let totalDiscount = 0;
    const appliedOffers = [];
    for (const o of stackableOffers) {
      let disc;
      if (o.discountType === 'PERCENTAGE') {
        disc = Math.round(basePrice * (o.discountPercentage / 100) * 100) / 100;
      } else {
        disc = Math.min(o.fixedDiscountValue || 0, basePrice);
      }
      if (totalDiscount + disc <= basePrice) {
        totalDiscount += disc;
        appliedOffers.push({
          id: o.id,
          name: o.name,
          offerType: o.offerType,
          discountType: o.discountType,
          discountPercentage: o.discountPercentage,
          fixedDiscountValue: o.fixedDiscountValue,
        });
      }
    }
    if (totalDiscount > 0) {
      const finalPrice = Math.round((basePrice - totalDiscount) * 100) / 100;
      return {
        discountAmount: totalDiscount,
        discountPercentage: null,
        discountType: 'STACKED',
        finalPrice,
        appliedOffer: appliedOffers.length === 1 ? appliedOffers[0] : appliedOffers,
      };
    }
  }

  const best = valid.reduce((max, o) => {
    const maxDiscount = max.discountType === 'PERCENTAGE'
      ? basePrice * (max.discountPercentage / 100)
      : (max.fixedDiscountValue || 0);
    const oDiscount = o.discountType === 'PERCENTAGE'
      ? basePrice * (o.discountPercentage / 100)
      : (o.fixedDiscountValue || 0);
    return oDiscount > maxDiscount ? o : max;
  }, valid[0]);

  let discountAmount;
  if (best.discountType === 'PERCENTAGE') {
    discountAmount = Math.round(basePrice * (best.discountPercentage / 100) * 100) / 100;
  } else {
    discountAmount = Math.min(best.fixedDiscountValue || 0, basePrice);
  }

  const finalPrice = Math.round((basePrice - discountAmount) * 100) / 100;

  return {
    discountAmount,
    discountPercentage: best.discountType === 'PERCENTAGE' ? best.discountPercentage : null,
    discountType: best.discountType,
    finalPrice,
    appliedOffer: {
      id: best.id,
      name: best.name,
      offerType: best.offerType,
      discountType: best.discountType,
      discountPercentage: best.discountPercentage,
      fixedDiscountValue: best.fixedDiscountValue,
    },
  };
}

module.exports = { findApplicableOffers, findBestDiscount };
