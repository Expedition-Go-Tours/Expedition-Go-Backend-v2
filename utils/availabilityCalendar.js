const prisma = require('./prismaClient');
const getConfig = require('./getConfig');
const { format, isAfter, addDays } = require('date-fns');

function computeAggregatedStatus(bookedCount, totalCapacity, overrideStatus) {
  if (overrideStatus === 'BLOCKED') return 'BLOCKED';
  if (overrideStatus === 'FULL') return 'FULL';
  if (totalCapacity <= 0) return 'BLOCKED';

  const ratio = bookedCount / totalCapacity;
  if (ratio >= 1) return 'FULL';
  if (ratio >= 0.75) return 'LIMITED';
  if (overrideStatus === 'LIMITED') return 'LIMITED';

  return 'AVAILABLE';
}

async function buildAvailabilityCalendar(tourId, schedulesAndPricing, start, end) {
  const parsed = typeof schedulesAndPricing === 'string'
    ? JSON.parse(schedulesAndPricing)
    : schedulesAndPricing;

  const templateDaysOfWeek = parsed?.availability?.daysOfWeek || parsed?.operatingDays || [];
  const templateTimeSlots = parsed?.availability?.timeSlots || [];
  const maxTravelersFallback = parseInt(await getConfig('booking.max_travelers', '50'));
  const maxCapacity = parsed?.travelerDetails?.maxParticipants || maxTravelersFallback;

  const [overrides, bookings] = await Promise.all([
    prisma.tourDateOverride.findMany({
      where: { tourId, date: { gte: start, lte: end } },
    }),
    prisma.booking.findMany({
      where: {
        tourId,
        selectedDate: { gte: start, lte: end },
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
      select: { selectedDate: true, travelers: true },
    }),
  ]);

  const overrideMap = new Map();
  for (const ov of overrides) {
    overrideMap.set(format(ov.date, 'yyyy-MM-dd'), ov);
  }

  const bookingCountMap = new Map();
  for (const b of bookings) {
    const key = format(b.selectedDate, 'yyyy-MM-dd');
    const travelers = typeof b.travelers === 'object' ? b.travelers : {};
    const count = (travelers.adults || 0) + (travelers.children || 0) + (travelers.infants || 0);
    bookingCountMap.set(key, (bookingCountMap.get(key) || 0) + count);
  }

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const calendar = [];
  let current = new Date(start);

  while (!isAfter(current, end)) {
    const dateStr = format(current, 'yyyy-MM-dd');
    const override = overrideMap.get(dateStr);
    const bookedCount = bookingCountMap.get(dateStr) || 0;
    const dayOfWeek = dayNames[current.getDay()];

    const isOperatingDay = templateDaysOfWeek.length === 0 || templateDaysOfWeek.some(
      (d) => d.toLowerCase() === dayOfWeek.toLowerCase()
    );

    const effectiveCapacity = override?.capacity ?? maxCapacity;
    const computedStatus = !isOperatingDay
      ? 'BLOCKED'
      : override
        ? computeAggregatedStatus(bookedCount, effectiveCapacity, override.status)
        : computeAggregatedStatus(bookedCount, effectiveCapacity, 'AVAILABLE');

    const effectiveTimeSlots = override?.timeSlotOverrides
      ? (typeof override.timeSlotOverrides === 'string'
          ? JSON.parse(override.timeSlotOverrides)
          : override.timeSlotOverrides)
      : templateTimeSlots.map((time) => ({ time, capacity: maxCapacity, booked: 0 }));

    calendar.push({
      date: dateStr,
      dayOfWeek,
      isOperatingDay,
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
