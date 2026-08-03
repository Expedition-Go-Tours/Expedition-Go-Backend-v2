/**
 * Availability Core — single source of truth for capacity rules.
 *
 * Every layer that reasons about availability (checkTourAvailability, the two
 * checkout transactions, and the availability calendar) derives its numbers
 * from these helpers + SQL fragments so they can never drift apart:
 *   - traveler-based accounting (adults + children + infants)
 *   - per-group cap for perGroup tours (maxGroupsPerTimeSlot)
 *   - TourDateOverride (BLOCKED/FULL/LIMITED + capacity + timeSlotOverrides)
 *   - dateExceptions (closed days)
 *   - timezone-safe day boundaries (UTC-explicit)
 */

const getConfig = require('./getConfig');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Statuses that occupy capacity. PENDING = a payment still being confirmed
// holds its spots until the Stripe webhook confirms (CONFIRMED) or cancels it.
const BOOKABLE_STATUSES = ['PENDING', 'CONFIRMED'];

// SQL-safe literal (internal constants only) for raw capacity queries.
const statusLiteral = BOOKABLE_STATUSES.map((s) => `'${s}'`).join(', ');

// SQL fragment — traveler count of a Booking row (JSONB `travelers` object).
// Shared verbatim with the checkout transactions' raw queries.
const TRAVELER_COUNT_SQL = `COALESCE((travelers->>'adults')::int, 0) + COALESCE((travelers->>'children')::int, 0) + COALESCE((travelers->>'infants')::int, 0)`;

/**
 * Timezone-safe day key. Prisma @db.Date values and YYYY-MM-DD strings are both
 * treated as UTC so a day never shifts when a server runs outside UTC.
 */
