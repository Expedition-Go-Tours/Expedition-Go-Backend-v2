const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { differenceInDays, isBefore } = require('date-fns');
const { buildAvailabilityCalendar } = require('../utils/availabilityCalendar');
const {
  statusLiteral,
  TRAVELER_COUNT_SQL,
  toUtcDate,
  toDateKey,
} = require('../utils/availabilityCore');

const MAX_DATE_RANGE_DAYS = 366;
const VALID_OVERRIDE_STATUSES = ['AVAILABLE', 'LIMITED', 'FULL', 'BLOCKED'];

/** UTC-midnight start of today — overrides can never target the past. */
function todayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Validate the timeSlotOverrides payload: must be an array of
 * { time, capacity } entries with a valid HH:MM time and a non-negative int.
 */
function validateTimeSlotOverrides(timeSlotOverrides) {
  if (timeSlotOverrides === undefined) return null;
  if (!Array.isArray(timeSlotOverrides)) return 'timeSlotOverrides must be an array';
  if (timeSlotOverrides.length > 50) return 'timeSlotOverrides cannot exceed 50 slots';

  for (const slot of timeSlotOverrides) {
    const time = typeof slot === 'string' ? slot : slot?.time;
    if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      return `Invalid time "${time}". Use HH:MM (24-hour).`;
    }
    if (slot && slot.capacity != null) {
      const cap = Number(slot.capacity);
      if (!Number.isInteger(cap) || cap < 0 || cap > 100000) {
        return `Invalid capacity ${slot.capacity} for slot ${time}. Must be a non-negative integer.`;
      }
    }
  }
  return null;
}

