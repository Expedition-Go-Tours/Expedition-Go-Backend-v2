const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const crypto = require('crypto');
const { differenceInDays, isBefore } = require('date-fns');
const { buildAvailabilityCalendar } = require('../utils/availabilityCalendar');
const {
  statusLiteral,
  TRAVELER_COUNT_SQL,
  toUtcDate,
  toDateKey,
} = require('../utils/availabilityCore');
const { getOrSet, invalidateKeys } = require('../utils/cacheHelper');
const getConfig = require('../utils/getConfig');

const MAX_DATE_RANGE_DAYS = 366;
// Available / Limited / Full are automatic (derived from bookings vs capacity).
// Blocked is the only manual status a supplier can set.
const VALID_OVERRIDE_STATUSES = ['BLOCKED'];
// A slot-only / notes-only override (no explicit status) creates an AVAILABLE
// day row with timeSlotOverrides — it must never silently block the whole day.

/** UTC-midnight start of today — overrides can never target the past. */
function todayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** CUID-style id for the bulk override upsert (ids are client-generated). */
let _idCounter = 0;
function genId() {
  _idCounter = (_idCounter + 1) % 1679616;
  const ts = Date.now().toString(36);
  const counter = _idCounter.toString(36).padStart(4, '0');
  const rand = crypto.randomBytes(8).toString('base64').replace(/[+/=]/g, '').slice(0, 8);
  return `c${ts}${counter}${rand}`;
}

