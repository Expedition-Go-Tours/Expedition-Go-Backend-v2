/**
 * Stays rate-plan endpoints behind the Availability → Rate plans, Pricing per
 * guest and Child rates sections.
 *
 * Rate plans remain in `StayProperty.data.ratePlans` (they are edited by the
 * builder and by the bookings controller), so focused mutations rewrite that
 * JSON array under a row lock. The lock matters: pricing-per-guest and child
 * rates are separate forms on separate pages, and without it the second save
 * would overwrite the first with a stale snapshot.
 */

const catchAsync = require('../../core/services/catchAsync');
const AppError = require('../../core/services/appError');
const {
  supplierIdFor,
  findOwnedProperty,
  withLockedProperty,
  objectOrEmpty,
} = require('./staysShared');

function propertyRooms(property) {
  const data = objectOrEmpty(property.data);
  return {
    rooms: Array.isArray(data.rooms) ? data.rooms : [],
    ratePlans: Array.isArray(data.ratePlans) ? data.ratePlans : [],
    currency: typeof data.currency === 'string' && data.currency ? data.currency : 'GHS',
  };
}

exports.listRatePlans = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const property = await findOwnedProperty(req.params.id, supplierId);
  const { rooms, ratePlans, currency } = propertyRooms(property);

  res.status(200).json({
    status: 'success',
    data: {
      propertyId: property.id,
      propertyName: property.name,
      currency,
      rooms,
      ratePlans,
    },
  });
});

/**
 * Apply a partial update to one plan without replacing its other fields.
 * Returns the saved plan and the property currency for the page header.
 */
async function mutatePlan({ req, mutate }) {
  const supplierId = supplierIdFor(req);

  return withLockedProperty(req.params.id, supplierId, async (tx, property) => {
    const data = objectOrEmpty(property.data);
    const plans = Array.isArray(data.ratePlans) ? [...data.ratePlans] : [];
    const index = plans.findIndex((plan) => plan.id === req.params.planId);
    if (index === -1) throw new AppError('Rate plan not found', 404);

    const current = plans[index];
    const next = { ...current, ...mutate(current) };
    plans[index] = next;

    await tx.stayProperty.update({
      where: { id: property.id },
      data: { data: { ...data, ratePlans: plans } },
    });

    return {
      ratePlan: next,
      currency: typeof data.currency === 'string' && data.currency ? data.currency : 'GHS',
    };
  });
}

exports.updateGuestPricing = catchAsync(async (req, res) => {
  const body = req.body || {};
  const result = await mutatePlan({
    req,
    mutate: () => {
      const update = {};
      if (body.baseGuests !== undefined) update.baseGuests = Number(body.baseGuests);
      if (body.singleGuestDiscount !== undefined) {
        update.singleGuestDiscount = Number(body.singleGuestDiscount);
      }
      if (body.extraAdult !== undefined) update.extraAdult = Number(body.extraAdult);
      return update;
    },
  });

  res.status(200).json({ status: 'success', data: result });
});

exports.updateChildPricing = catchAsync(async (req, res) => {
  const body = req.body || {};
  const result = await mutatePlan({
    req,
    mutate: () => ({ extraChild: Number(body.extraChild) }),
  });

  res.status(200).json({ status: 'success', data: result });
});

// Exported for unit tests.
exports._private = { propertyRooms };