exports.getAvailability = catchAsync(async (req, res, next) => {
  const { tourId } = req.params;
  const { startDate, endDate } = req.query;

  if (!startDate || !endDate) {
    return next(new AppError('startDate and endDate are required', 400));
  }

  const start = toUtcDate(startDate);
  const end = toUtcDate(endDate);
  if (!start || !end) {
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

  const calendar = await buildAvailabilityCalendar(tour.id, tour.schedulesAndPricing, start, end);

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

  const start = toUtcDate(startDate);
  const end = toUtcDate(endDate);
  if (!start || !end) {
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
      supplier: { supplierProfile: { status: 'ACTIVE' } },
    },
    select: { id: true, title: true, status: true, schedulesAndPricing: true },
  });

  if (!tour) {
    return next(new AppError('Tour not found or not available for booking', 404));
  }

  // Build the calendar against the resolved tour id — a slug lookup must not
  // be passed down as the tour id or overrides/bookings would be missed.
  const calendar = await buildAvailabilityCalendar(tour.id, tour.schedulesAndPricing, start, end);

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

  const parsedDate = toUtcDate(date);
  if (!parsedDate) {
    return next(new AppError('Invalid date format. Use YYYY-MM-DD.', 400));
  }

  if (status && !VALID_OVERRIDE_STATUSES.includes(status)) {
    return next(new AppError('Invalid status. Must be AVAILABLE, LIMITED, FULL, or BLOCKED.', 400));
  }

  const slotError = validateTimeSlotOverrides(timeSlotOverrides);
  if (slotError) {
    return next(new AppError(slotError, 400));
  }

  const tour = await prisma.tour.findFirst({
    where: { id: tourId, supplierId: req.supplierId },
  });

  if (!tour) {
    return next(new AppError('Tour not found or access denied', 404));
  }

  const override = await prisma.$transaction(async (tx) => {
    // Serialize against booking transactions by taking the same tour lock.
    const [lockedTour] = await tx.$queryRawUnsafe(
      `SELECT id FROM "Tour" WHERE id = $1 AND "supplierId" = $2 FOR UPDATE`,
      tourId,
      req.supplierId
    );
    if (!lockedTour) {
      throw new AppError('Tour not found or access denied', 404);
    }

    const dateKey = toDateKey(parsedDate);
    const isPastDate = isBefore(parsedDate, todayUtc());
    if (isPastDate) {
      throw new AppError('Cannot update availability for a date in the past', 400);
    }

    const [liveRow] = await tx.$queryRawUnsafe(
      `SELECT COALESCE(SUM(CASE WHEN status IN (${statusLiteral})
         THEN ${TRAVELER_COUNT_SQL} ELSE 0 END), 0)::int AS "live"
       FROM "Booking"
       WHERE "tourId" = $1 AND "selectedDate" = $2::date`,
      tourId,
      dateKey
    );
    const liveBookings = parseInt(liveRow?.live, 10) || 0;

    if (status === 'BLOCKED' && liveBookings > 0) {
      throw new AppError(
        `Cannot block this date — ${liveBookings} traveler${liveBookings === 1 ? '' : 's'} already booked. Mark it FULL instead.`,
        400
      );
    }

    if (capacity !== undefined && capacity !== null) {
      if (!Number.isInteger(capacity) || capacity < 0) {
        throw new AppError('Capacity must be a non-negative integer', 400);
      }
      if (capacity < liveBookings) {
        throw new AppError(
          `Cannot set capacity lower than existing bookings (${liveBookings}) for this date`,
          400
        );
      }
    }

    const data = {};
    if (status) data.status = status;
    if (capacity !== undefined) data.capacity = capacity;
    if (timeSlotOverrides) data.timeSlotOverrides = timeSlotOverrides;
    if (notes !== undefined) data.notes = notes;

    return tx.tourDateOverride.upsert({
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
  });

  res.status(200).json({
    status: 'success',
    data: { override },
  });
});

exports.removeDateOverride = catchAsync(async (req, res, next) => {
  const { tourId, date } = req.params;

  const parsedDate = toUtcDate(date);
  if (!parsedDate) {
    return next(new AppError('Invalid date format. Use YYYY-MM-DD.', 400));
  }

  const tour = await prisma.tour.findFirst({
    where: { id: tourId, supplierId: req.supplierId },
  });

  if (!tour) {
    return next(new AppError('Tour not found or access denied', 404));
  }

  if (isBefore(parsedDate, todayUtc())) {
    return next(new AppError('Cannot remove an override for a date in the past', 400));
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
    // Serialize against booking transactions for the whole batch.
    const [lockedTour] = await tx.$queryRawUnsafe(
      `SELECT id FROM "Tour" WHERE id = $1 AND "supplierId" = $2 FOR UPDATE`,
      tourId,
      req.supplierId
    );
    if (!lockedTour) {
      throw new AppError('Tour not found or access denied', 404);
    }

    const created = [];
    for (const update of updates) {
      const { date, status, capacity, timeSlotOverrides, notes } = update;
      const parsedDate = toUtcDate(date);

      if (!parsedDate) {
        throw new AppError(`Invalid date format: ${date}. Use YYYY-MM-DD.`, 400);
      }

      if (status && !VALID_OVERRIDE_STATUSES.includes(status)) {
        throw new AppError(`Invalid status for ${date}. Must be AVAILABLE, LIMITED, FULL, or BLOCKED.`, 400);
      }

      const slotError = validateTimeSlotOverrides(timeSlotOverrides);
      if (slotError) {
        throw new AppError(slotError, 400);
      }

      if (isBefore(parsedDate, todayUtc())) {
        throw new AppError(`Cannot update availability for a past date: ${date}`, 400);
      }

      const dateKey = toDateKey(parsedDate);
      const [liveRow] = await tx.$queryRawUnsafe(
        `SELECT COALESCE(SUM(CASE WHEN status IN (${statusLiteral})
           THEN ${TRAVELER_COUNT_SQL} ELSE 0 END), 0)::int AS "live"
         FROM "Booking"
         WHERE "tourId" = $1 AND "selectedDate" = $2::date`,
        tourId,
        dateKey
      );
      const liveBookings = parseInt(liveRow?.live, 10) || 0;

      if (status === 'BLOCKED' && liveBookings > 0) {
        throw new AppError(
          `Cannot block ${date} — ${liveBookings} traveler${liveBookings === 1 ? '' : 's'} already booked. Mark it FULL instead.`,
          400
        );
      }

      if (capacity !== undefined && capacity !== null) {
        if (!Number.isInteger(capacity) || capacity < 0) {
          throw new AppError(`Capacity must be a non-negative integer for ${date}`, 400);
        }
        if (capacity < liveBookings) {
          throw new AppError(
            `Cannot set capacity for ${date} lower than existing bookings (${liveBookings})`,
            400
          );
        }
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
