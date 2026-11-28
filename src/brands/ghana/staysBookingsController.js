/**
 * Stays bookings — supplier-facing reservations and cancellation reporting.
 *
 * There is no customer stays checkout yet, so the primary writer today is the
 * supplier-created booking endpoint (walk-in / phone reservations). The same
 * table will hold customer bookings when the storefront ships.
 */

const prisma = require('../../core/services/prismaClient');
const AppError = require('../../core/services/appError');
const catchAsync = require('../../core/services/catchAsync');
const { generateBookingNumber } = require('../../core/services/bookingHelpers');
const { calculateCommission } = require('../../core/services/stripeHelpers');
const { enqueueNotification } = require('../../core/services/queue');
const chatService = require('../../core/services/chatService');
const {
  BOOKING_TRANSITIONS,
  supplierIdFor,
  objectOrEmpty,
  dateKey,
  parseDateKey,
  addDays,
  nightsBetween,
  enumBookingStatus,
  displayBookingStatus,
  serializeStayBooking,
  stayBookingInclude,
} = require('./staysShared');

const MAX_BOOKINGS = 500;

/**
 * Stays notifications are tagged with the product domain so the Stays bell can
 * request domain=STAYS and never surface tour activity.
 */
function enqueueStayNotification({ userId, type, title, message, booking }) {
  return enqueueNotification({
    userId,
    type,
    title,
    message,
    domain: 'STAYS',
    data: {
      domain: 'STAYS',
      bookingId: booking.id,
      stayBookingId: booking.id,
      bookingNumber: booking.bookingNumber,
      propertyId: booking.propertyId,
      propertyName: booking.property?.name || '',
      guestName: booking.guestName,
    },
  }).catch((err) => {
    console.error('[Stays] booking notification failed:', err.message);
  });
}

function parseGuestName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseGuests(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return 1;
  return Math.min(Math.trunc(number), 50);
}

/** Normalise the new adult/child payload while keeping `guests` backwards compatible. */
function parseTravellers(body) {
  const totalGuests = parseGuests(body?.guests);
  const rawAges = Array.isArray(body?.childAges) ? body.childAges : [];
  const requestedChildren = body?.children != null
    ? Math.max(0, Math.trunc(Number(body.children) || 0))
    : rawAges.length;
  const childAges = Array.from({ length: requestedChildren }, (_, index) => {
    const value = rawAges[index];
    if (value === null || value === undefined || value === '') return null;
    const age = Number(value);
    return Number.isFinite(age) && age >= 0 && age <= 17 ? Math.trunc(age) : null;
  });

  const rawAdults = Number(body?.adults);
  const adults = Number.isFinite(rawAdults) && rawAdults >= 1
    ? Math.trunc(rawAdults)
    : Math.max(1, totalGuests - childAges.length);

  return {
    adults,
    childAges,
    totalGuests: Math.max(1, adults + childAges.length),
  };
}