/** Display calendar cache — short TTL; checkout never reads it. */
const CALENDAR_CACHE_TTL = 30;
const calendarCacheKey = (tourId, start, end) => `availability:cal:${tourId}:${toDateKey(start)}:${toDateKey(end)}`;

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

  const calendar = await getOrSet(
    calendarCacheKey(tour.id, start, end),
    () => buildAvailabilityCalendar(tour.id, tour.schedulesAndPricing, start, end),
    CALENDAR_CACHE_TTL
  );

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

  const maxPublicDays = parseInt(await getConfig('availability.public_max_days', '31'), 10) || 31;
  const daysInRange = differenceInDays(end, start);
  if (daysInRange < 0) {
    return next(new AppError('endDate must be after startDate', 400));
  }
  if (daysInRange > maxPublicDays) {
    return next(new AppError(`Date range cannot exceed ${maxPublicDays} days`, 400));
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
  const calendar = await getOrSet(
    calendarCacheKey(tour.id, start, end),
    () => buildAvailabilityCalendar(tour.id, tour.schedulesAndPricing, start, end),
    CALENDAR_CACHE_TTL
  );

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
  const { status, timeSlotOverrides, notes } = req.body;

  const parsedDate = toUtcDate(date);
  if (!parsedDate) {
    return next(new AppError('Invalid date format. Use YYYY-MM-DD.', 400));
  }

  if (status && !VALID_OVERRIDE_STATUSES.includes(status)) {
    return next(new AppError('Invalid status. Only BLOCKED can be set manually — Available, Limited and Full are automatic.', 400));
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
        `Cannot block this date — ${liveBookings} traveler${liveBookings === 1 ? '' : 's'} already booked. Only dates with no existing bookings can be blocked.`,
        400
      );
    }

    const data = {};
    if (status) data.status = status;
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
        timeSlotOverrides: timeSlotOverrides || undefined,
        notes: notes || null,
      },
    });
  });

  await invalidateKeys([`availability:cal:${tourId}:*`]);

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

  await invalidateKeys([`availability:cal:${tourId}:*`]);

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

  // Validate every update up front so the transaction never partially applies
  // a malformed batch.
  const parsedUpdates = updates.map((update) => {
    const { date, status, timeSlotOverrides, notes } = update;
    const parsedDate = toUtcDate(date);

    if (!parsedDate) {
      throw new AppError(`Invalid date format: ${date}. Use YYYY-MM-DD.`, 400);
    }
    if (status && !VALID_OVERRIDE_STATUSES.includes(status)) {
      throw new AppError(`Invalid status for ${date}. Only BLOCKED can be set manually — Available, Limited and Full are automatic.`, 400);
    }
    const slotError = validateTimeSlotOverrides(timeSlotOverrides);
    if (slotError) {
      throw new AppError(slotError, 400);
    }
    if (isBefore(parsedDate, todayUtc())) {
      throw new AppError(`Cannot update availability for a past date: ${date}`, 400);
    }

    return {
      date,
      dateKey: toDateKey(parsedDate),
      status: status || null,
      timeSlotOverrides: timeSlotOverrides || null,
      notes: notes !== undefined ? notes : null,
    };
  });

  // The BLOCKED guard only needs live bookings when a date is being blocked.
  const needsLiveCount = parsedUpdates.some((u) => u.status === 'BLOCKED');

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

    // One grouped live-count query for the whole batch instead of one query
    // per date (previously up to 365 count queries inside the transaction).
    const liveByDate = new Map();
    if (needsLiveCount) {
      const dateKeys = parsedUpdates.map((u) => u.dateKey);
      const rows = await tx.$queryRawUnsafe(
        `SELECT "selectedDate"::date AS "d",
                COALESCE(SUM(CASE WHEN status IN (${statusLiteral})
                  THEN ${TRAVELER_COUNT_SQL} ELSE 0 END), 0)::int AS "live"
         FROM "Booking"
         WHERE "tourId" = $1 AND "selectedDate" = ANY($2::date[])
         GROUP BY "selectedDate"`,
        tourId,
        dateKeys
      );
      for (const r of rows) {
        liveByDate.set(toDateKey(r.d), parseInt(r.live, 10) || 0);
      }
    }

    for (const u of parsedUpdates) {
      if (u.status === 'BLOCKED') {
        const liveBookings = liveByDate.get(u.dateKey) || 0;
        if (liveBookings > 0) {
          throw new AppError(
            `Cannot block ${u.date} — ${liveBookings} traveler${liveBookings === 1 ? '' : 's'} already booked. Only dates with no existing bookings can be blocked.`,
            400
          );
        }
      }
    }

    // A single parameterized multi-row upsert replaces up to 365 sequential
    // Prisma upserts, so the FOR UPDATE lock is held for one write, not N.
    // ids are generated client-side (Prisma cuid() has no DB default).
    const ids = parsedUpdates.map(genId);
    const tourIds = parsedUpdates.map(() => tourId);
    const dates = parsedUpdates.map((u) => u.dateKey);
    const statuses = parsedUpdates.map((u) => u.status || 'AVAILABLE');
    const slotJsons = parsedUpdates.map((u) => (u.timeSlotOverrides ? JSON.stringify(u.timeSlotOverrides) : null));
    const notes = parsedUpdates.map((u) => (u.notes === null ? null : JSON.stringify(u.notes)));

    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO "TourDateOverride" ("id", "tourId", "date", "status", "timeSlotOverrides", "notes")
       SELECT * FROM UNNEST(
         $1::text[],
         $2::text[],
         $3::date[],
         $4::text[]::"OverrideStatus"[],
         $5::text[]::jsonb[],
         $6::text[]
       ) AS t("id", "tourId", "date", "status", "timeSlotOverrides", "notes")
       ON CONFLICT ("tourId", "date")
       DO UPDATE SET
         "status" = EXCLUDED."status",
         "timeSlotOverrides" = EXCLUDED."timeSlotOverrides",
         "notes" = EXCLUDED."notes"
       RETURNING "id", "date", "status"`,
      ids,
      tourIds,
      dates,
      statuses,
      slotJsons,
      notes
    );

    return rows.map((r) => ({
      id: r.id,
      date: r.date instanceof Date ? r.date : new Date(`${toDateKey(r.date)}T00:00:00.000Z`),
      status: r.status,
    }));
  });

  await invalidateKeys([`availability:cal:${tourId}:*`]);

  res.status(200).json({
    status: 'success',
    data: { overrides: results, count: results.length },
  });
});
