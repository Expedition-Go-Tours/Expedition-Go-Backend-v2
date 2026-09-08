/**
 * Tour options — per-option runtime projection + validation.
 *
 * The product builder stores each sellable option under
 * `Tour.productContent.options[]` with its own three blobs:
 *   option.pricing      → { pricingModel, currency, pricingApproach, uniformPrice,
 *                           pricingCategories[{name, price, minAge, maxAge, tiers, …}],
 *                           minParticipants, maxParticipants, groupSizes, … }
 *   option.availability → { scheduleType, timezone, weeklySchedule, timeSlots,
 *                           dateExceptions, operatingHoursStart/End, schedules[] }
 *   option.cutoff       → { cutoffMinutes, lastMinuteBookings, perSlotCutoff,
 *                           perSlotCutoffs }
 *
 * The booking engine is single-blob (one schedulesAndPricing + bookingAndTickets
 * per tour). These helpers project ONE option into that exact engine format so
 * the same pure functions (availability calendar, pricing, capacity, cut-offs)
 * can run per option without any engine rewrite.
 *
 * Product rule (v1): ONE price list per option. An option's schedules are its
 * availability windows / slots only; every schedule must agree with the option's
 * price list (see validateTourOptions).
 */

const { DAY_NAMES } = require('./availabilityCore');