function parseValueAddIds(body) {
  if (!Array.isArray(body?.valueAddIds)) return [];
  return [...new Set(body.valueAddIds.map((value) => String(value)).filter(Boolean))];
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function occupancyLimit(property, room, plan, travellers) {
  const baseGuests = Math.max(1, positiveInt(plan?.baseGuests) || 1);
  const roomLimit = (Number(room.adults) || 0) + (Number(room.children) || 0);
  const propertyLimit = positiveInt(property?.maxGuests) || 0;
  const planLimit = positiveInt(plan?.maxGuests) || 0;
  const limit = Math.max(baseGuests, planLimit || roomLimit || propertyLimit || 10);
  if (travellers.totalGuests > limit) {
    throw new AppError(`This rate plan allows up to ${limit} guest${limit === 1 ? '' : 's'}`, 400);
  }
  return { baseGuests, limit };
}

function occupancyPricing({ base, plan, room, property, travellers, childGroups }) {
  const { baseGuests } = occupancyLimit(property, room, plan, travellers);
  let price = base;
  let adjustment = 0;
  const total = travellers.totalGuests;

  if (total < baseGuests) {
    const discounts = Array.isArray(plan?.occupancyDiscounts) ? plan.occupancyDiscounts : [];
    const row = discounts.find(
      (entry) => Number(entry?.occupancy) === total && entry?.enabled !== false,
    );
    const rawValue = row ? Number(row.value) || 0 : 0;
    const unit = row?.unit === 'amount' ? 'amount' : 'percent';
    const fallbackSingle = !row && total === 1 ? Number(plan?.singleGuestDiscount) || 0 : 0;

    if (row && rawValue > 0) {
      const delta = unit === 'amount' ? Math.min(price, rawValue) : price * (rawValue / 100);
      price -= delta;
      adjustment -= delta;
    } else if (fallbackSingle > 0) {
      const delta = Math.min(price, fallbackSingle);
      price -= delta;
      adjustment -= delta;
    }
  }

  const extraAdults = Math.max(0, travellers.adults - baseGuests);
  const childSlots = Math.max(0, baseGuests - travellers.adults);
  const extraChildren = Math.max(0, travellers.childAges.length - childSlots);
  const extraAdultCharge = extraAdults * (Number(plan?.extraAdult) || 0);
  const extraChildCharge = childGroups.length ? 0 : extraChildren * (Number(plan?.extraChild) || 0);

  price += extraAdultCharge + extraChildCharge;
  adjustment += extraAdultCharge + extraChildCharge;

  return { price: Math.max(0, price), adjustment };
}

function childRateCharges(property, plan, childAges, nightlyBase) {
  const groups = Array.isArray(property?.childRateGroups) ? property.childRateGroups : [];
  let perNight = 0;
  let perStay = 0;

  for (const age of childAges) {
    const group = groups.find(
      (entry) => Number(entry?.minAge) <= Number(age) && Number(entry?.maxAge) >= Number(age),
    );
    if (!group) {
      perNight += Number(plan?.extraChild) || 0;
      continue;
    }
    if (group.rateType === 'free') continue;
    const value = Number(group.value) || 0;
    if (group.rateType === 'percentage') {
      perNight += nightlyBase * (value / 100);
    } else if (String(group.unit || '').toLowerCase().includes('stay')) {
      perStay += value;
    } else {
      perNight += value;
    }
  }

  return { perNight, perStay };
}

function valueAddCharges(property, plan, valueAddIds, totalGuests) {
  if (!valueAddIds.length) return { perNight: 0, once: 0 };
  const adds = Array.isArray(property?.valueAdds) ? property.valueAdds : [];
  const selected = valueAddIds.map((id) => adds.find((entry) => entry.id === id)).filter(Boolean);
  if (selected.length !== valueAddIds.length) {
    throw new AppError('One or more value adds are not available on this property', 400);
  }

  const allowed = Array.isArray(plan?.valueAddIds) && plan.valueAddIds.length
    ? new Set(plan.valueAddIds)
    : null;
  if (allowed && selected.some((entry) => !allowed.has(entry.id))) {
    throw new AppError('One or more value adds are not available on this rate plan', 400);
  }

  let perNight = 0;
  let once = 0;
  for (const add of selected) {
    if (add.active === false || add.isActive === false) continue;
    const price = Number(add.price) || 0;
    const unit = String(add.unit || 'stay').toLowerCase();
    if (unit.includes('night')) perNight += price;
    else if (unit.includes('person') || unit.includes('guest')) once += price * totalGuests;
    else once += price;
  }

  return { perNight, once };
}

function dynamicScopeApplies(scope, roomId, planId) {
  if (!scope) return true;
  const roomOk = scope.allRooms !== false
    ? true
    : Array.isArray(scope.roomIds) && scope.roomIds.includes(roomId);
  const planOk = scope.allRatePlans !== false
    ? true
    : Boolean(planId) && Array.isArray(scope.ratePlanIds) && scope.ratePlanIds.includes(planId);
  return roomOk && planOk;
}

function dynamicRuleActive(rule, today) {
  if (!rule) return false;
  if (rule.endMode === 'date' && rule.endDate) {
    const end = parseDateKey(rule.endDate);
    if (end && today > end) return false;
  }
  return true;
}

function applyPriceChange(price, change) {
  if (!change || change.mode === 'none') return price;
  const value = Number(change.value) || 0;
  if (value <= 0) return price;
  const delta = change.unit === 'amount' ? value : price * (value / 100);
  return Math.max(0, change.mode === 'decrease' ? price - delta : price + delta);
}

function dynamicMinStay(rule) {
  const value = positiveInt(rule?.minStay);
  return value || 1;
}

function formatDisplayDate(value) {
  return new Date(`${value}T00:00:00.000Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

exports.listBookings = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const where = { supplierId };

  const status = enumBookingStatus(req.query?.status);
  if (status) where.status = status;
  if (req.query?.propertyId) where.propertyId = req.query.propertyId;

  const rows = await prisma.stayBooking.findMany({
    where,
    include: stayBookingInclude,
    orderBy: { createdAt: 'desc' },
    take: MAX_BOOKINGS,
  });

  res.status(200).json({
    status: 'success',
    data: { bookings: rows.map(serializeStayBooking) },
  });
});

exports.getBooking = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const booking = await prisma.stayBooking.findFirst({
    where: { id: req.params.id, supplierId },
    include: stayBookingInclude,
  });
  if (!booking) throw new AppError('Booking not found', 404);
  res.status(200).json({
    status: 'success',
    data: { booking: serializeStayBooking(booking) },
  });
});

/** Statuses that occupy a room. CANCELLED / NO_SHOW / COMPLETED release it. */
const ACTIVE_BOOKING_STATUSES = ['NEW', 'CONFIRMED', 'CHECKED_IN'];

/**
 * Arbitrary but stable namespace for the per-room advisory lock. Postgres keyed
 * locks are (namespace, key) pairs; keeping the first component fixed leaves the
 * whole second component free for the room.
 */
const INVENTORY_LOCK_NAMESPACE = 4242;

/**
 * Serialization failures and deadlocks are expected under load, not
 * exceptional: when two transactions touch the same rows, Postgres aborts one
 * rather than admitting both. The correct response is to re-run the loser
 * against the state the winner committed.
 */
const MAX_TRANSACTION_ATTEMPTS = 3;

function isRetryableTransactionError(err) {
  if (!err) return false;
  // Prisma maps 40001 (serialization_failure) and 40P01 (deadlock_detected) to
  // P2034. Raw driver errors keep the SQLSTATE on `code`.
  if (err.code === 'P2034' || err.code === '40001' || err.code === '40P01') return true;
  const message = String(err.message || '');
  return /could not serialize access|deadlock detected|write conflict/i.test(message);
}

async function runInventoryTransaction(fn) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableTransactionError(err)) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Count how many occupied bookings touch each night of a date range.
 *
 * Per-night rather than "one booking overlaps the whole range": a date whose
 * override lowers `count` to 1 must reject a second booking that merely
 * overlaps it, even when the room's base inventory is 5.
 */
function occupiedNights(bookings) {
  const counts = new Map();
  for (const booking of bookings) {
    for (
      let night = new Date(booking.checkIn);
      night < booking.checkOut;
      night = addDays(night, 1)
    ) {
      const key = dateKey(night);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

/**
 * Lowercase weekday names indexed by `Date#getUTCDay()` (0 = Sunday). Stored
 * rules use the same vocabulary as special offers.
 */
const WEEKDAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

function ruleRoomIds(rule) {
  return Array.isArray(rule.roomIds) ? rule.roomIds : [];
}

function ruleAppliesToRoom(rule, roomId) {
  const roomIds = ruleRoomIds(rule);
  return roomIds.length === 0 || roomIds.includes(roomId);
}

function ruleAppliesToDate(rule, date) {
  const key = dateKey(date);
  const start = rule.startDate ? dateKey(rule.startDate) : null;
  const end = rule.endDate ? dateKey(rule.endDate) : null;
  if (start && key < start) return false;
  if (end && key > end) return false;

  const weekdays = Array.isArray(rule.weekdays) ? rule.weekdays : [];
  if (weekdays.length) {
    const weekday = WEEKDAY_NAMES[date.getUTCDay()];
    if (!weekdays.some((day) => String(day).toLowerCase() === weekday)) return false;
  }

  return true;
}

function positiveInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return null;
  return Math.trunc(number);
}

/** Builder payloads historically stored Yes/No strings as well as booleans. */
function booleanFlag(value) {
  return value === true || value === 1 || value === '1' || value === 'Yes' || value === 'true';
}

/**
 * Validate one reservation night by night against the room's base inventory,
 * its per-date overrides, the chosen rate plan's stay restrictions and any
 * active dynamic restriction rule.
 *
 * Returns the authoritative room-and-nights total. Overrides were previously
 * consulted for `closed` only; `count`, `price` and `minStay` were read from
 * the database and then ignored, so a supplier could cut a night's inventory to
 * one room, raise its price, or require a three-night stay, and the booking
 * endpoint would still sell it at the room's base price for a single night.
 *
 * Rate-plan `minStay` / `maxStay` / `closedArrival` / `closedDeparture` are
 * saved by the builder but were never checked here either. The most restrictive
 * minimum and maximum across the plan, matching rules and per-date overrides
 * wins, so a rule can tighten a plan but never loosen it.
 */
async function priceStayNights({
  tx,
  property,
  room,
  plan,
  checkIn,
  checkOut,
  nights,
  travellers,
  valueAddIds,
}) {
  const data = objectOrEmpty(property.data);
  const baseCapacity = Math.max(1, Number(room.count) || 1);
  const baseNightly = Number(plan?.price ?? room.price) || 0;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const checkInKey = dateKey(checkIn);
  const checkOutKey = dateKey(checkOut);
  const childGroups = Array.isArray(data.childRateGroups) ? data.childRateGroups : [];
  const dynamic = objectOrEmpty(data.dynamicRestrictions);
  const unsoldRule = objectOrEmpty(dynamic.unsold);
  const gapRule = objectOrEmpty(dynamic.gap);
  const hasUnsold = Object.keys(unsoldRule).length > 0;
  const hasGap = Object.keys(gapRule).length > 0;
  const unsoldScope = hasUnsold
    && dynamicRuleActive(unsoldRule, today)
    && dynamicScopeApplies(unsoldRule.scope, room.id, plan?.id);
  const gapScope = hasGap
    && dynamicRuleActive(gapRule, today)
    && dynamicScopeApplies(gapRule.scope, room.id, plan?.id);

  const [overrides, overlapping, ruleRows, neighbourBefore, neighbourAfter] = await Promise.all([
    tx.stayAvailabilityOverride.findMany({
      where: {
        propertyId: property.id,
        roomId: room.id,
        date: { gte: checkIn, lte: checkOut },
      },
      select: {
        date: true,
        ratePlanId: true,
        count: true,
        closed: true,
        price: true,
        minStay: true,
        maxStay: true,
        closedArrival: true,
        closedDeparture: true,
      },
    }),
    tx.stayBooking.findMany({
      where: {
        propertyId: property.id,
        roomId: room.id,
        status: { in: ACTIVE_BOOKING_STATUSES },
        checkIn: { lt: checkOut },
        checkOut: { gt: checkIn },
      },
      select: { checkIn: true, checkOut: true, ratePlanId: true },
    }),
    tx.stayRestrictionRule.findMany({
      where: {
        propertyId: property.id,
        isActive: true,
        AND: [
          { OR: [{ startDate: null }, { startDate: { lte: checkOut } }] },
          { OR: [{ endDate: null }, { endDate: { gte: checkIn } }] },
        ],
      },
      select: {
        startDate: true,
        endDate: true,
        weekdays: true,
        roomIds: true,
        minStay: true,
        maxStay: true,
        stopSell: true,
        closedToArrival: true,
        closedToDeparture: true,
      },
    }),
    tx.stayBooking.findFirst({
      where: {
        propertyId: property.id,
        roomId: room.id,
        status: { in: ACTIVE_BOOKING_STATUSES },
        checkOut: { lte: checkIn },
      },
      orderBy: { checkOut: 'desc' },
      select: { checkOut: true },
    }),
    tx.stayBooking.findFirst({
      where: {
        propertyId: property.id,
        roomId: room.id,
        status: { in: ACTIVE_BOOKING_STATUSES },
        checkIn: { gte: checkOut },
      },
      orderBy: { checkIn: 'asc' },
      select: { checkIn: true },
    }),
  ]);

  const roomOverrideByDate = new Map();
  const planOverrideByDate = new Map();
  for (const row of overrides) {
    if (!row.ratePlanId) roomOverrideByDate.set(dateKey(row.date), row);
    else if (plan && row.ratePlanId === plan.id) planOverrideByDate.set(dateKey(row.date), row);
  }

  const rules = ruleRows.filter((rule) => ruleAppliesToRoom(rule, room.id));

  if (booleanFlag(plan?.closedArrival)
    || roomOverrideByDate.get(checkInKey)?.closedArrival
    || planOverrideByDate.get(checkInKey)?.closedArrival) {
    throw new AppError(`Those dates are closed to arrival (${checkInKey})`, 400);
  }
  if (booleanFlag(plan?.closedDeparture)
    || roomOverrideByDate.get(checkOutKey)?.closedDeparture
    || planOverrideByDate.get(checkOutKey)?.closedDeparture) {
    throw new AppError(`Those dates are closed to departure (${checkOutKey})`, 400);
  }

  if (rules.some((rule) => rule.closedToArrival && ruleAppliesToDate(rule, checkIn))) {
    throw new AppError(`Those dates are closed to arrival (${checkInKey})`, 400);
  }
  if (rules.some((rule) => rule.closedToDeparture && ruleAppliesToDate(rule, checkOut))) {
    throw new AppError(`Those dates are closed to departure (${checkOutKey})`, 400);
  }

  let requiredMin = positiveInt(plan?.minStay);
  let requiredMax = positiveInt(plan?.maxStay);
  let minStaySource = checkInKey;
  let maxStaySource = checkInKey;

  const occupied = occupiedNights(overlapping);
  const occupiedPlan = occupiedNights(
    overlapping.filter((booking) => plan && booking.ratePlanId === plan.id),
  );

  const gapBaseMin = positiveInt(plan?.minStay) || 1;
  let gapLength = 0;
  if (neighbourBefore || neighbourAfter) {
    const gapStart = neighbourBefore?.checkOut || checkIn;
    const gapEnd = neighbourAfter?.checkIn || checkOut;
    gapLength = nightsBetween(gapStart, gapEnd);
  }
  const gapPeriod = positiveInt(gapRule.applicablePeriodDays) || 60;
  const gapDaysAhead = nightsBetween(today, checkIn);
  const gapApplies = gapScope
    && (neighbourBefore || neighbourAfter)
    && gapLength > 0
    && gapLength < gapBaseMin
    && gapDaysAhead >= 0
    && gapDaysAhead <= gapPeriod;

  const childStay = childRateCharges(data, plan, travellers.childAges, baseNightly);
  const adds = valueAddCharges(data, plan, valueAddIds, travellers.totalGuests);

  let total = 0;
  let baseSubtotal = 0;
  let dynamicSubtotal = 0;
  let occupancySubtotal = 0;
  let childSubtotal = 0;
  const nightly = [];

  for (let index = 0; index < nights; index += 1) {
    const night = addDays(checkIn, index);
    const key = dateKey(night);
    const roomOverride = roomOverrideByDate.get(key);
    const planOverride = planOverrideByDate.get(key);
    const matchingRules = rules.filter((rule) => ruleAppliesToDate(rule, night));

    if (roomOverride?.closed) {
      throw new AppError(`Those dates are blocked for this room (${key} is closed)`, 400);
    }
    if (planOverride?.closed) {
      throw new AppError(`Those dates are blocked for this rate plan (${key} is closed)`, 400);
    }
    if (matchingRules.some((rule) => rule.stopSell)) {
      throw new AppError(`Those dates are blocked for this room (${key} is closed to sale)`, 400);
    }

    for (const rule of matchingRules) {
      const ruleMin = positiveInt(rule.minStay);
      if (ruleMin !== null && ruleMin > (requiredMin || 0)) {
        requiredMin = ruleMin;
        minStaySource = key;
      }
      const ruleMax = positiveInt(rule.maxStay);
      if (ruleMax !== null && (requiredMax === null || ruleMax < requiredMax)) {
        requiredMax = ruleMax;
        maxStaySource = key;
      }
    }

    const overrideMin = Math.max(
      positiveInt(roomOverride?.minStay) || 0,
      positiveInt(planOverride?.minStay) || 0,
    );
    if (overrideMin > (requiredMin || 0)) {
      requiredMin = overrideMin;
      minStaySource = key;
    }
    for (const overrideMax of [positiveInt(roomOverride?.maxStay), positiveInt(planOverride?.maxStay)]) {
      if (overrideMax !== null && (requiredMax === null || overrideMax < requiredMax)) {
        requiredMax = overrideMax;
        maxStaySource = key;
      }
    }

    const roomCapacity = roomOverride?.count != null
      ? Math.max(0, Number(roomOverride.count))
      : baseCapacity;
    const planCapacity = planOverride?.count != null
      ? Math.min(roomCapacity, Math.max(0, Number(planOverride.count)))
      : roomCapacity;
    const alreadyBooked = occupied.get(key) || 0;
    if (alreadyBooked + 1 > roomCapacity) {
      throw new AppError(`No rooms are available for ${key}`, 400);
    }
    if (plan && (occupiedPlan.get(key) || 0) + 1 > planCapacity) {
      throw new AppError(`No rooms are available on ${plan.name || 'this rate plan'} for ${key}`, 400);
    }

    const nightPrice = planOverride?.price != null
      ? Number(planOverride.price)
      : roomOverride?.price != null
        ? Number(roomOverride.price)
        : baseNightly;
    if (!Number.isFinite(nightPrice) || nightPrice < 0) {
      throw new AppError(`A valid nightly price is required before taking a booking (${key})`, 400);
    }
    baseSubtotal += nightPrice;

    let unsoldApplies = false;
    if (unsoldScope && alreadyBooked < roomCapacity) {
      const daysAhead = nightsBetween(today, night);
      const period = positiveInt(unsoldRule.applicablePeriodDays) || 60;
      const advance = positiveInt(unsoldRule.minAdvanceDays);
      const advanceOk = !advance || nightsBetween(today, checkIn) >= advance;
      if (daysAhead >= 0 && daysAhead <= period && advanceOk) {
        unsoldApplies = true;
        const dynamicMin = dynamicMinStay(unsoldRule);
        requiredMin = requiredMin === null ? dynamicMin : Math.min(requiredMin, dynamicMin);
        minStaySource = key;
      }
    }

    if (gapApplies) {
      const dynamicMin = dynamicMinStay(gapRule);
      requiredMin = requiredMin === null ? dynamicMin : Math.min(requiredMin, dynamicMin);
      minStaySource = key;
    }

    let priceAfterDynamic = nightPrice;
    if (unsoldApplies) priceAfterDynamic = applyPriceChange(priceAfterDynamic, unsoldRule.priceChange);
    if (gapApplies) priceAfterDynamic = applyPriceChange(priceAfterDynamic, gapRule.priceChange);
    dynamicSubtotal += priceAfterDynamic - nightPrice;

    const occupancy = occupancyPricing({
      base: priceAfterDynamic,
      plan,
      room,
      property,
      travellers,
      childGroups,
    });
    occupancySubtotal += occupancy.adjustment;

    const child = childRateCharges(data, plan, travellers.childAges, priceAfterDynamic);
    childSubtotal += child.perNight;

    const nightlyTotal = occupancy.price + child.perNight + adds.perNight;
    total += nightlyTotal;
    nightly.push({
      date: key,
      base: roundMoney(nightPrice),
      dynamic: roundMoney(priceAfterDynamic - nightPrice),
      occupancy: roundMoney(occupancy.adjustment),
      children: roundMoney(child.perNight),
      valueAdds: roundMoney(adds.perNight),
      total: roundMoney(nightlyTotal),
    });
  }

  if (requiredMin !== null && nights < requiredMin) {
    throw new AppError(
      `A minimum stay of ${requiredMin} night(s) applies on ${minStaySource}`,
      400,
    );
  }
  if (requiredMax !== null && nights > requiredMax) {
    throw new AppError(
      `A maximum stay of ${requiredMax} night(s) applies on ${maxStaySource}`,
      400,
    );
  }

  total += childStay.perStay + adds.once;
  childSubtotal += childStay.perStay;
  const valueAddSubtotal = adds.perNight * nights + adds.once;
  const roundedTotal = roundMoney(total);

  return {
    total: roundedTotal,
    currency: typeof data.currency === 'string' && data.currency ? data.currency : 'GHS',
    breakdown: {
      base: roundMoney(baseSubtotal),
      dynamic: roundMoney(dynamicSubtotal),
      occupancy: roundMoney(occupancySubtotal),
      children: roundMoney(childSubtotal),
      valueAdds: roundMoney(valueAddSubtotal),
      total: roundedTotal,
    },
    nightly,
    effectiveMinStay: requiredMin,
    effectiveMaxStay: requiredMax,
  };
}

/**
 * Read-only price quote for the booking form. It shares `priceStayNights` with
 * createBooking so the estimate a supplier sees is exactly what gets charged.
 */
exports.quoteBooking = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const body = objectOrEmpty(req.body);
  if (!body.propertyId) throw new AppError('Property is required', 400);
  if (!body.roomId) throw new AppError('Room is required', 400);

  const checkIn = parseDateKey(body.checkIn);
  const checkOut = parseDateKey(body.checkOut);
  if (!checkIn || !checkOut) throw new AppError('Valid check-in and check-out dates are required', 400);
  const nights = nightsBetween(checkIn, checkOut);
  if (nights <= 0) throw new AppError('Check-out must be after check-in', 400);

  const property = await prisma.stayProperty.findFirst({
    where: { id: body.propertyId, supplierId, status: { not: 'ARCHIVED' } },
  });
  if (!property) throw new AppError('Property not found', 404);

  const data = objectOrEmpty(property.data);
  const rooms = Array.isArray(data.rooms) ? data.rooms : [];
  const room = rooms.find((row) => row.id === body.roomId);
  if (!room) throw new AppError('Room is required', 400);

  const plans = Array.isArray(data.ratePlans) ? data.ratePlans : [];
  const plan = body.ratePlanId
    ? plans.find((row) => row.id === body.ratePlanId && row.roomId === room.id)
    : plans.find((row) => row.roomId === room.id) || null;
  if (body.ratePlanId && !plan) throw new AppError('Rate plan not found for this room', 400);

  const travellers = parseTravellers(body);
  const valueAddIds = parseValueAddIds(body);
  const pricing = await priceStayNights({
    tx: prisma,
    property,
    room,
    plan,
    checkIn,
    checkOut,
    nights,
    travellers,
    valueAddIds,
  });

  res.status(200).json({
    status: 'success',
    data: {
      quote: {
        propertyId: property.id,
        roomId: room.id,
        roomName: room.name || room.kind || null,
        ratePlanId: plan?.id || null,
        ratePlanName: plan?.name || null,
        checkIn: dateKey(checkIn),
        checkOut: dateKey(checkOut),
        nights,
        travellers,
        valueAddIds,
        ...pricing,
      },
    },
  });
});