function toDateKey(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    return value.slice(0, 10);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Snap any date/string to a UTC-midnight Date. Date-only columns are compared
 * on their UTC day, so inputs must be normalized before hitting Prisma.
 */
function toUtcDate(value) {
  const key = toDateKey(value);
  if (!key) return null;
  const date = new Date(`${key}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

/** Parse a possibly-string JSON blob (schedulesAndPricing). */
function parseBlob(blob) {
  if (blob == null) return null;
  if (typeof blob === 'string') {
    try { return JSON.parse(blob); } catch { return null; }
  }
  return blob;
}

/** Number of travelers in a Booking.travelers JSON blob (adults+children+infants). */
function travelerCount(travelers) {
  if (!travelers || typeof travelers !== 'object') return 0;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return num(travelers.adults) + num(travelers.children) + num(travelers.infants);
}

function isPerGroupTour(parsed) {
  return parsed?.travelerDetails?.pricingModel === 'perGroup';
}

/** Distinct groups allowed per date+slot for perGroup tours (min 1). */
function getMaxGroupsPerTimeSlot(parsed) {
  const n = Number(parsed?.travelerDetails?.maxGroupsPerTimeSlot);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function getTemplateDaysOfWeek(parsed) {
  const avail = parsed?.availability;
  let days = Array.isArray(avail?.daysOfWeek) ? avail.daysOfWeek : [];
  if (days.length === 0) days = Array.isArray(parsed?.operatingDays) ? parsed.operatingDays : [];
  return days.map((d) => String(d).toLowerCase());
}

function isOperatingDay(parsed, dateObj) {
  const days = getTemplateDaysOfWeek(parsed);
  if (days.length === 0) return true;
  return days.includes(DAY_NAMES[dateObj.getUTCDay()].toLowerCase());
}

/** Collect dateExceptions from the availability block and every pricing schedule. */
function getDateExceptions(parsed) {
  const collected = [];
  const fromAvail = parsed?.availability?.dateExceptions;
  if (Array.isArray(fromAvail)) collected.push(...fromAvail);
  const schedules = parsed?.pricingSchedules?.schedules;
  if (Array.isArray(schedules)) {
    for (const s of schedules) {
      if (Array.isArray(s?.dateExceptions)) collected.push(...s.dateExceptions);
    }
  }
  return collected;
}

/** A date is closed when a dateException of type `closed` matches the UTC day. */
function isClosedDate(parsed, dateKey) {
  return getDateExceptions(parsed).some(
    (e) => e && e.type === 'closed' && String(e.date).slice(0, 10) === dateKey
  );
}

/** Parse the override's timeSlotOverrides JSON (null when absent/invalid). */
function getOverrideTimeSlotList(override) {
  if (!override?.timeSlotOverrides) return null;
  const raw = typeof override.timeSlotOverrides === 'string'
    ? (() => { try { return JSON.parse(override.timeSlotOverrides); } catch { return null; } })()
    : override.timeSlotOverrides;
  return Array.isArray(raw) && raw.length > 0 ? raw : null;
}

function getTemplateTimeSlots(parsed) {
  const avail = parsed?.availability;
  return Array.isArray(avail?.timeSlots) ? avail.timeSlots.filter(Boolean) : [];
}

/**
 * Effective traveler capacity for a date. Override capacity wins; otherwise the
 * tour's maxParticipants; otherwise the system fallback.
 */
function getEffectiveCapacity(parsed, override, fallbackCapacity) {
  if (override && override.capacity != null && Number.isFinite(Number(override.capacity)) && Number(override.capacity) >= 0) {
    return Math.floor(Number(override.capacity));
  }
  const n = Number(parsed?.travelerDetails?.maxParticipants);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return fallbackCapacity;
}

/**
 * Per-slot list for a date. Override slots win when present; otherwise the
 * template slots each default to the effective day capacity.
 */
function buildTimeSlots(parsed, override, fallbackCapacity) {
  const overrideSlots = getOverrideTimeSlotList(override);
  if (overrideSlots) {
    return overrideSlots.map((slot) => {
      const time = typeof slot === 'string' ? slot : slot?.time;
      const cap = slot && slot.capacity != null && Number.isFinite(Number(slot.capacity))
        ? Math.floor(Number(slot.capacity))
        : fallbackCapacity;
      return { time, capacity: cap };
    });
  }
  return getTemplateTimeSlots(parsed).map((time) => ({ time, capacity: fallbackCapacity }));
}

/** Day-level status aggregation shared by the calendar and the APIs. */
function computeStatus(bookedCount, totalCapacity, overrideStatus, operating) {
  if (!operating) return 'BLOCKED';
  if (overrideStatus === 'BLOCKED') return 'BLOCKED';
  if (overrideStatus === 'FULL') return 'FULL';
  if (totalCapacity <= 0) return 'BLOCKED';

  const ratio = bookedCount / totalCapacity;
  if (ratio >= 1) return 'FULL';
  if (ratio >= 0.75) return 'LIMITED';
  if (overrideStatus === 'LIMITED') return 'LIMITED';
  return 'AVAILABLE';
}

/**
 * Authoritative availability evaluation used INSIDE the checkout transactions
 * (after the tour row is locked FOR UPDATE). Applies the exact same rules as
 * checkTourAvailability so the pre-check and the point-of-charge can never
 * disagree. `db` is the transaction client.
 *
 * Returns { ok, reason?, availableSpots, groupsRemaining, maxCapacity,
 * currentBookings, isPerGroup, maxGroups, daySlots }.
 */
async function evaluateBookingAvailability(db, tour, dateKey, selectedTime, travelers) {
  const parsed = parseBlob(tour.schedulesAndPricing);
  const dateObj = toUtcDate(dateKey);
  if (!dateObj) return { ok: false, reason: 'Invalid date' };

  const maxTravelersFallback = parseInt(await getConfig('booking.max_travelers', '50'), 10);
  const isPerGroup = isPerGroupTour(parsed);
  const maxGroups = getMaxGroupsPerTimeSlot(parsed);

  const override = await db.tourDateOverride.findFirst({
    where: { tourId: tour.id, date: dateObj },
    select: { status: true, capacity: true, timeSlotOverrides: true },
  });

  const [counts] = await db.$queryRawUnsafe(
    `SELECT
       COALESCE(SUM(CASE WHEN status IN (${statusLiteral})
         THEN ${TRAVELER_COUNT_SQL} ELSE 0 END), 0)::int AS "currentBookings",
       COALESCE(COUNT(*) FILTER (WHERE status IN (${statusLiteral})), 0)::int AS "groupCount"
     FROM "Booking"
     WHERE "tourId" = $1 AND "selectedDate" = $2::date
       ${selectedTime ? 'AND "selectedTime" = $3' : ''}`,
    tour.id,
    dateKey,
    ...(selectedTime ? [selectedTime] : [])
  );

  const currentBookings = parseInt(counts?.currentBookings, 10) || 0;
  const groupCount = parseInt(counts?.groupCount, 10) || 0;

  const closedDate = isClosedDate(parsed, dateKey);
  const operating = isOperatingDay(parsed, dateObj);
  const dayCapacity = getEffectiveCapacity(parsed, override, maxTravelersFallback);

  if (closedDate || !operating) return { ok: false, reason: 'Tour is not available on this date' };
  if (override?.status === 'BLOCKED') return { ok: false, reason: 'Date is blocked' };
  if (override?.status === 'FULL') return { ok: false, reason: 'Date is fully booked' };

  const daySlots = buildTimeSlots(parsed, override, dayCapacity);
  if (daySlots.length > 0) {
    if (!selectedTime) return { ok: false, reason: 'A time slot must be selected' };
    if (!daySlots.some((s) => s.time === selectedTime)) {
      return { ok: false, reason: 'Selected time is not available for this date' };
    }
  }

  let effectiveCapacity = dayCapacity;
  if (selectedTime) {
    const slot = daySlots.find((s) => s.time === selectedTime);
    if (slot) effectiveCapacity = slot.capacity;
  }

  const availableSpots = Math.max(0, effectiveCapacity - currentBookings);
  const requestedTravelers = travelerCount(travelers);
  let groupsRemaining = null;
  if (isPerGroup) groupsRemaining = Math.max(0, maxGroups - groupCount);

  if (requestedTravelers > availableSpots) {
    return {
      ok: false,
      reason: `Only ${availableSpots} spot${availableSpots === 1 ? '' : 's'} left, but ${requestedTravelers} requested`,
      availableSpots,
    };
  }
  if (isPerGroup && groupsRemaining <= 0) {
    return { ok: false, reason: 'No group slots remaining for this time', availableSpots };
  }

  return {
    ok: true,
    availableSpots,
    groupsRemaining,
    maxCapacity: effectiveCapacity,
    currentBookings,
    isPerGroup,
    maxGroups,
    daySlots,
  };
}

module.exports = {
  DAY_NAMES,
  BOOKABLE_STATUSES,
  statusLiteral,
  TRAVELER_COUNT_SQL,
  toDateKey,
  toUtcDate,
  parseBlob,
  travelerCount,
  isPerGroupTour,
  getMaxGroupsPerTimeSlot,
  getTemplateDaysOfWeek,
  isOperatingDay,
  getDateExceptions,
  isClosedDate,
  getOverrideTimeSlotList,
  getTemplateTimeSlots,
  getEffectiveCapacity,
  buildTimeSlots,
  computeStatus,
  evaluateBookingAvailability,
};
