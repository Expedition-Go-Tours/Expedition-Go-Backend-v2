const prisma = require('./prismaClient');
const getConfig = require('./getConfig');
const { isAfter, addDays } = require('date-fns');
const {
  BOOKABLE_STATUSES,
  parseBlob,
  travelerCount,
  computeDayEntry,
  toDateKey,
  toUtcDate,
  todayUtc,
} = require('./availabilityCore');

/**
 * Build the availability calendar for a tour between two UTC dates.
 * This is the single canonical implementation — the supplier, public and admin
 * endpoints all use it. Per-day computation is delegated to the pure
 * computeDayEntry helper so the calendar never disagrees with the checkout
 * transactions or the search re-check. The LIMITED/FULL status thresholds are
 * configurable via availability.limited_ratio / availability.full_ratio.
 */
async function buildAvailabilityCalendar(tourId, schedulesAndPricing, start, end, todayRef) {
  const parsed = parseBlob(schedulesAndPricing) || {};
  const [maxTravelersFallback, limitedRatio, fullRatio] = await Promise.all([
    getConfig('booking.max_travelers', '50'),
    getConfig('availability.limited_ratio', '0.5'),
    getConfig('availability.full_ratio', '1'),
  ]);

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

    const groupMap = slotGroupCountMap.get(dateKey) || new Map();
    groupMap.set(slotKey, (groupMap.get(slotKey) || 0) + 1);
    slotGroupCountMap.set(dateKey, groupMap);
  }

  const calendar = [];
  let current = new Date(startDate);
  const today = todayRef ? toUtcDate(todayRef) || todayUtc() : todayUtc();

  while (!isAfter(current, endDate)) {
    const dateStr = toDateKey(current);
    calendar.push(computeDayEntry(
      parsed,
      overrideMap.get(dateStr) || null,
      {
        bookingsBySlot: bookingTimeSlotMap.get(dateStr) || new Map(),
        groupsBySlot: slotGroupCountMap.get(dateStr) || new Map(),
        bookedCount: bookingCountMap.get(dateStr) || 0,
      },
      current,
      {
        todayRef: today,
        fallbackCapacity: parseInt(maxTravelersFallback, 10),
        limitedRatio: parseFloat(limitedRatio),
        fullRatio: parseFloat(fullRatio),
      }
    ));
    current = addDays(current, 1);
  }

  return calendar;
}

module.exports = { buildAvailabilityCalendar };