exports.createBooking = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const body = objectOrEmpty(req.body);

  if (!body.propertyId) throw new AppError('Property is required', 400);
  if (!body.roomId) throw new AppError('Room is required', 400);

  const checkIn = parseDateKey(body.checkIn);
  const checkOut = parseDateKey(body.checkOut);
  if (!checkIn || !checkOut) throw new AppError('Valid check-in and check-out dates are required', 400);
  const nights = nightsBetween(checkIn, checkOut);
  if (nights <= 0) throw new AppError('Check-out must be after check-in', 400);

  const guestName = parseGuestName(body.guestName);
  if (!guestName) throw new AppError('Guest name is required', 400);
  const guestEmail = typeof body.guestEmail === 'string' ? body.guestEmail.trim() || null : null;

  // Link an existing customer account by email so the Stays inbox can show the
  // guest and both sides can share one conversation thread.
  const customer = guestEmail
    ? await prisma.user.findFirst({
      where: { email: { equals: guestEmail, mode: 'insensitive' }, roles: { has: 'customer' } },
      select: { id: true },
    })
    : null;

  const travellers = parseTravellers(body);
  const valueAddIds = parseValueAddIds(body);
  const guests = travellers.totalGuests;

  // Allocate the booking number BEFORE the inventory transaction.
  //
  // `generateBookingNumber` bumps a single per-prefix counter row. Doing that
  // inside the inventory transaction makes every concurrent booking conflict on
  // that one row — even when they are for different rooms — because the counter
  // update is a write to a row every other transaction's snapshot must account
  // for. A number is not inventory state: if the transaction below fails or
  // retries, the number is simply unused, which is cheaper than serialising all
  // bookings through one counter row.
  const bookingNumber = await generateBookingNumber('TRG-S');

  // Everything that decides whether the room is actually available happens
  // inside one transaction holding a per-room advisory lock:
  //
  //   lock room → read availability → decide → insert
  //
  // Splitting those steps across separate connections is what allowed two
  // simultaneous requests to both observe "0 of 1 rooms booked" and both
  // insert a reservation. The advisory lock is transaction-scoped: it is
  // released on commit or rollback, and it serialises creators for one
  // (property, room) without blocking bookings for every other room.
  //
  // READ COMMITTED, not SERIALIZABLE, is deliberate. The lock already provides
  // mutual exclusion, and every statement after it sees the state the previous
  // holder committed. Serializable would additionally abort the waiting
  // transaction because the snapshot it captured before acquiring the lock is
  // now stale — one wasted attempt and a scary log line per concurrent booking,
  // for a guarantee the lock already provides.
  const booking = await runInventoryTransaction(() =>
    prisma.$transaction(
      async (tx) => {
        const lockKey = `${body.propertyId}:${body.roomId}`;
        // `pg_advisory_xact_lock` returns `void`, which Prisma cannot
        // deserialize. Selecting a constant from a subquery that evaluates the
        // lock keeps the side effect and returns an Int column instead.
        //
        // `$queryRawUnsafe` with positional parameters, not the tagged
        // `$queryRaw`: `jest.setup.js` rewrites tagged raw queries onto the
        // root client to work around a Prisma-under-Jest quirk, which would run
        // this statement OUTSIDE the interactive transaction. A transaction
        // lock taken in autocommit is released the moment the statement
        // finishes, which silently reopens the oversell race the lock exists to
        // close. The Unsafe variant is not rewritten and stays bound to `tx`;
        // values are still parameterised ($1/$2), so this is not interpolation.
        await tx.$queryRawUnsafe(
          'SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock($1::int, hashtext($2)::int)) AS lock',
          INVENTORY_LOCK_NAMESPACE,
          lockKey,
        );

        // Re-read inside the lock: a property edit or archive between the
        // request and the lock acquisition must not be ignored.
        const property = await tx.stayProperty.findFirst({
          where: { id: body.propertyId, supplierId, status: { not: 'ARCHIVED' } },
        });
        if (!property) throw new AppError('Property not found', 404);

        const data = objectOrEmpty(property.data);
        const rooms = Array.isArray(data.rooms) ? data.rooms : [];
        const room = rooms.find((row) => row.id === body.roomId);
        if (!room) throw new AppError('Room is required', 400);

        const plans = Array.isArray(data.ratePlans) ? data.ratePlans : [];
        const plan = body.ratePlanId
          ? plans.find((row) => row.id === body.ratePlanId && row.roomId === room.id)
          : plans.find((row) => row.roomId === room.id) || null;
        if (body.ratePlanId && !plan) throw new AppError('Rate plan not found for this room', 400);

        const pricing = await priceStayNights({
          tx,
          property,
          room,
          plan,
          checkIn,
          checkOut,
          nights,
          travellers,
          valueAddIds,
        });

        const requestedAmount = Number(body.amount);
        const amount = Number.isFinite(requestedAmount) && requestedAmount > 0
          ? Math.round(requestedAmount * 100) / 100
          : pricing.total;

        if (!(amount > 0)) {
          throw new AppError('A nightly price is required before taking a booking', 400);
        }

        const commission = await calculateCommission(amount);

        return tx.stayBooking.create({
          data: {
            bookingNumber,
            supplierId,
            propertyId: property.id,
            roomId: room.id,
            roomName: room.name || room.kind || null,
            ratePlanId: plan?.id || null,
            ratePlanName: plan?.name || null,
            guestName,
            customerId: customer?.id ?? null,
            guestEmail,
            guestPhone: typeof body.guestPhone === 'string' ? body.guestPhone.trim() || null : null,
            checkIn,
            checkOut,
            nights,
            guests,
            amount,
            currency: typeof data.currency === 'string' && data.currency ? data.currency : 'GHS',
            status: 'NEW',
            paymentStatus: 'PENDING',
            origin: 'SUPPLIER_CREATED',
            specialRequests: typeof body.specialRequests === 'string' ? body.specialRequests.trim() || null : null,
            commissionRate: commission.rate,
            platformCommission: commission.amount,
            supplierPayout: commission.supplierPayout,
          },
          include: stayBookingInclude,
        });
      },
      { isolationLevel: 'ReadCommitted', timeout: 15000, maxWait: 10000 },
    ),
  );

  enqueueStayNotification({
    userId: supplierId,
    type: 'BOOKING_CREATED_BY_SUPPLIER',
    title: 'New stay booking',
    message: `${guestName} booked ${booking.property?.name || 'a property'} (${booking.bookingNumber}).`,
    booking,
  });

  if (customer && customer.id !== supplierId) {
    await chatService.findOrCreateConversation(
      supplierId,
      customer.id,
      'SUPPLIER_CUSTOMER',
      {
        domain: 'STAYS',
        stayBookingId: booking.id,
        propertyId: booking.propertyId,
        bookingNumber: booking.bookingNumber,
        tourTitle: booking.property?.name || '',
      },
    ).catch((err) => {
      console.error('[Stays] conversation creation failed:', err.message);
    });
  }

  res.status(201).json({
    status: 'success',
    data: { booking: serializeStayBooking(booking) },
  });
});

