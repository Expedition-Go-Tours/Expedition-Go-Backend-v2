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
// Generic: sums every numeric key so supplier-defined categories (adults,
// children, infants, seniors, students, youth, …) all occupy capacity.
// Non-numeric metadata (phoneNumber/location/details) is excluded by the
// numeric regex. Shared verbatim with the checkout transactions' raw queries.
const TRAVELER_COUNT_SQL = `COALESCE((SELECT SUM(COALESCE((elem.value)::numeric, 0))
  FROM jsonb_each_text(travelers) elem
  WHERE elem.value ~ '^[0-9]+$'), 0)`;

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

/** UTC-midnight start of today — anything before it is in the past. */
function todayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
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
  let total = 0;
  for (const value of Object.values(travelers)) {
    // Only pure numeric values count as travelers — metadata (phone numbers,
    // locations, details arrays) must never inflate the headcount.
    if (typeof value === 'number') {
      total += num(value);
    } else if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
      total += num(value);
    }
  }
  return total;
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

// ============================================================
// Per-tour timezone support (GetYourGuide-style).
// Slots, weekdays and cutoff clocks are anchored to the tour's
// IANA timezone; every consumer derives them from these helpers so
// they can never drift apart. Intl-based — no tz-database runtime dep.
// ============================================================

const TZ_FORMATTER_CACHE = new Map();

function getTzFormatter(timeZone) {
  let f = TZ_FORMATTER_CACHE.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    TZ_FORMATTER_CACHE.set(timeZone, f);
  }
  return f;
}