function parseJsonish(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

/** Normalize an age/pricing category entry to the engine's shape. */
function normalizeCategory(c) {
  if (!c || typeof c !== 'object') return null;
  const name = c.name || c.label;
  if (!name) return null;
  return {
    name,
    price: c.price != null ? Number(c.price) : null,
    minAge: c.minAge != null ? Number(c.minAge) : null,
    maxAge: c.maxAge != null ? Number(c.maxAge) : null,
    notAllowed: c.notAllowed === true,
    ticketNotRequired: c.ticketNotRequired === true,
    needsAdult: c.needsAdult === true,
    tiers: Array.isArray(c.tiers)
      ? c.tiers.map((t) => ({
          from: t.from != null ? Number(t.from) : null,
          to: t.to != null ? Number(t.to) : null,
          pricePerPerson: t.pricePerPerson != null ? Number(t.pricePerPerson) : null,
        }))
      : undefined,
  };
}

/** Derive the price entry list the engine stores on each schedule. */
function priceEntriesFrom(cats, pricingModel, groupSizes) {
  const entries = [];
  if (pricingModel === 'perGroup') {
    if (Array.isArray(groupSizes)) {
      for (const gs of groupSizes) {
        if (gs && gs.price != null) {
          const from = gs.from ?? 1;
          const to = gs.to ?? from;
          entries.push({ label: from === to ? `Group of ${from}` : `Group of ${from}-${to}`, retailPrice: Number(gs.price), groupSize: true });
        }
      }
    }
    return entries;
  }
  for (const c of cats) {
    if (c && !c.notAllowed && !c.ticketNotRequired && c.price != null) {
      entries.push({ ageGroup: c.name, retailPrice: c.price });
    }
  }
  return entries;
}

function weekdayKeys(weekly) {
  if (!weekly || typeof weekly !== 'object') return [];
  return Object.entries(weekly)
    .filter(([, slots]) => Array.isArray(slots) && slots.length > 0)
    .map(([day]) => day);
}

function firstOf(list) { return Array.isArray(list) && list.length > 0 ? list : undefined; }

/**
 * Extract the option list stored on a Tour (from productContent.options).
 * Tolerant of missing/invalid productContent.
 */
function getTourOptions(tour) {
  const pc = parseJsonish(tour && tour.productContent) || {};
  const options = Array.isArray(pc.options) ? pc.options.filter((o) => o && typeof o === 'object') : [];
  return options;
}

/** The default (first) option — what option-agnostic bookings resolve to. */
function defaultOption(tour) {
  const options = getTourOptions(tour);
  return options.length > 0 ? options[0] : null;
}

/**
 * Resolve an option by its stable id (preferred), refCode, or the literal
 * 'default' / first option when nothing matches.
 * @returns {{ option: object|null, index: number }}
 */
function resolveTourOption(tour, selector) {
  const options = getTourOptions(tour);
  if (options.length === 0) return { option: null, index: -1 };
  if (typeof selector === 'string' && selector && selector !== 'default') {
    const found = options.findIndex((o) => o.id === selector || o.refCode === selector);
    if (found >= 0) return { option: options[found], index: found };
  }
  return { option: options[0], index: 0 };
}

/** List of weekday names that have at least one weekly window across schedules. */
function activeDaysOf(option) {
  const avail = parseJsonish(option && option.availability) || {};
  const weeklyTop = avail.weeklySchedule && typeof avail.weeklySchedule === 'object' ? avail.weeklySchedule : null;
  const fromTop = weekdayKeys(weeklyTop);
  if (fromTop.length > 0) return fromTop;

  const schedules = Array.isArray(avail.schedules) ? avail.schedules : [];
  const union = new Set();
  for (const s of schedules) {
    const weekly = s && s.weeklySchedule && typeof s.weeklySchedule === 'object' ? s.weeklySchedule : null;
    if (weekly) for (const d of weekdayKeys(weekly)) union.add(d);
  }
  return union.size > 0 ? Array.from(union) : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
}

/**
 * Project one option into the engine's canonical schedulesAndPricing blob.
 * The price list (travelerDetails + per-schedule prices) is the option's single
 * list; schedules carry only their own windows/weekly/timeSlots/exceptions.
 */
function buildProjectedSchedulesAndPricing(option) {
  const avail = parseJsonish(option && option.availability) || {};
  const pricing = parseJsonish(option && option.pricing) || {};
  const cats = (Array.isArray(pricing.pricingCategories) ? pricing.pricingCategories : [])
    .map(normalizeCategory)
    .filter(Boolean);

  const pricingModel = pricing.pricingModel || 'perPerson';
  const pricingApproach = pricing.pricingApproach || 'dependsOnAge';
  const currency = pricing.currency || 'USD';
  const minParticipants = pricing.minParticipants != null ? Number(pricing.minParticipants) : null;
  const maxParticipants = pricing.maxParticipants != null ? Number(pricing.maxParticipants) : null;
  const groupSizes = Array.isArray(pricing.groupSizes) ? pricing.groupSizes : [];
  const scheduleType = avail.scheduleType || 'operatingHours';
  const timezone = avail.timezone || 'UTC';

  const basePrices = priceEntriesFrom(cats, pricingModel, groupSizes);

  const schedules = Array.isArray(avail.schedules) ? avail.schedules : [];
  const scheduleList = schedules.length > 0
    ? schedules
    : [{
        name: (option && option.title) || '',
        type: scheduleType,
        weeklySchedule: avail.weeklySchedule || null,
        dateExceptions: avail.dateExceptions || [],
        timeSlots: avail.timeSlots || [],
      }];

  const engineSchedules = scheduleList.map((s) => {
    const slotTime = Array.isArray(s.timeSlots) ? s.timeSlots : (Array.isArray(avail.timeSlots) ? avail.timeSlots : []);
    const weekly = s.weeklySchedule && typeof s.weeklySchedule === 'object'
      ? s.weeklySchedule
      : (avail.weeklySchedule && typeof avail.weeklySchedule === 'object' ? avail.weeklySchedule : null);
    const exceptions = Array.isArray(s.dateExceptions) ? s.dateExceptions : (Array.isArray(avail.dateExceptions) ? avail.dateExceptions : []);
    return {
      name: s.name || (option && option.title) || '',
      type: s.type || scheduleType,
      startDate: s.startDate || '',
      hasEndDate: !!s.hasEndDate,
      endDate: s.hasEndDate ? (s.endDate || '') : null,
      weeklySchedule: weekly,
      dateExceptions: exceptions,
      timeSlots: slotTime,
      pricingModel,
      currency,
      pricingApproach,
      uniformPrice: pricing.uniformPrice != null ? Number(pricing.uniformPrice) : null,
      pricingCategories: cats,
      prices: basePrices,
      minParticipants,
      maxParticipants,
      maxGroupsPerTimeSlot: pricing.maxGroupsPerTimeSlot != null ? Number(pricing.maxGroupsPerTimeSlot) : 1,
      groupSizes,
      additionalPersonsEnabled: !!pricing.additionalPersonsEnabled,
      additionalPersonPrice: pricing.additionalPersonPrice != null ? Number(pricing.additionalPersonPrice) : null,
    };
  });

  const weeklyAgg = avail.weeklySchedule && typeof avail.weeklySchedule === 'object' ? avail.weeklySchedule : (engineSchedules[0] && engineSchedules[0].weeklySchedule) || null;
  const slotList = Array.isArray(avail.timeSlots) && avail.timeSlots.length > 0
    ? avail.timeSlots
    : firstOf(engineSchedules[0] && engineSchedules[0].timeSlots) || [];
  const activeDays = activeDaysOf(option);
  const first = engineSchedules[0] || {};

  const availability = {
    scheduleType,
    operatingHoursStart: avail.operatingHoursStart || '09:00',
    operatingHoursEnd: avail.operatingHoursEnd || '17:00',
    daysOfWeek: activeDays,
    weeklySchedule: weeklyAgg,
    timeSlots: slotList.map((t) => (typeof t === 'string' ? { startTime: t, endTime: '' } : t)),
    startDate: first.startDate || '',
    endDate: first.hasEndDate ? (first.endDate || '') : null,
    timezone,
  };

  return {
    travelerDetails: {
      pricingModel,
      pricingApproach,
      uniformPrice: pricing.uniformPrice != null ? Number(pricing.uniformPrice) : null,
      pricingCategories: cats,
      ageGroups: cats.map((c) => ({ label: c.name, minAge: c.minAge, maxAge: c.maxAge })),
      minParticipants,
      maxParticipants,
      groupSizes,
      additionalPersonsEnabled: !!pricing.additionalPersonsEnabled,
      additionalPersonPrice: pricing.additionalPersonPrice != null ? Number(pricing.additionalPersonPrice) : null,
      maxGroupsPerTimeSlot: pricing.maxGroupsPerTimeSlot != null ? Number(pricing.maxGroupsPerTimeSlot) : 1,
    },
    pricingSchedules: {
      currency,
      schedules: engineSchedules,
    },
    availability,
  };
}

/**
 * Project the option's cut-off onto the tour's bookingAndTickets blob, keeping
 * every non-cutoff key (meeting/pickup/cancellation/…) intact for that tour.
 */
function projectOptionBookingAndTickets(tour, option) {
  const base = parseJsonish(tour && tour.bookingAndTickets) || {};
  if (!option) return base;
  const cutoff = parseJsonish(option.cutoff) || {};
  const avail = parseJsonish(option.availability) || {};
  return {
    ...base,
    ...(cutoff.cutoffMinutes != null ? { cutoffMinutes: Number(cutoff.cutoffMinutes) } : {}),
    ...(cutoff.perSlotCutoff != null ? { perSlotCutoff: !!cutoff.perSlotCutoff } : {}),
    ...(cutoff.perSlotCutoffs && typeof cutoff.perSlotCutoffs === 'object' ? { perSlotCutoffs: cutoff.perSlotCutoffs } : {}),
    ...(cutoff.lastMinuteBookings != null ? { lastMinuteBookings: !!cutoff.lastMinuteBookings } : {}),
    timezone: avail.timezone || base.timezone || 'UTC',
  };
}

/**
 * Full per-option engine projection.
 * @returns {{ option, optionId, optionTitle, schedulesAndPricing, bookingAndTickets }}
 */
function projectOption(tour, selector) {
  const { option } = resolveTourOption(tour, selector);
  if (!option) {
    // No options on this tour — return the stored single-option blobs untouched
    // so legacy behavior is byte-for-byte unchanged.
    return {
      option: null,
      optionId: null,
      optionTitle: null,
      schedulesAndPricing: parseJsonish(tour && tour.schedulesAndPricing) || {},
      bookingAndTickets: parseJsonish(tour && tour.bookingAndTickets) || {},
    };
  }
  return {
    option,
    optionId: typeof option.id === 'string' ? option.id : (option.refCode || null),
    optionTitle: option.title || null,
    schedulesAndPricing: buildProjectedSchedulesAndPricing(option),
    bookingAndTickets: projectOptionBookingAndTickets(tour, option),
  };
}

/**
 * Server-side sanity validation for a Tour's option blobs (the editor currently
 * persists them as unchecked passthrough). Enforces the v1 product rule: one
 * price list per option — every schedule must agree with the option's own
 * pricingCategories. Errors are advisory today (not yet gating saves) so legacy
 * data can be cleaned up first.
 *
 * @param {object} tour Tour row (or a productContent object).
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateTourOptions(tour) {
  const options = getTourOptions(tour);
  const errors = [];
  if (options.length === 0) return { ok: true, errors };

  options.forEach((option, idx) => {
    const label = option.title || option.refCode || `Option ${idx + 1}`;
    if (!option.id) errors.push(`${label}: missing option id`);
    const pricing = parseJsonish(option.pricing) || {};
    const cutoff = parseJsonish(option.cutoff) || {};
    const avail = parseJsonish(option.availability) || {};

    if (cutoff.cutoffMinutes != null && !(cutoff.cutoffMinutes >= 0 && cutoff.cutoffMinutes <= 600)) {
      errors.push(`${label}: cutoffMinutes must be 0–600 minutes`);
    }
    if (cutoff.perSlotCutoffs && typeof cutoff.perSlotCutoffs === 'object') {
      for (const [time, minutes] of Object.entries(cutoff.perSlotCutoffs)) {
        if (!(Number.isFinite(minutes) && minutes >= 0 && minutes <= 600)) {
          errors.push(`${label}: per-slot cut-off for ${time} must be 0–600 minutes`);
        }
      }
    }
    const cats = (Array.isArray(pricing.pricingCategories) ? pricing.pricingCategories : [])
      .map(normalizeCategory)
      .filter(Boolean);
    if (cats.length === 0 && pricing.pricingModel !== 'perGroup' && pricing.pricingModel !== 'uniform' && !pricing.uniformPrice) {
      errors.push(`${label}: no price list configured`);
    }
    const schedules = Array.isArray(avail.schedules) ? avail.schedules : [];
    if (schedules.length === 0 && (!avail.weeklySchedule || !Array.isArray(avail.timeSlots))) {
      errors.push(`${label}: no availability schedules configured`);
    }
    // One price list per option: schedules must not disagree with option.pricing.
    const canonical = JSON.stringify(cats.map((c) => [c.name, c.price]));
    for (const s of schedules) {
      const sCats = (Array.isArray(s.pricingCategories) ? s.pricingCategories : [])
        .map(normalizeCategory)
        .filter(Boolean)
        .map((c) => [c.name, c.price]);
      if (sCats.length > 0 && JSON.stringify(sCats) !== canonical) {
        errors.push(`${label}: schedule "${s.name || 'unnamed'}" has prices that differ from the option's price list`);
      }
    }
  });

  return { ok: errors.length === 0, errors };
}

/** Light storefront summary of an option (no pricing math — computed elsewhere). */
function optionSummaries(tour) {
  return getTourOptions(tour).map((o) => {
    const pricing = parseJsonish(o.pricing) || {};
    const model = pricing.pricingModel || 'perPerson';
    let fromPrice = null;
    let currency = pricing.currency || 'USD';

    if (model === 'perGroup') {
      const gs = Array.isArray(pricing.groupSizes) ? pricing.groupSizes : [];
      const min = gs.reduce((acc, g) => (g && g.price != null && (acc === null || Number(g.price) < acc) ? Number(g.price) : acc), null);
      fromPrice = min;
    } else if (pricing.uniformPrice != null) {
      fromPrice = Number(pricing.uniformPrice);
    } else {
      const cats = (Array.isArray(pricing.pricingCategories) ? pricing.pricingCategories : [])
        .map(normalizeCategory)
        .filter((c) => c && c.price != null && !c.notAllowed);
      const adultish = cats.filter((c) => /adult|senior/i.test(c.name));
      const pool = adultish.length > 0 ? adultish : cats;
      const min = pool.reduce((acc, c) => (acc === null || c.price < acc ? c.price : acc), null);
      fromPrice = min != null ? min : null;
    }

    return {
      id: o.id,
      title: o.title || '',
      refCode: o.refCode || '',
      isPrivate: !!o.isPrivate,
      skipTheLine: o.skipTheLine || 'none',
      description: o.description || null,
      audioGuide: !!o.audioGuide,
      infoBooklet: !!o.infoBooklet,
      maxGroupSize: o.maxGroupSize ?? null,
      validityType: o.validityType || null,
      validity: o.validity ?? null,
      validityUnit: o.validityUnit || null,
      fromPrice,
      currency,
    };
  });
}

/**
 * Capacity scope for an option when the tour is multi-option.
 * Returns null for option-less tours (whole-tour counting, unchanged).
 *  - default/first option → { id, includeNull: true } (legacy NULL rows count)
 *  - any other option      → { id, includeNull: false }
 */
function optionScopeFor(tour, selector) {
  const options = getTourOptions(tour);
  if (options.length === 0) return null;
  const { option, index } = resolveTourOption(tour, selector);
  if (!option || !option.id) return null;
  return { id: option.id, includeNull: index === 0 };
}

/**
 * Apply an option to a Tour row: returns the tour with its engine blobs
 * swapped to that option's projection plus the capacity scope to use.
 * When no option exists (or nothing matches) the original tour + null scope is
 * returned so legacy single-option behavior is unchanged.
 */
function applyOption(tour, selector) {
  const proj = projectOption(tour, selector);
  if (!proj.option) {
    return { tour, optionScope: null, optionId: null, optionTitle: null };
  }
  const isDefault = (defaultOption(tour) || {}).id === proj.optionId;
  return {
    tour: {
      ...tour,
      schedulesAndPricing: proj.schedulesAndPricing,
      bookingAndTickets: proj.bookingAndTickets,
    },
    optionScope: { id: proj.optionId, includeNull: isDefault },
    optionId: proj.optionId,
    optionTitle: proj.optionTitle,
  };
}

module.exports = {
  getTourOptions,
  defaultOption,
  resolveTourOption,
  projectOption,
  validateTourOptions,
  optionSummaries,
  optionScopeFor,
  applyOption,
  normalizeCategory,
  priceEntriesFrom,
};