exports.updateBookingStatus = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const nextStatus = enumBookingStatus(req.body?.status);
  if (!nextStatus) throw new AppError('Invalid booking status', 400);

  const existing = await prisma.stayBooking.findFirst({
    where: { id: req.params.id, supplierId },
    select: { id: true, status: true },
  });
  if (!existing) throw new AppError('Booking not found', 404);

  const allowed = BOOKING_TRANSITIONS[existing.status] || [];
  if (!allowed.includes(nextStatus)) {
    throw new AppError(`Cannot change a ${existing.status.toLowerCase()} booking to ${nextStatus.toLowerCase()}`, 400);
  }

  const data = { status: nextStatus };
  if (nextStatus === 'CANCELLED') {
    data.cancellationReason = 'Supplier cancelled';
    data.cancellationNote = 'Cancelled from the supplier dashboard';
    data.countsTowardRate = true;
  }
  if (nextStatus === 'NO_SHOW') {
    data.countsTowardRate = false;
  }

  const booking = await prisma.stayBooking.update({
    where: { id: existing.id },
    data,
    include: stayBookingInclude,
  });

  enqueueStayNotification({
    userId: supplierId,
    type: 'BOOKING_STATUS_UPDATED',
    title: 'Stay booking updated',
    message: `${booking.guestName}'s booking is now ${displayBookingStatus(booking.status)}.`,
    booking,
  });

  res.status(200).json({
    status: 'success',
    data: { booking: serializeStayBooking(booking) },
  });
});