function isTzValid(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * A tour's IANA timezone, read from the availability or bookingAndTickets
 * blob. Invalid/missing zones fall back to 'UTC'.
 */
function getTourTimezone(parsed) {
  const candidate = parsed?.availability?.timezone ?? parsed?.timezone;
  if (typeof candidate === 'string' && candidate.trim() && isTzValid(candidate)) {
    return candidate;
  }
  return 'UTC';
}

/** UTC wall-clock offset (ms) of an instant in `timeZone` (Intl-derived). */
function tzOffsetMs(instantMs, timeZone) {
  const parts = Object.fromEntries(
    getTzFormatter(timeZone).formatToParts(new Date(instantMs)).map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - instantMs;
}

/**
 * Local calendar date (YYYY-MM-DD) inside `timeZone` for a UTC day key.
 * Anchored at 12:00 UTC — inside every real zone's day — so a day never
 * splits across a midnight boundary. (Zones at +12..+14 shift one day.)
 */
function zonedDateKey(dateKey, timeZone) {
  const noon = new Date(`${String(dateKey).slice(0, 10)}T12:00:00.000Z`);
  const parts = Object.fromEntries(
    getTzFormatter(timeZone).formatToParts(noon).map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Weekday name (e.g. "Monday") of a UTC day in the tour's timezone. */
function weekdayInZone(dateObj, timeZone) {
  const noon = new Date(Date.UTC(dateObj.getUTCFullYear(), dateObj.getUTCMonth(), dateObj.getUTCDate(), 12));
  return getTzFormatter(timeZone).formatToParts(noon).find((p) => p.type === 'weekday').value;
}

/**
 * UTC instant for a tour-local wall clock ("YYYY-MM-DD HH:MM") in `timeZone`.
 * The wall clock is interpreted as if it were UTC, then corrected by the zone
 * offset (iterated so DST transitions converge in 2-3 passes). Never uses
 * Date.parse on a bare local time — that would silently depend on the server's
 * own timezone.
 */
function zonedTimeToUtc(localDateTime, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/.exec(String(localDateTime));
  if (!match) return new Date(NaN);
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const d = Number(match[3]);
  const h = Number(match[4]);
  const mi = Number(match[5]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return new Date(NaN);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  let guess = asUtc;
  for (let i = 0; i < 3; i++) {
    const next = asUtc - tzOffsetMs(guess, timeZone);
    if (Math.abs(next - guess) < 1000) return new Date(next);
    guess = next;
  }
  return new Date(guess);
}

function isOperatingDay(parsed, dateObj) {
  const days = getTemplateDaysOfWeek(parsed);
  if (days.length > 0 && !days.includes(weekdayInZone(dateObj, getTourTimezone(parsed)).toLowerCase())) return false;
  return hasPricingScheduleForDate(parsed, dateObj);
}

/**
 * Single source of truth for "which pricing schedules cover a given date/time".
 *
 * Pricing (calculateTourPrice) and availability (isOperatingDay / checkout
 * guards) both call through here so a calendar can never advertise a date a
 * price engine will reject — GetYourGuide-style: what you can pick, you can
 * pay for.
 *
 * Mirrors the historical pricing rules exactly:
 *   - window  [startDate .. endDate] inclusive (open-ended when missing)
 *   - when a schedule lists `prices[0].days`, the weekday must be included
 *   - when a specific time is selected and a schedule lists `prices[0].times`,
 *     the time must be included (times are ignored when no time is picked)
 *
 * @returns {number[]|null} indices of matching schedules, or null when the
 *   tour has no pricing schedule data at all (nothing to gate on).
 */
function pricingScheduleIndexesFor(parsed, dateKey, weekdayLower, selectedTime = null) {
  const ps = parsed && parsed.pricingSchedules ? parsed.pricingSchedules : null;
  if (!ps) return null;
  const schedules = ps.schedules;
  if (!Array.isArray(schedules)) return null;

  const indexes = [];
  for (let i = 0; i < schedules.length; i++) {
    const s = schedules[i];
    if (!s || typeof s !== 'object') continue;

    const startKey = s.startDate ? toDateKey(s.startDate) : null;
    const endKey = s.endDate ? toDateKey(s.endDate) : null;
    if (startKey && dateKey < startKey) continue;
    if (endKey && dateKey > endKey) continue;

    const p0 = Array.isArray(s.prices) && s.prices[0] ? s.prices[0] : {};
    const days = Array.isArray(p0.days) && p0.days.length
      ? p0.days.map((d) => String(d).toLowerCase())
      : null;
    if (days && !days.includes(weekdayLower)) continue;

    const times = Array.isArray(p0.times) && p0.times.length ? p0.times : null;
    if (selectedTime && times && !times.some((t) => String(t) === selectedTime)) continue;

    indexes.push(i);
  }
  return indexes;
}

/**
 * True when at least one pricing schedule can price `dateObj`, or when the
 * tour has no pricing schedule data to gate on (preserves legacy behaviour).
 */
function hasPricingScheduleForDate(parsed, dateObj) {
  const dateKey = toDateKey(dateObj);
  if (!dateKey) return false;
  const weekday = weekdayInZone(dateObj, getTourTimezone(parsed)).toLowerCase();
  const indexes = pricingScheduleIndexesFor(parsed, dateKey, weekday, null);
  return indexes === null || indexes.length > 0;
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
 * Effective traveler capacity for a date. Always derived from the tour's
 * maxParticipants (the builder's capacity max); otherwise the system fallback.
 * This is the BASE (template) capacity — a TourDateOverride day-limit may lower
 * it for a specific date (see computeDayEntry / evaluateBookingAvailability),
 * but the builder value is always the source of truth for the template.
 */
function getEffectiveCapacity(parsed, fallbackCapacity) {
  const n = Number(parsed?.travelerDetails?.maxParticipants);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return fallbackCapacity;
}

/**
 * Normalize a TourDateOverride day-limit into a usable int, or null when absent.
 * The override capacity is a day-wide ceiling expressed in the tour's unit
 * (people for per-person tours, group slots for per-group tours). Invalid or
 * non-positive values are treated as "no override" so stale data can never
 * silently disable a date.
 */
function getOverrideCapacity(override) {
  if (!override || override.capacity == null) return null;
  const n = Number(override.capacity);
  return Number.isInteger(n) && n > 0 && n <= 100000 ? n : null;
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
  // Template slots may be stored as strings ("09:00") or objects ({ time, ... }).
  // Normalize both so object-form entries can never leak `{ time: <object> }`
  // into the calendar/checkout; invalid entries are dropped.
  return getTemplateTimeSlots(parsed)
    .map((slot) => ({ time: typeof slot === 'string' ? slot : slot?.time, capacity: fallbackCapacity }))
    .filter((s) => typeof s.time === 'string' && s.time);
}

/** Day-level status aggregation shared by the calendar and the APIs.
 * Available / Limited / Full are fully automatic (derived from bookings vs
 * capacity). The only manual override honored is BLOCKED. The LIMITED/FULL
 * ratios are configurable (`availability.limited_ratio` / `availability.full_ratio`)
 * and default to 0.7 / 1.0. */
function computeStatus(bookedCount, totalCapacity, overrideStatus, operating, limitedRatio = 0.7, fullRatio = 1) {
  if (!operating) return 'BLOCKED';
  if (overrideStatus === 'BLOCKED') return 'BLOCKED';
  if (totalCapacity <= 0) return 'BLOCKED';

  const limited = Number.isFinite(Number(limitedRatio)) ? Number(limitedRatio) : 0.7;
  const full = Number.isFinite(Number(fullRatio)) ? Number(fullRatio) : 1;
  const ratio = bookedCount / totalCapacity;
  if (ratio >= full) return 'FULL';
  if (ratio >= limited) return 'LIMITED';
  return 'AVAILABLE';
}

/**
 * Authoritative availability evaluation used INSIDE the checkout transactions
 * (after the tour row is locked FOR UPDATE). Applies the exact same rules as
 * checkTourAvailability so the pre-check and the point-of-charge can never
 * disagree. `db` is the transaction client.
 *
 * Options (5th param):
 *   excludeDraftId — when set, the active hold for this draft is excluded from
 *   the hold count. Used during materialization so converting hold→booking
 *   doesn't double-count the same seats.
 *
 * Returns { ok, reason?, availableSpots, groupsRemaining, maxCapacity,
 * currentBookings, isPerGroup, maxGroups, daySlots }.
 */
async function evaluateBookingAvailability(db, tour, dateKey, selectedTime, travelers, options = {}) {
  const { excludeDraftId = null } = options;
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

  const capOverride = getOverrideCapacity(override);
  // A day-limit override is a day-wide ceiling, so occupancy is counted across
  // every time slot that day. Without one, behavior is unchanged (per-slot).
  const dayWide = capOverride != null;
  const [counts] = await db.$queryRawUnsafe(
    `SELECT
       COALESCE(SUM(CASE WHEN status IN (${statusLiteral})
         THEN ${TRAVELER_COUNT_SQL} ELSE 0 END), 0)::int AS "currentBookings",
       COALESCE(COUNT(*) FILTER (WHERE status IN (${statusLiteral})), 0)::int AS "groupCount"
     FROM "Booking"
     WHERE "tourId" = $1 AND "selectedDate" = $2::date
       ${selectedTime && !dayWide ? 'AND "selectedTime" = $3' : ''}`,
    tour.id,
    dateKey,
    ...(selectedTime && !dayWide ? [selectedTime] : [])
  );

  // Active holds (CheckoutDraft status='HOLDING', unexpired) also occupy
  // capacity. A materialization webhook may exclude its own hold via
  // `excludeDraftId` so conversion from hold→booking doesn't double-count.
  const holdWhereExtra = excludeDraftId ? `AND "id" != '${excludeDraftId}'` : '';
  const [holds] = await db.$queryRawUnsafe(
    `SELECT
       COALESCE(SUM("seats"), 0)::int AS "holdSeats",
       COALESCE(COUNT(*), 0)::int    AS "holdGroups"
     FROM "CheckoutDraft"
     WHERE "tourId" = $1 AND "selectedDate" = $2::date
       AND "status" = 'HOLDING' AND "expiresAt" > NOW()
       ${selectedTime && !dayWide ? `AND "selectedTime" = $3` : ''}
       ${holdWhereExtra}`,
    tour.id,
    dateKey,
    ...(selectedTime && !dayWide ? [selectedTime] : [])
  );

  const currentBookings = (parseInt(counts?.currentBookings, 10) || 0)
                        + (parseInt(holds?.holdSeats, 10) || 0);
  const groupCount = (parseInt(counts?.groupCount, 10) || 0)
                   + (parseInt(holds?.holdGroups, 10) || 0);

  const closedDate = isClosedDate(parsed, dateKey);
  const operating = isOperatingDay(parsed, dateObj);
  const dayCapacity = capOverride ?? getEffectiveCapacity(parsed, maxTravelersFallback);

  if (closedDate || !operating) return { ok: false, reason: 'Tour is not available on this date' };
  if (override?.status === 'BLOCKED') return { ok: false, reason: 'Date is blocked' };

  const daySlots = buildTimeSlots(parsed, override, dayCapacity);
  if (daySlots.length > 0) {
    if (!selectedTime) return { ok: false, reason: 'A time slot must be selected' };
    if (!daySlots.some((s) => s.time === selectedTime)) {
      return { ok: false, reason: 'Selected time is not available for this date' };
    }
  }

  // A date can only be sold at times a pricing schedule actually prices — if a
  // schedule's `times` are narrower than the template's offered slots, the
  // unavailable ones must fail here (availability check) rather than later at
  // checkout. Same single rule set the price engine uses.
  const priceIndexes = pricingScheduleIndexesFor(
    parsed,
    dateKey,
    weekdayInZone(dateObj, getTourTimezone(parsed)).toLowerCase(),
    selectedTime
  );
  if (priceIndexes !== null && priceIndexes.length === 0) {
    return {
      ok: false,
      reason: selectedTime
        ? 'Selected time is not available for this date'
        : 'Tour is not available on this date',
    };
  }

  // Per-slot ceiling when no day-wide cap is active; otherwise the day-wide cap
  // is the ceiling (already counted day-wide above).
  let effectiveCapacity = dayCapacity;
  if (selectedTime && !dayWide) {
    const slot = daySlots.find((s) => s.time === selectedTime);
    if (slot) effectiveCapacity = slot.capacity;
  }

  const requestedTravelers = travelerCount(travelers);
  let groupsRemaining = null;
  if (isPerGroup) {
    groupsRemaining = dayWide
      ? Math.max(0, capOverride - groupCount)
      : Math.max(0, maxGroups - groupCount);
  }

  // Traveler-based check: skipped for per-group tours with a day-wide cap —
  // the binding constraint there is the group ceiling (groupsRemaining).
  if (requestedTravelers > Math.max(0, effectiveCapacity - currentBookings) && !(dayWide && isPerGroup)) {
    const availableSpots = Math.max(0, effectiveCapacity - currentBookings);
    return {
      ok: false,
      reason: `Only ${availableSpots} spot${availableSpots === 1 ? '' : 's'} left, but ${requestedTravelers} requested`,
      availableSpots,
    };
  }
  if (isPerGroup && groupsRemaining <= 0) {
    return { ok: false, reason: 'No group slots remaining for this time', availableSpots: 0 };
  }

  return {
    ok: true,
    availableSpots: Math.max(0, effectiveCapacity - currentBookings),
    groupsRemaining,
    maxCapacity: effectiveCapacity,
    currentBookings,
    isPerGroup,
    maxGroups,
    daySlots,
  };
}

/**
 * Pure per-day availability evaluation — the single source of truth shared by
 * the availability calendar loop and the search re-check. Returns the exact
 * calendar day-entry shape for `dateObj`.
 *
 * `slotData` (nullable) carries pre-aggregated occupancy for the day:
 *   { bookedCount, bookingsBySlot: Map(slotTime -> travelers),
 *     groupsBySlot: Map(slotTime -> groups) }
 * `options`: { todayRef, fallbackCapacity, limitedRatio, fullRatio }.
 */
function computeDayEntry(parsed, override, slotData, dateObj, options = {}) {
  const fallback = options.fallbackCapacity != null ? options.fallbackCapacity : 50;
  const maxTravelersFallback = parseInt(fallback, 10) || 50;

  const isPerGroup = isPerGroupTour(parsed);
  const maxGroups = getMaxGroupsPerTimeSlot(parsed);
  const maxGroupSize = isPerGroup
    ? (() => {
        const bandTos = (Array.isArray(parsed?.travelerDetails?.groupSizes) ? parsed.travelerDetails.groupSizes : [])
          .map((g) => Number(g?.to)).filter((n) => Number.isFinite(n) && n > 0);
        return bandTos.length ? Math.max(...bandTos) : maxTravelersFallback;
      })()
    : null;

  // Traveler-equivalent capacity (per-group: groups × largest group size). Only
  // the per-slot ceiling — the aggregate day status for per-group tours uses
  // GROUP slots (see dayCapacity below). A day-limit override replaces the
  // per-person day capacity with the capped value; per-group traveler-equivalent
  // stays as-is (the cap is applied to the group day capacity below).
  const capOverride = getOverrideCapacity(override);
  const maxCapacity = isPerGroup
    ? maxGroups * maxGroupSize
    : (capOverride ?? getEffectiveCapacity(parsed, maxTravelersFallback));

  const timezone = getTourTimezone(parsed);
  const dateStr = toDateKey(dateObj);
  const dayOfWeek = weekdayInZone(dateObj, timezone);
  const operating = isOperatingDay(parsed, dateObj) && !isClosedDate(parsed, dateStr);

  const today = options.todayRef ? toUtcDate(options.todayRef) || todayUtc() : todayUtc();
  const isPast = dateObj < today;

  const bookingsBySlot = slotData?.bookingsBySlot || new Map();
  const groupsBySlot = slotData?.groupsBySlot || new Map();
  const bookedCount = slotData?.bookedCount || 0;

  const daySlots = buildTimeSlots(parsed, override, maxCapacity);
  const effectiveTimeSlots = daySlots.map((slot) => {
    const slotBooked = bookingsBySlot.get(slot.time) || 0;
    const groupsBooked = groupsBySlot.get(slot.time) || 0;
    return {
      time: slot.time,
      capacity: slot.capacity,
      booked: slotBooked,
      remaining: Math.max(0, slot.capacity - slotBooked),
      ...(isPerGroup ? { groupsBooked, groupsRemaining: Math.max(0, maxGroups - groupsBooked) } : {}),
    };
  });

  // Day-level occupancy for the aggregate status:
  //  - per-person tours: travelers vs maxParticipants (or the day-limit cap)
  //  - per-group tours: group slots vs maxGroups × slots that day (a day
  //    with no fixed slots holds one slot of maxGroups); a day-limit override
  //    replaces the day's group ceiling with the capped value.
  const baseCapacity = isPerGroup
    ? maxGroups * Math.max(1, effectiveTimeSlots.length)
    : getEffectiveCapacity(parsed, maxTravelersFallback);
  const dayCapacity = isPerGroup
    ? (capOverride ?? baseCapacity)
    : maxCapacity;
  const dayBooked = isPerGroup
    ? effectiveTimeSlots.reduce((sum, slot) => sum + (slot.groupsBooked || 0), 0)
    : bookedCount;

  const computedStatus = isPast ? 'PAST' : computeStatus(dayBooked, dayCapacity, override?.status || null, operating, options.limitedRatio, options.fullRatio);

  return {
    date: dateStr,
    dayOfWeek,
    timezone,
    isOperatingDay: operating,
    status: computedStatus,
    capacity: dayCapacity,
    booked: isPast ? 0 : dayBooked,
    remaining: isPast ? 0 : Math.max(0, dayCapacity - dayBooked),
    timeSlots: isPast ? [] : effectiveTimeSlots,
    hasOverride: !!override,
    overrideStatus: override?.status || null,
    overrideCapacity: capOverride,
    baseCapacity,
    isPast,
    ...(isPerGroup
      ? { capacityUnit: 'groups', groupsPerSlot: maxGroups, maxGroupSize, maxCapacityTravelers: maxCapacity }
      : { capacityUnit: 'people' }),
  };
}

/**
 * Parse an optional numeric config value. null/undefined/'' and non-finite
 * values are treated as absent — never coerced to 0 (which would silently
 * disable the cutoff).
 */
function parseConfigNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Resolve a tour's effective advance cutoff in hours from its
 * bookingAndTickets blob. The builder writes cutoffMinutes (minutes); legacy
 * rows carry minAdvanceBookingHours (hours). minutes win when present, then
 * hours, then the system default. Both checkout controllers share this so the
 * cutoff can never drift between them again.
 */
function resolveCutoffHours(bookingAndTickets, fallbackHours) {
  const minutes = parseConfigNumber(bookingAndTickets?.cutoffMinutes);
  if (minutes !== null) return minutes / 60;
  const hours = parseConfigNumber(bookingAndTickets?.minAdvanceBookingHours);
  if (hours !== null) return hours;
  return parseConfigNumber(fallbackHours) ?? 24;
}

/**
 * Resolve the effective cutoff for a specific time slot. When the tour opts
 * into per-slot cutoffs (perSlotCutoff), the slot's own value — keyed by its
 * start time ("HH:MM") in minutes — wins. A missing/unknown slot always falls
 * back to the global cutoff so a slot can never silently lose its deadline.
 * Values are bounded to the same 0..600 minute (10 h) range the write schema
 * enforces so out-of-band data degrades to the global cutoff.
 */
const MAX_PER_SLOT_CUTOFF_MINUTES = 600;

function resolveSlotCutoffHours(bookingAndTickets, slotTime, fallbackHours) {
  const perSlot = bookingAndTickets?.perSlotCutoffs;
  if (
    bookingAndTickets?.perSlotCutoff &&
    typeof perSlot === 'object' &&
    perSlot !== null &&
    !Array.isArray(perSlot) &&
    typeof slotTime === 'string'
  ) {
    const minutes = parseConfigNumber(perSlot[slotTime]);
    if (minutes !== null && minutes <= MAX_PER_SLOT_CUTOFF_MINUTES) return minutes / 60;
  }
  return resolveCutoffHours(bookingAndTickets, fallbackHours);
}

/** Human label for an effective cutoff — minutes for sub-hour values. */
function cutoffLabel(hours) {
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  return `${hours} hours`;
}

module.exports = {
  DAY_NAMES,
  BOOKABLE_STATUSES,
  statusLiteral,
  TRAVELER_COUNT_SQL,
  toDateKey,
  toUtcDate,
  todayUtc,
  parseBlob,
  travelerCount,
  isPerGroupTour,
  getMaxGroupsPerTimeSlot,
  getTemplateDaysOfWeek,
  isOperatingDay,
  pricingScheduleIndexesFor,
  hasPricingScheduleForDate,
  getDateExceptions,
  isClosedDate,
  getOverrideTimeSlotList,
  getTemplateTimeSlots,
  getEffectiveCapacity,
  getOverrideCapacity,
  buildTimeSlots,
  computeStatus,
  computeDayEntry,
  evaluateBookingAvailability,
  resolveCutoffHours,
  resolveSlotCutoffHours,
  cutoffLabel,
  parseConfigNumber,
  getTourTimezone,
  zonedDateKey,
  weekdayInZone,
  zonedTimeToUtc,
};
