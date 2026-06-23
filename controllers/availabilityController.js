const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { startOfDay, endOfDay, differenceInDays, parseISO, isAfter, addDays, format } = require('date-fns');
const getConfig = require('../utils/getConfig');

const MAX_DATE_RANGE_DAYS = 366;

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

  const templateDaysOfWeek = parsed?.availability?.daysOfWeek || [];
  const templateTimeSlots = parsed?.availability?.timeSlots || [];
  const maxTravelersFallback = parseInt(await getConfig('booking.max_travelers', '50'));
  const maxCapacity = parsed?.travelerDetails?.maxTravelersPerBooking || maxTravelersFallback;

  const [overrides, bookings] = await Promise.all([
    prisma.tourDateOverride.findMany({
      where: {
        tourId,
        date: { gte: start, lte: end },
      },
    }),
    prisma.booking.findMany({
      where: {
        tourId,
        selectedDate: { gte: start, lte: end },
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
      select: {
        selectedDate: true,
        travelers: true,
      },
    }),
  ]);

  const overrideMap = new Map();
  for (const ov of overrides) {
    const key = format(ov.date, 'yyyy-MM-dd');
    overrideMap.set(key, ov);
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
      : templateTimeSlots.map((time) => ({
          time,
          capacity: maxCapacity,
          booked: 0,
        }));

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

exports.getAvailability = catchAsync(async (req, res, next) => {
  const { tourId } = req.params;
  const { startDate, endDate } = req.query;

  if (!startDate || !endDate) {
    return next(new AppError('startDate and endDate are required', 400));
  }

  const start = parseISO(startDate);
  const end = parseISO(endDate);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return next(new AppError('Invalid date format. Use YYYY-MM-DD.', 400));
  }

  const daysInRange = differenceInDays(end, start);
  if (daysInRange < 0) {
    return next(new AppError('endDate must be after startDate', 400));
  }
  if (daysInRange > MAX_DATE_RANGE_DAYS) {
    return next(new AppError(`Date range cannot exceed ${MAX_DATE_RANGE_DAYS} days`, 400));
  }

  const tour = await prisma.tour.findFirst({
    where: { id: tourId, supplierId: req.supplierId },
  });

  if (!tour) {
    return next(new AppError('Tour not found or access denied', 404));
  }

  const calendar = await buildAvailabilityCalendar(tourId, tour.schedulesAndPricing, start, end);

  res.status(200).json({
    status: 'success',
    data: {
      tour: { id: tour.id, title: tour.title },
      startDate,
      endDate,
      calendar,
    },
  });
});

exports.getPublicAvailability = catchAsync(async (req, res, next) => {
  const { tourId } = req.params;
  const { startDate, endDate } = req.query;

  if (!startDate || !endDate) {
    return next(new AppError('startDate and endDate are required', 400));
  }

  const start = parseISO(startDate);
  const end = parseISO(endDate);

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return next(new AppError('Invalid date format. Use YYYY-MM-DD.', 400));
  }

  const daysInRange = differenceInDays(end, start);
  if (daysInRange < 0) {
    return next(new AppError('endDate must be after startDate', 400));
  }
  if (daysInRange > 31) {
    return next(new AppError('Date range cannot exceed 31 days', 400));
  }

  const tour = await prisma.tour.findFirst({
    where: {
      OR: [{ id: tourId }, { slug: tourId }],
      status: 'ACTIVE',
    },
    select: { id: true, title: true, status: true, schedulesAndPricing: true },
  });

  if (!tour) {
    return next(new AppError('Tour not found or not available for booking', 404));
  }

  const calendar = await buildAvailabilityCalendar(tourId, tour.schedulesAndPricing, start, end);

  res.status(200).json({
    status: 'success',
    data: {
      tour: { id: tour.id, title: tour.title },
      startDate,
      endDate,
      calendar,
    },
  });
});