exports.getCancellationSummary = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const days = Math.max(1, parseInt(req.query?.days, 10) || 90);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const where = { supplierId, checkIn: { gte: cutoff } };
  if (req.query?.propertyId) where.propertyId = req.query.propertyId;

  const rows = await prisma.stayBooking.findMany({
    where,
    select: { status: true, amount: true, cancellationReason: true },
  });

  const eligibleBookings = rows.length;
  const cancelledRows = rows.filter((row) => row.status === 'CANCELLED');
  const noShowRows = rows.filter((row) => row.status === 'NO_SHOW');
  const confirmed = rows.filter((row) => row.status === 'CONFIRMED' || row.status === 'CHECKED_IN').length;
  const completed = rows.filter((row) => row.status === 'COMPLETED').length;

  const percent = (count) => (eligibleBookings
    ? Math.round((count / eligibleBookings) * 1000) / 10
    : 0);

  const reasonCounts = new Map();
  for (const row of [...cancelledRows, ...noShowRows]) {
    if (row.cancellationReason) {
      reasonCounts.set(row.cancellationReason, (reasonCounts.get(row.cancellationReason) || 0) + 1);
    }
  }
  const mostCommonReason = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const cancellationRate = percent(cancelledRows.length);
  const status = eligibleBookings < 10
    ? 'Building performance record'
    : cancellationRate <= 1
      ? 'Excellent'
      : cancellationRate <= 2
        ? 'Good'
        : cancellationRate <= 5
          ? 'Needs attention'
          : 'High';

  res.status(200).json({
    status: 'success',
    data: {
      days,
      cancellationRate,
      eligibleBookings,
      confirmed,
      cancelled: cancelledRows.length,
      completed,
      noShowRate: percent(noShowRows.length),
      completionRate: percent(completed),
      status,
      mostCommonReason,
      bookingValueLost: [...cancelledRows, ...noShowRows]
        .reduce((sum, row) => sum + Number(row.amount || 0), 0),
    },
  });
});

