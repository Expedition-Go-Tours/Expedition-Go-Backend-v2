/**
 * Tour Helpers - Production Ready
 * Utility functions for tour management and validation
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const prisma = require('./prismaClient');
const getConfig = require('./getConfig');
const { findBestDiscount } = require('./specialOfferEngine');
const { MAX_PRICE, isValidCurrencyCode, normalizeCurrency } = require('./currencyCodes');
const {
  BOOKABLE_STATUSES,
  TRAVELER_COUNT_SQL,
  parseBlob,
  travelerCount,
  isPerGroupTour,
  getMaxGroupsPerTimeSlot,
  isOperatingDay,
  isClosedDate,
  getEffectiveCapacity,
  buildTimeSlots,
  toDateKey,
  toUtcDate,
} = require('./availabilityCore');

// SQL-safe literal (constants only) used in raw capacity queries.
const statusLiteral = BOOKABLE_STATUSES.map((s) => `'${s}'`).join(', ');

/**
 * Coerce a price-like value to a finite number or null.
 * - null / undefined / ''  -> null (missing)
 * - finite number          -> unchanged
 * - numeric string         -> Number (e.g. "50" -> 50)
 * - anything else          -> null (garbage)
 */
function toFinitePrice(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Coerce + clamp a price into the safe [0, MAX_PRICE] range, or null when the
 * value is not a finite number. Used by rebuildSchedulePrices so the stored
 * blob never holds negative, NaN, Infinity, or overflow-priced values.
 */
function clampPrice(value) {
  const n = toFinitePrice(value);
  if (n == null) return null;
  return Math.min(Math.max(n, 0), MAX_PRICE);
}

/**
 * Classify a stored price value into a validation issue (or null when valid).
 * Used by validateStoredPricing at publish time. Policy: tours must charge a
 * positive, finite, in-range amount; free categories are expressed via
 * ticketNotRequired with a null price, not a zero price.
 */
function priceIssue(value) {
  if (value === null || value === undefined || value === '') return 'required';
  const n = toFinitePrice(value);
  if (n == null) return 'invalid';
  if (n > MAX_PRICE) return 'max';
  if (n <= 0) return 'positive';
  return null;
}

/**
 * Create unique slug for tour
 * @param {string} title
 * @param {object} db - Prisma client or transaction client
 * @param {number} attempt
 */
async function createSlug(title, db = prisma, attempt = 0) {
  const baseSlug = (title || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single
    .trim('-'); // Remove leading/trailing hyphens

  const slug = attempt > 0 ? `${baseSlug}-${attempt}` : baseSlug;

  const existingTour = await db.tour.findUnique({
    where: { slug }
  });

  if (existingTour) {
    return createSlug(title, db, attempt + 1);
  }

  return slug;
}

/**
 * Parse JSON string fields and convert numeric strings in a request body.
 * Called before validation so that checks see proper types (objects, arrays, numbers).
 */
function parseJsonFields(data) {
  if (!data || typeof data !== 'object') return data;

  const jsonFields = ['categorization', 'theme', 'productContent', 'schedulesAndPricing', 'bookingAndTickets', 'tags', 'existingPhotos'];
  for (const field of jsonFields) {
    if (typeof data[field] === 'string') {
      try { data[field] = JSON.parse(data[field]); } catch { /* leave as-is */ }
    }
  }

  // Convert lat/lng from strings to numbers (FormData sends strings)
  if (typeof data.latitude === 'string') {
    const n = parseFloat(data.latitude);
    if (!isNaN(n)) data.latitude = n;
  }
  if (typeof data.longitude === 'string') {
    const n = parseFloat(data.longitude);
    if (!isNaN(n)) data.longitude = n;
  }

  return data;
}

/**
 * Validate tour data structure — supports both flat 13-step store shape
 * and legacy nested JSON blob shape for backward compatibility.
 */
function validateTourData(data, isPartial = false) {
  const { productSchema } = require('./productSchema');

  try {
    // Use Zod validation schema
    const parsed = isPartial
      ? productSchema.partial().safeParse(data)
      : productSchema.safeParse(data);

    if (!parsed.success) {
      return {
        isValid: false,
        errors: parsed.error.issues.map(e => {
          const path = e.path.join('.');
          return path ? `${path}: ${e.message}` : e.message;
        })
      };
    }

    return {
      isValid: true,
      errors: []
    };
  } catch (error) {
    return {
      isValid: false,
      errors: [`Validation error: ${error.message}`]
    };
  }
}

/**
 * Validate categorization structure
 */
function validateCategorization(categorization) {
  try {
    // Basic structure validation
    if (typeof categorization !== 'object') return false;

    // Validate top-level transportMode (nested object: { air: [...], land: [...], water: [...] })
    if (categorization.transportMode) {
      if (typeof categorization.transportMode !== 'object' || Array.isArray(categorization.transportMode)) return false;
      const { air, land, water } = categorization.transportMode;
      if (air && !Array.isArray(air)) return false;
      if (land && !Array.isArray(land)) return false;
      if (water && !Array.isArray(water)) return false;
    }

    // Validate tour categorization
    if (categorization.tour) {
      const { transportModes } = categorization.tour;
      
      if (transportModes) {
        if (transportModes.airTransport && !Array.isArray(transportModes.airTransport)) return false;
        if (transportModes.landTransport && !Array.isArray(transportModes.landTransport)) return false;
        if (transportModes.waterTransport && !Array.isArray(transportModes.waterTransport)) return false;
      }
    }

    // Validate activity categorization
    if (categorization.activity) {
      const { activitiesIncluded } = categorization.activity;
      if (activitiesIncluded && !Array.isArray(activitiesIncluded)) return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Validate pricing structure — accepts the nested schedulesAndPricing blob
 * or flat store shape. Removed perBooking and maxTravelersPerBooking.
 */
function validatePricing(data) {
  const errors = [];

  try {
    // Support both flat store shape and nested schedulesAndPricing blob
    const travelerDetails = data.travelerDetails || data;
    const pricingSchedules = data.pricingSchedules || data;

    const {
      pricingModel,
      pricingApproach,
      ageGroups,
      minParticipants,
      maxParticipants,
      groupSizes,
      additionalPersonsEnabled,
      additionalPersonPrice,
      maxGroupsPerTimeSlot,
    } = travelerDetails;

    const {
      currency,
      schedules,
    } = pricingSchedules;

    if (pricingModel && !['perPerson', 'perGroup'].includes(pricingModel)) {
      errors.push('Valid pricing model is required (perPerson or perGroup)');
    }

    if (pricingApproach && !['sameForEveryone', 'dependsOnAge'].includes(pricingApproach)) {
      errors.push('Pricing approach must be sameForEveryone or dependsOnAge');
    }

    if (ageGroups && Array.isArray(ageGroups)) {
      for (const ageGroup of ageGroups) {
        if (!ageGroup.name || ageGroup.minAge === undefined || ageGroup.maxAge === undefined) {
          errors.push('Age groups must have name, minAge, and maxAge');
          break;
        }
        if (ageGroup.minAge < 0 || ageGroup.maxAge > 120 || ageGroup.minAge > ageGroup.maxAge) {
          errors.push('Invalid age range in age groups');
          break;
        }
      }
    }

    if (minParticipants !== undefined && (minParticipants < 1 || minParticipants > 100)) {
      errors.push('Min participants must be between 1 and 100');
    }

    if (maxParticipants !== undefined && (maxParticipants < 1 || maxParticipants > 100)) {
      errors.push('Max participants must be between 1 and 100');
    }

    if (minParticipants !== undefined && maxParticipants !== undefined && minParticipants > maxParticipants) {
      errors.push('Min participants cannot exceed max participants');
    }

    if (groupSizes && Array.isArray(groupSizes)) {
      const sorted = [...groupSizes].sort((a, b) => (a.from ?? 0) - (b.from ?? 0))
      for (let i = 0; i < sorted.length; i++) {
        const gs = sorted[i]
        if (gs.from == null || gs.to == null || gs.from < 1 || gs.to > 100) {
          errors.push('Each group size must have from (1-100) and to (1-100)');
          break;
        }
        if (gs.from > gs.to) {
          errors.push('Group size from cannot exceed to');
          break;
        }
        if (i > 0 && gs.from <= sorted[i - 1].to) {
          errors.push('Group sizes must not overlap');
          break;
        }
      }
    }

    if (additionalPersonsEnabled && (additionalPersonPrice === null || additionalPersonPrice === undefined)) {
      errors.push('Additional person price is required when additional persons are enabled');
    }

    if (maxGroupsPerTimeSlot !== undefined && (maxGroupsPerTimeSlot < 1 || maxGroupsPerTimeSlot > 50)) {
      errors.push('Max groups per time slot must be between 1 and 50');
    }

    if (currency && (typeof currency !== 'string' || currency.length !== 3)) {
      errors.push('Valid 3-letter currency code is required');
    }

    if (schedules && Array.isArray(schedules)) {
      for (const schedule of schedules) {
        if (schedule.startDate && schedule.endDate && new Date(schedule.endDate) < new Date(schedule.startDate)) {
          errors.push('Schedule end date must be on or after start date');
          break;
        }
      }
    }

  } catch {
    errors.push('Invalid pricing structure format');
  }

  return errors;
}

/**
 * Convert a categorization.duration object into minutes. Supports the supplier
 * dashboard's `{ value, unit }` shape as well as the legacy `{ hours }`,
 * `{ days }`, `{ weeks }`, and `{ minutes }` shapes. Returns null when the
 * duration cannot be resolved.
 *
 * @param {{ value?: number, unit?: string, hours?: number, days?: number, weeks?: number, minutes?: number }|null|undefined} duration
 * @returns {number|null}
 */
function durationToMinutes(duration) {
  if (!duration || typeof duration !== 'object') return null;

  const unitMultipliers = {
    minutes: 1,
    minute: 1,
    hours: 60,
    hour: 60,
    days: 1440,
    day: 1440,
    weeks: 10080,
    week: 10080,
  };

  if (duration.value != null && duration.unit) {
    const unit = String(duration.unit).toLowerCase();
    const multiplier = unitMultipliers[unit];
    if (multiplier && Number.isFinite(Number(duration.value))) {
      return Number(duration.value) * multiplier;
    }
    return null;
  }

  if (duration.hours != null && Number.isFinite(Number(duration.hours))) return Number(duration.hours) * 60;
  if (duration.days != null && Number.isFinite(Number(duration.days))) return Number(duration.days) * 1440;
  if (duration.weeks != null && Number.isFinite(Number(duration.weeks))) return Number(duration.weeks) * 10080;
  if (duration.minutes != null && Number.isFinite(Number(duration.minutes))) return Number(duration.minutes);

  return null;
}

/**
 * Regenerate the derived `prices` array on every pricing schedule from the
 * authoritative `travelerDetails` source-of-truth fields. Invoked on write so
 * the stored blob never holds stale, empty, or client-derived prices — the
 * server is the single author of `schedules[].prices`, which is what checkout
 * (`calculateTourPrice`) and the public "from $X" reads consume.
 *
 * Returns the input blob unchanged when it cannot be normalized (missing
 * schedules, non-object, etc.) so callers can pass the result straight to
 * `validateStoredPricing`.
 */
function rebuildSchedulePrices(blob) {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return blob;
  const td = blob.travelerDetails || {};
  const ps = blob.pricingSchedules;
  if (!ps || !Array.isArray(ps.schedules)) return blob;

  // Sanitize the authoritative source-of-truth price fields in place so the
  // stored blob never holds negative, non-finite, non-numeric, or overflowing
  // values that could produce NaN at checkout. Garbage that cannot be coerced
  // to a number is dropped to null (fails completeness at publish).
  if (td.uniformPrice != null) td.uniformPrice = clampPrice(td.uniformPrice);
  if (td.additionalPersonPrice != null) td.additionalPersonPrice = clampPrice(td.additionalPersonPrice);
  for (const list of [td.pricingCategories, td.ageGroups]) {
    if (Array.isArray(list)) {
      for (const c of list) {
        if (c && c.price != null) c.price = clampPrice(c.price);
      }
    }
  }
  if (Array.isArray(td.groupSizes)) {
    for (const gs of td.groupSizes) {
      if (gs && gs.price != null) gs.price = clampPrice(gs.price);
    }
  }

  const cats = (Array.isArray(td.pricingCategories) && td.pricingCategories.length > 0)
    ? td.pricingCategories
    : (Array.isArray(td.ageGroups) ? td.ageGroups : []);
  const groupSizes = Array.isArray(td.groupSizes) ? td.groupSizes : [];
  const pricingModel = td.pricingModel || 'perPerson';
  const pricingApproach = td.pricingApproach || 'dependsOnAge';

  const prices = [];
  if (pricingModel === 'perGroup') {
    for (const gs of groupSizes) {
      if (gs && gs.price != null) {
        prices.push({ label: `Group of ${gs.from}-${gs.to}`, retailPrice: clampPrice(gs.price), groupSize: true });
      }
    }
  } else if (pricingApproach === 'sameForEveryone') {
    if (td.uniformPrice != null) {
      prices.push({ ageGroup: 'Adult', retailPrice: clampPrice(td.uniformPrice) });
    }
  } else {
    for (const c of cats) {
      if (c && c.price != null) {
        prices.push({ ageGroup: c.name || c.label, retailPrice: clampPrice(c.price) });
      }
    }
  }

  for (const s of ps.schedules) {
    if (s && typeof s === 'object') {
      s.prices = prices.slice();
    }
  }

  return blob;
}

/**
 * Validate the stored schedulesAndPricing blob when a tour is set live
 * (status ACTIVE/PUBLISHED). Mirrors the supplier dashboard's step-14
 * wizard rules: at least one schedule, per-category prices present,
 * group-size prices present, capacity sane, and time slots / weekly
 * hours present per schedule type.
 */
function validateStoredPricing(blob) {
  const errors = [];

  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) {
    errors.push('Pricing and availability data is required');
    return errors;
  }

  const travelerDetails = blob.travelerDetails || {};
  const pricingSchedules = blob.pricingSchedules || {};
  const availability = blob.availability || {};
  const schedules = Array.isArray(pricingSchedules.schedules) ? pricingSchedules.schedules : [];
  const firstSchedule = schedules[0] || {};

  const pricingModel = travelerDetails.pricingModel || firstSchedule.pricingModel || 'perPerson';
  const pricingApproach = travelerDetails.pricingApproach || firstSchedule.pricingApproach || 'dependsOnAge';

  // At least one pricing schedule
  if (schedules.length === 0) {
    errors.push('Add at least one pricing schedule');
  }

  // Date sanity for each schedule
  for (let i = 0; i < schedules.length; i++) {
    const s = schedules[i];
    if (s && s.hasEndDate && s.startDate && s.endDate && new Date(s.endDate) < new Date(s.startDate)) {
      errors.push(`Schedule ${i + 1}: end date must be on or after the start date`);
    }
  }

  // Currency — a currency must be declared before the tour can charge
  // customers, and every declared currency must be a valid ISO 4217 code.
  const declaredCurrencies = [];
  if (pricingSchedules.currency != null && pricingSchedules.currency !== '') declaredCurrencies.push(pricingSchedules.currency);
  if (blob.currency != null && blob.currency !== '') declaredCurrencies.push(blob.currency);
  for (const s of schedules) {
    if (s && s.currency != null && s.currency !== '') declaredCurrencies.push(s.currency);
  }
  if (declaredCurrencies.length === 0) {
    errors.push('A currency code is required');
  } else {
    for (const c of declaredCurrencies) {
      if (!isValidCurrencyCode(c)) {
        errors.push(`"${c}" is not a valid ISO 4217 currency code`);
        break;
      }
    }
  }

  // Pricing completeness
  const cats = (Array.isArray(travelerDetails.pricingCategories) && travelerDetails.pricingCategories.length > 0)
    ? travelerDetails.pricingCategories
    : (Array.isArray(firstSchedule.pricingCategories) ? firstSchedule.pricingCategories : []);
  const groupSizes = (Array.isArray(travelerDetails.groupSizes) && travelerDetails.groupSizes.length > 0)
    ? travelerDetails.groupSizes
    : (Array.isArray(firstSchedule.groupSizes) ? firstSchedule.groupSizes : []);

  // Policy: a live tour must charge a positive, finite, in-range price. Free
  // traveler categories are expressed via ticketNotRequired with a null price,
  // never as a zero price. Any non-numeric, non-finite, or out-of-range price
  // is a hard publish blocker (guards checkout from producing NaN/Infinity).
  const describeIssue = (label, issue) => {
    if (issue === 'required') return `${label}: price is required`;
    if (issue === 'invalid') return `${label}: price must be a valid number`;
    if (issue === 'max') return `${label}: price cannot exceed ${MAX_PRICE}`;
    if (issue === 'positive') return `${label}: price must be greater than 0`;
    return null;
  };

  let hasPositivePrice = false;

  if (pricingModel === 'perGroup') {
    if (groupSizes.length === 0) {
      errors.push('Add at least one group size');
    }
    groupSizes.forEach((gs, i) => {
      if (gs == null) return;
      const issue = priceIssue(gs.price);
      if (issue) {
        errors.push(describeIssue(`Group size ${i + 1}`, issue));
      } else if (toFinitePrice(gs.price) > 0) {
        hasPositivePrice = true;
      }
    });
    if (!hasPositivePrice) {
      errors.push('At least one group size must have a price greater than 0');
    }
  } else if (pricingApproach === 'sameForEveryone') {
    const uniformPrice = travelerDetails.uniformPrice != null
      ? travelerDetails.uniformPrice
      : (firstSchedule.uniformPrice != null ? firstSchedule.uniformPrice : null);
    if (uniformPrice == null) {
      errors.push('Enter a price per person');
    } else {
      const issue = priceIssue(uniformPrice);
      if (issue === 'invalid') errors.push('Price per person must be a valid number');
      else if (issue === 'max') errors.push(`Price per person cannot exceed ${MAX_PRICE}`);
      else if (issue === 'positive') errors.push('Price per person must be greater than 0');
    }
  } else {
    // dependsOnAge
    if (cats.length === 0) {
      errors.push('Add at least one pricing category');
    }
    cats.forEach((cat, i) => {
      if (cat == null) return;
      const isFree = cat.ticketNotRequired === true;
      if (isFree && (cat.price == null || cat.price === '')) {
        return; // free categories (e.g. infants) carry no price
      }
      const issue = priceIssue(cat.price);
      if (issue) {
        errors.push(describeIssue(`Pricing category "${cat.name || i + 1}"`, issue));
      } else if (toFinitePrice(cat.price) > 0) {
        hasPositivePrice = true;
      }
    });
    if (!hasPositivePrice) {
      errors.push('Add at least one pricing category with a price greater than 0');
    }
  }

  // Capacity sanity
  const min = travelerDetails.minParticipants ?? firstSchedule.minParticipants;
  const max = travelerDetails.maxParticipants ?? firstSchedule.maxParticipants;
  const minN = toFinitePrice(min);
  const maxN = toFinitePrice(max);
  if (minN != null && maxN != null && minN > maxN) {
    errors.push('Min participants cannot exceed max participants');
  }

  // Schedule type: fixedTimeSlot needs time slots; operatingHours needs weekly hours
  const scheduleType = availability.scheduleType || firstSchedule.type || 'fixedTimeSlot';
  if (scheduleType === 'fixedTimeSlot') {
    const timeSlots = (Array.isArray(availability.timeSlots) && availability.timeSlots.length > 0)
      ? availability.timeSlots
      : (Array.isArray(firstSchedule.timeSlots) ? firstSchedule.timeSlots : []);
    if (timeSlots.length === 0) {
      errors.push('Add at least one time slot');
    }
  } else if (scheduleType === 'operatingHours') {
    const weekly = availability.weeklySchedule || firstSchedule.weeklySchedule;
    const hasAnyHours = weekly && typeof weekly === 'object' &&
      Object.values(weekly).some((slots) => Array.isArray(slots) && slots.length > 0);
    if (!hasAnyHours) {
      errors.push('Add at least one opening hours entry');
    }
  }

  return errors;
}

/**
 * Calculate tour availability for a given date (+ optional time slot).
 * Uses the shared availability core so the rules (traveler-based capacity,
 * PENDING occupancy, TourDateOverride, dateExceptions, per-group cap,
 * per-slot capacity) are identical to the checkout transactions.
 *
 * @param {string} tourId
 * @param {string|Date} selectedDate   YYYY-MM-DD (UTC) or Date
 * @param {object|string|null} selectedTimeOrOptions
 *   - string: the requested time slot (legacy positional arg)
 *   - object: { selectedTime, travelers } — travelers enables capacity pre-check
 */
async function checkTourAvailability(tourId, selectedDate, selectedTimeOrOptions = null) {
  try {
    const tour = await prisma.tour.findUnique({
      where: { id: tourId },
      select: { id: true, status: true, schedulesAndPricing: true },
    });

    if (!tour) return { available: false, reason: 'Tour not found' };
    if (tour.status !== 'ACTIVE') return { available: false, reason: 'Tour is not active' };

    let selectedTime = null;
    let requestedTravelers = 0;
    if (selectedTimeOrOptions && typeof selectedTimeOrOptions === 'object') {
      selectedTime = selectedTimeOrOptions.selectedTime || null;
      requestedTravelers = travelerCount(selectedTimeOrOptions.travelers) || 0;
    } else if (typeof selectedTimeOrOptions === 'string' && selectedTimeOrOptions) {
      selectedTime = selectedTimeOrOptions;
    }

    const parsed = parseBlob(tour.schedulesAndPricing);
    const dateObj = toUtcDate(selectedDate);
    if (!dateObj) return { available: false, reason: 'Invalid date' };
    const dateKey = toDateKey(dateObj);

    const maxTravelersFallback = parseInt(await getConfig('booking.max_travelers', '50'), 10);
    const isPerGroup = isPerGroupTour(parsed);
    const maxGroups = getMaxGroupsPerTimeSlot(parsed);

    const [override, counts] = await Promise.all([
      prisma.tourDateOverride.findFirst({
        where: { tourId, date: dateObj },
        select: { status: true, capacity: true, timeSlotOverrides: true },
      }),
      prisma.$queryRawUnsafe(
        `SELECT
           COALESCE(SUM(CASE WHEN status IN (${statusLiteral})
             THEN ${TRAVELER_COUNT_SQL} ELSE 0 END), 0)::int AS "currentBookings",
           COALESCE(COUNT(*) FILTER (WHERE status IN (${statusLiteral})), 0)::int AS "groupCount"
         FROM "Booking"
         WHERE "tourId" = $1 AND "selectedDate" = $2::date
           ${selectedTime ? 'AND "selectedTime" = $3' : ''}`,
        tourId,
        dateKey,
        ...(selectedTime ? [selectedTime] : [])
      ),
    ]);

    const row = counts && counts[0] ? counts[0] : { currentBookings: 0, groupCount: 0 };
    const currentBookings = parseInt(row.currentBookings, 10) || 0;
    const groupCount = parseInt(row.groupCount, 10) || 0;

    const closedDate = isClosedDate(parsed, dateKey) || null;
    const operating = isOperatingDay(parsed, dateObj);
    const dayCapacity = getEffectiveCapacity(parsed, override, maxTravelersFallback);
    const daySlots = buildTimeSlots(parsed, override, dayCapacity);

    const base = {
      overrideStatus: override?.status || null,
      isPerGroup,
      maxGroups,
      closedDate,
      isOperatingDay: operating,
      timeSlots: daySlots,
    };

    if (closedDate || !operating) {
      return { available: false, reason: 'Tour is not available on this date', maxCapacity: dayCapacity, currentBookings, availableSpots: 0, groupsRemaining: isPerGroup ? 0 : null, ...base };
    }
    if (override?.status === 'BLOCKED') {
      return { available: false, reason: 'Date is blocked', maxCapacity: dayCapacity, currentBookings, availableSpots: 0, groupsRemaining: isPerGroup ? 0 : null, ...base };
    }
    if (override?.status === 'FULL') {
      return { available: false, reason: 'Date is fully booked', maxCapacity: dayCapacity, currentBookings, availableSpots: 0, groupsRemaining: isPerGroup ? 0 : null, ...base };
    }

    // Fixed-slot tours must carry a concrete, valid time slot.
    if (daySlots.length > 0) {
      if (!selectedTime) {
        return { available: false, reason: 'A time slot must be selected', maxCapacity: dayCapacity, currentBookings, availableSpots: 0, groupsRemaining: isPerGroup ? 0 : null, ...base };
      }
      if (!daySlots.some((s) => s.time === selectedTime)) {
        return { available: false, reason: 'Selected time is not available for this date', maxCapacity: dayCapacity, currentBookings, availableSpots: 0, groupsRemaining: isPerGroup ? 0 : null, ...base };
      }
    }

    // When a slot is chosen, capacity is evaluated at the slot level; otherwise
    // at the whole-day level.
    let effectiveCapacity = dayCapacity;
    if (selectedTime) {
      const slot = daySlots.find((s) => s.time === selectedTime);
      if (slot) effectiveCapacity = slot.capacity;
    }

    const availableSpots = Math.max(0, effectiveCapacity - currentBookings);
    let groupsRemaining = null;
    if (isPerGroup) groupsRemaining = Math.max(0, maxGroups - groupCount);

    let available = availableSpots > 0;
    if (isPerGroup) available = available && groupsRemaining > 0;
    if (requestedTravelers > 0 && requestedTravelers > availableSpots) available = false;

    let reason;
    if (!available) {
      if (requestedTravelers > availableSpots) {
        reason = `Only ${availableSpots} spot${availableSpots === 1 ? '' : 's'} left, but ${requestedTravelers} requested`;
      } else if (isPerGroup && groupsRemaining <= 0) {
        reason = 'No group slots remaining for this time';
      } else {
        reason = 'Date is fully booked';
      }
    }

    return {
      available,
      ...(reason && { reason }),
      maxCapacity: effectiveCapacity,
      currentBookings,
      availableSpots,
      groupsRemaining,
      ...base,
    };
  } catch (error) {
    console.error('❌ Check availability failed:', error);
    return { available: false, reason: 'Error checking availability' };
  }
}

/**
 * Get tour pricing for specific date and travelers
 */
async function calculateTourPrice(tour, travelers, selectedDate, selectedTime = null, tourOptionKey = null, customerId = null) {
  try {
    const pricing = tour.schedulesAndPricing;
    if (!pricing || !pricing.pricingSchedules) {
      throw new Error('No pricing information available');
    }

    const { schedules } = pricing.pricingSchedules;
    const currency = normalizeCurrency(pricing.pricingSchedules.currency);
    
    // Find applicable schedule
    const applicableSchedule = schedules.find(schedule => {
      const startDate = new Date(schedule.startDate);
      const endDate = schedule.endDate ? new Date(schedule.endDate) : null;
      const bookingDate = new Date(selectedDate);

      if (bookingDate < startDate) return false;
      if (endDate && bookingDate > endDate) return false;

      // Check day of week if specified
      if (schedule.prices[0]?.days && schedule.prices[0].days.length > 0) {
        const dayName = bookingDate.toLocaleDateString('en-US', { weekday: 'long' });
        if (!schedule.prices[0].days.includes(dayName)) return false;
      }

      // Check time if specified
      if (selectedTime && schedule.prices[0]?.times && schedule.prices[0].times.length > 0) {
        if (!schedule.prices[0].times.includes(selectedTime)) return false;
      }

      return true;
    });

    if (!applicableSchedule) {
      throw new Error('No pricing available for selected date/time');
    }

    // Calculate total price from the authoritative travelerDetails source of
    // truth, so an empty/stale derived `prices` array can never price a live
    // tour at $0. Any missing/unpriceable traveler fails closed.
    const td = pricing.travelerDetails || {};
    const pricingModel = td.pricingModel || applicableSchedule.pricingModel || 'perPerson';
    const pricingApproach = td.pricingApproach || applicableSchedule.pricingApproach || 'dependsOnAge';

    let subtotal = 0;

    if (pricingModel === 'perGroup') {
      const groupSizes = Array.isArray(td.groupSizes) ? td.groupSizes : [];
      const totalTravelers = Object.values(travelers).reduce((sum, count) => sum + (typeof count === 'number' ? count : 0), 0);
      if (totalTravelers < 1) {
        throw new Error('At least one traveler is required');
      }
      const match = groupSizes.find(gs => gs && totalTravelers >= gs.from && totalTravelers <= gs.to);
      const matchPrice = toFinitePrice(match && match.price);
      if (matchPrice == null) {
        throw new Error('No price available for the selected group size');
      }
      subtotal = matchPrice;
    } else if (pricingApproach === 'sameForEveryone') {
      const uniformPrice = toFinitePrice(
        td.uniformPrice != null ? td.uniformPrice : applicableSchedule.uniformPrice
      );
      if (uniformPrice == null) {
        throw new Error('No pricing available for this tour');
      }
      for (const count of Object.values(travelers)) {
        if (typeof count === 'number' && count > 0) {
          subtotal += uniformPrice * count;
        }
      }
    } else {
      // dependsOnAge — price per traveler, preferring travelerDetails
      // pricingCategories and falling back to the schedule's derived prices
      const cats = (Array.isArray(td.pricingCategories) && td.pricingCategories.length > 0)
        ? td.pricingCategories
        : (Array.isArray(td.ageGroups) ? td.ageGroups : []);
      let priced = false;
      const IRREGULAR_PLURALS = { children: 'child', infants: 'infant', men: 'man', women: 'woman' };
      for (const [ageCategory, count] of Object.entries(travelers)) {
        if (typeof count !== 'number' || count <= 0) continue;
        const lower = ageCategory.toLowerCase();
        const normalized = IRREGULAR_PLURALS[lower] || lower.replace(/s$/, '');
        const cat = cats.find(c => {
          const label = String(c.name ?? c.label ?? '').toLowerCase();
          return label === normalized || label === ageCategory.toLowerCase();
        });
        let price = (cat != null && cat.price != null) ? cat.price : null;
        if (price == null && Array.isArray(applicableSchedule.prices)) {
          const label = cat ? (cat.name || cat.label) : null;
          const priceInfo = label
            ? applicableSchedule.prices.find(p => p.ageGroup === label)
            : applicableSchedule.prices.find(p =>
                p.ageGroup?.toLowerCase() === normalized || p.ageGroup?.toLowerCase() === ageCategory.toLowerCase());
          if (priceInfo && priceInfo.retailPrice != null) {
            price = priceInfo.retailPrice;
          }
        }
        const finitePrice = toFinitePrice(price);
        if (finitePrice != null) {
          subtotal += finitePrice * count;
          priced = true;
        }
      }
      if (!priced) {
        throw new Error('No pricing available for this tour');
      }
    }

    // Fail closed: garbage (NaN/Infinity/string) prices must never reach the
    // amount Stripe charges. If any unpriceable data slipped through, abort.
    if (!Number.isFinite(subtotal)) {
      throw new Error('Invalid pricing information');
    }

    // Apply promotions if any
    let discount = 0;
    if (pricing.promotions && pricing.promotions.length > 0) {
      const activePromotions = pricing.promotions.filter(promo => {
        if (!promo.isActive) return false;
        
        const now = new Date();
        const startDate = new Date(promo.startDate);
        const endDate = new Date(promo.endDate);
        
        return now >= startDate && now <= endDate;
      });

      // Apply best promotion — discount values are clamped so a malformed
      // promotion can never produce a negative charge.
      for (const promo of activePromotions) {
        let promoDiscount = 0;

        if (promo.type === 'percentage') {
          const pct = toFinitePrice(promo.discountValue);
          const clampedPct = pct == null ? 0 : Math.min(Math.max(pct, 0), 100);
          promoDiscount = subtotal * (clampedPct / 100);
        } else if (promo.type === 'fixedAmount') {
          const fixed = toFinitePrice(promo.discountValue);
          promoDiscount = fixed == null ? 0 : Math.max(fixed, 0);
        }

        const maxDiscount = toFinitePrice(promo.maximumDiscountAmount);
        if (maxDiscount != null) {
          promoDiscount = Math.min(promoDiscount, Math.max(maxDiscount, 0));
        }

        // A single promotion can never discount more than the full subtotal.
        promoDiscount = Math.min(promoDiscount, subtotal);

        discount = Math.max(discount, promoDiscount);
      }
    }

    let appliedOffer = null;

    const totalTravelers = Object.values(travelers).reduce((sum, count) => sum + (typeof count === 'number' ? count : 0), 0);
    const specialOfferResult = await findBestDiscount({
      tourId: tour.id,
      tourOptionKey,
      selectedDate: new Date(selectedDate),
      basePrice: subtotal,
      quantity: totalTravelers,
      customerId,
    }).catch(() => ({ discountAmount: 0, finalPrice: subtotal, appliedOffer: null, discountType: null }));

    const finalPrice = Number.isFinite(specialOfferResult.finalPrice) ? specialOfferResult.finalPrice : subtotal;
    const specialDiscount = subtotal - Math.min(finalPrice, subtotal);
    if (specialDiscount > 0 && specialDiscount > discount) {
      discount = specialDiscount;
      appliedOffer = specialOfferResult.appliedOffer;
    }

    // Clamp the discount to [0, subtotal] and floor the total at 0 so a
    // malformed promotion/special-offer can never produce a negative charge.
    discount = Math.min(Math.max(discount, 0), subtotal);
    const total = Math.max(0, subtotal - discount);

    return {
      success: true,
      subtotal,
      discount,
      total,
      currency,
      appliedOffer,
      breakdown: {
        travelers,
        applicableSchedule: applicableSchedule.startDate
      }
    };

  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  createSlug,
  parseJsonFields,
  validateTourData,
  validateStoredPricing,
  rebuildSchedulePrices,
  durationToMinutes,
  checkTourAvailability,
  calculateTourPrice,
};