exports.updateDateAvailability = catchAsync(async (req, res, next) => {
  const { tourId, date } = req.params;
  const { status, capacity, timeSlotOverrides, notes } = req.body;

  const parsedDate = parseISO(date);
  if (isNaN(parsedDate.getTime())) {
    return next(new AppError('Invalid date format. Use YYYY-MM-DD.', 400));
  }

  const tour = await prisma.tour.findFirst({
    where: { id: tourId, supplierId: req.supplierId },
  });

  if (!tour) {
    return next(new AppError('Tour not found or access denied', 404));
  }

  if (status && !['AVAILABLE', 'LIMITED', 'FULL', 'BLOCKED'].includes(status)) {
    return next(new AppError('Invalid status. Must be AVAILABLE, LIMITED, FULL, or BLOCKED.', 400));
  }

  if (capacity !== undefined && capacity !== null) {
    if (capacity < 0) {
      return next(new AppError('Capacity must be a non-negative number', 400));
    }

    const existingBookings = await prisma.booking.count({
      where: {
        tourId,
        selectedDate: {
          gte: startOfDay(parsedDate),
          lte: endOfDay(parsedDate),
        },
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
    });

    if (capacity < existingBookings) {
      return next(new AppError(
        `Cannot set capacity lower than existing bookings (${existingBookings}) for this date`,
        400
      ));
    }
  }

  const data = {};
  if (status) data.status = status;
  if (capacity !== undefined) data.capacity = capacity;
  if (timeSlotOverrides) data.timeSlotOverrides = timeSlotOverrides;
  if (notes !== undefined) data.notes = notes;

  const override = await prisma.tourDateOverride.upsert({
    where: {
      tourId_date: { tourId, date: parsedDate },
    },
    update: data,
    create: {
      tourId,
      date: parsedDate,
      status: status || 'AVAILABLE',
      capacity: capacity ?? null,
      timeSlotOverrides: timeSlotOverrides || undefined,
      notes: notes || null,
    },
  });

  res.status(200).json({
    status: 'success',
    data: { override },
  });
});

exports.removeDateOverride = catchAsync(async (req, res, next) => {
  const { tourId, date } = req.params;

  const parsedDate = parseISO(date);
  if (isNaN(parsedDate.getTime())) {
    return next(new AppError('Invalid date format. Use YYYY-MM-DD.', 400));
  }

  const tour = await prisma.tour.findFirst({
    where: { id: tourId, supplierId: req.supplierId },
  });

  if (!tour) {
    return next(new AppError('Tour not found or access denied', 404));
  }

  await prisma.tourDateOverride.deleteMany({
    where: {
      tourId,
      date: parsedDate,
    },
  });

  res.status(200).json({
    status: 'success',
    data: null,
  });
});

exports.batchUpdateAvailability = catchAsync(async (req, res, next) => {
  const { tourId } = req.params;
  const { updates } = req.body;

  if (!updates || !Array.isArray(updates) || updates.length === 0) {
    return next(new AppError('updates must be a non-empty array', 400));
  }

  if (updates.length > 365) {
    return next(new AppError('Cannot update more than 365 dates at once', 400));
  }

  const tour = await prisma.tour.findFirst({
    where: { id: tourId, supplierId: req.supplierId },
  });

  if (!tour) {
    return next(new AppError('Tour not found or access denied', 404));
  }

  const results = await prisma.$transaction(async (tx) => {
    const created = [];
    for (const update of updates) {
      const { date, status, capacity, timeSlotOverrides, notes } = update;
      const parsedDate = parseISO(date);

      if (isNaN(parsedDate.getTime())) {
        throw new AppError(`Invalid date format: ${date}. Use YYYY-MM-DD.`, 400);
      }

      if (status && !['AVAILABLE', 'LIMITED', 'FULL', 'BLOCKED'].includes(status)) {
        throw new AppError(`Invalid status for ${date}. Must be AVAILABLE, LIMITED, FULL, or BLOCKED.`, 400);
      }

      const override = await tx.tourDateOverride.upsert({
        where: {
          tourId_date: { tourId, date: parsedDate },
        },
        update: {
          ...(status && { status }),
          ...(capacity !== undefined && { capacity }),
          ...(timeSlotOverrides && { timeSlotOverrides }),
          ...(notes !== undefined && { notes }),
        },
        create: {
          tourId,
          date: parsedDate,
          status: status || 'AVAILABLE',
          capacity: capacity ?? null,
          timeSlotOverrides: timeSlotOverrides || undefined,
          notes: notes || null,
        },
      });

      created.push(override);
    }
    return created;
  });

  res.status(200).json({
    status: 'success',
    data: { overrides: results, count: results.length },
  });
});