exports.getCancellationRecords = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const days = Math.max(1, parseInt(req.query?.days, 10) || 90);
  const page = Math.max(1, parseInt(req.query?.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query?.limit, 10) || 25));
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const where = {
    supplierId,
    status: { in: ['CANCELLED', 'NO_SHOW'] },
    checkIn: { gte: cutoff },
  };
  if (req.query?.propertyId) where.propertyId = req.query.propertyId;

  const [rows, totalCount] = await Promise.all([
    prisma.stayBooking.findMany({
      where,
      include: stayBookingInclude,
      orderBy: { checkIn: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.stayBooking.count({ where }),
  ]);

  const records = rows.map((row) => {
    const travelDate = row.checkIn.toISOString().slice(0, 10);
    return {
      id: row.id,
      travelDate: formatDisplayDate(travelDate),
      reason: row.cancellationReason || 'Cancelled',
      note: row.cancellationNote || '',
      bookingReference: row.bookingNumber,
      productName: row.property?.name || 'Property',
      bookingValue: Number(row.amount),
      refundAmount: row.refundAmount == null ? null : Number(row.refundAmount),
      countsTowardRate: row.countsTowardRate,
    };
  });

  res.status(200).json({
    status: 'success',
    data: {
      records,
      pagination: {
        currentPage: page,
        limit,
        totalCount,
        totalPages: Math.max(1, Math.ceil(totalCount / limit)),
      },
    },
  });
});

// Exported for unit tests.
exports._private = {
  ruleAppliesToRoom,
  ruleAppliesToDate,
  positiveInt,
  parseTravellers,
  occupancyPricing,
  childRateCharges,
  valueAddCharges,
  applyPriceChange,
  priceStayNights,
};
