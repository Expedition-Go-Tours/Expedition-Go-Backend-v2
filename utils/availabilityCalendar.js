const prisma = require('./prismaClient');
const getConfig = require('./getConfig');
const { isAfter, addDays } = require('date-fns');
const {
  BOOKABLE_STATUSES,
  parseBlob,
  travelerCount,
  isPerGroupTour,
  getMaxGroupsPerTimeSlot,
  isOperatingDay,
  isClosedDate,
  getEffectiveCapacity,
  buildTimeSlots,
  computeStatus,
  DAY_NAMES,
  toDateKey,
  toUtcDate,
} = require('./availabilityCore');

/**
 * Build the availability calendar for a tour between two UTC dates.
 * This is the single canonical implementation — the supplier, public and admin
 * endpoints all use it. Rules come from the shared availability core so the
 * calendar never disagrees with the checkout transactions.
 */
async function buildAvailabilityCalendar(tourId, schedulesAndPricing, start, end) {
  const parsed = parseBlob(schedulesAndPricing) || {};
  const maxTravelersFallback = parseInt(await getConfig('booking.max_travelers', '50'), 10);
  const td = parsed.travelerDetails;
  const isPerGroup = isPerGroupTour(parsed);
  const maxGroups = getMaxGroupsPerTimeSlot(parsed);

  // Day-level capacity used for the aggregate status. Per-group tours express
  // it as groups × largest group so the ratio is still meaningful; per-person
  // tours use maxParticipants.
  const maxCapacity = isPerGroup
    ? maxGroups * (td?.groupSizes?.[0]?.to || maxTravelersFallback)
    : getEffectiveCapacity(parsed, null, maxTravelersFallback);

  const startDate = toUtcDate(start);
  const endDate = toUtcDate(end);

  const [overrides, bookings] = await Promise.all([
    prisma.tourDateOverride.findMany({
      where: { tourId, date: { gte: startDate, lte: endDate } },
    }),
    prisma.booking.findMany({
      where: {
        tourId,
        selectedDate: { gte: startDate, lte: endDate },
        status: { in: BOOKABLE_STATUSES },
      },
      select: { selectedDate: true, selectedTime: true, travelers: true },
    }),
  ]);

  const overrideMap = new Map();
  for (const ov of overrides) {
    overrideMap.set(toDateKey(ov.date), ov);
  }

  const bookingCountMap = new Map();
  const bookingTimeSlotMap = new Map();
  const slotGroupCountMap = new Map();
  for (const b of bookings) {
    const dateKey = toDateKey(b.selectedDate);
    const count = travelerCount(b.travelers);
    bookingCountMap.set(dateKey, (bookingCountMap.get(dateKey) || 0) + count);

    const slotKey = b.selectedTime || '__no_slot__';
    const slotMap = bookingTimeSlotMap.get(dateKey) || new Map();
    slotMap.set(slotKey, (slotMap.get(slotKey) || 0) + count);
    bookingTimeSlotMap.set(dateKey, slotMap);

    if (isPerGroup) {
      const groupMap = slotGroupCountMap.get(dateKey) || new Map();
      groupMap.set(slotKey, (groupMap.get(slotKey) || 0) + 1);
      slotGroupCountMap.set(dateKey, groupMap);
    }
  }

  const calendar = [];
  let current = new Date(startDate);

  while (!isAfter(current, endDate)) {
    const dateStr = toDateKey(current);
    const override = overrideMap.get(dateStr);
    const bookedCount = bookingCountMap.get(dateStr) || 0;
    const dayOfWeek = DAY_NAMES[current.getUTCDay()];
    const operating = isOperatingDay(parsed, current) && !isClosedDate(parsed, dateStr);

    const effectiveCapacity = override && override.capacity != null
      ? Number(override.capacity)
      : maxCapacity;
    const computedStatus = computeStatus(bookedCount, effectiveCapacity, override?.status || null, operating);

    const dateSlotMap = bookingTimeSlotMap.get(dateStr) || new Map();
    const dateGroupMap = slotGroupCountMap.get(dateStr) || new Map();
    const daySlots = buildTimeSlots(parsed, override, effectiveCapacity);
    const effectiveTimeSlots = daySlots.map((slot) => {
      const slotBooked = dateSlotMap.get(slot.time) || 0;
      const groupsBooked = dateGroupMap.get(slot.time) || 0;
      return {
        time: slot.time,
        capacity: slot.capacity,
        booked: slotBooked,
        remaining: Math.max(0, slot.capacity - slotBooked),
        ...(isPerGroup ? { groupsBooked, groupsRemaining: Math.max(0, maxGroups - groupsBooked) } : {}),
      };
    });

    calendar.push({
      date: dateStr,
      dayOfWeek,
      isOperatingDay: operating,
      status: computedStatus,
      capacity: effectiveCapacity,
      booked: bookedCount,
      remaining: Math.max(0, effectiveCapacity - bookedCount),
      timeSlots: effectiveTimeSlots,
      hasOverride: !!override,
      overrideStatus: override?.status || null,
    });

    current = addDays(current, 1);
  }

  return calendar;
}

module.exports = { buildAvailabilityCalendar };
