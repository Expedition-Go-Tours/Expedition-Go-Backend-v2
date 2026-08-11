const { createSlug, durationToMinutes, rebuildSchedulePrices, reconcileAvailability } = require('./tourHelpers');
const { productToTour } = require('./productToTour');

const JSON_BLOB_KEYS = ['categorization', 'productContent', 'schedulesAndPricing', 'bookingAndTickets'];

// Flat source keys that drive each blob builder in utils/productToTour.js. A
// payload touching ANY of these keys means the corresponding blob is being
// edited; a payload touching NONE of them means the blob stays untouched.
// Keys mirror the builder's `src.X` / `flat.X` reads (line-for-line).
const FLAT_BLOB_SOURCES = {
  categorization: [
    'category', 'subcategory', 'activityType', 'difficulty', 'duration', 'durationUnit',
    'transportMode', 'transportModes', 'transportServices', 'accommodationIncluded',
  ],
  productContent: [
    'writingLanguage', 'language', 'shortSummary', 'shortDescription', 'highlights', 'locations',
    'attractions', 'activitiesIncluded', 'pickupTransportTypes', 'included', 'whatsIncluded',
    'excluded', 'whatsNotIncluded', 'guideType', 'guideMaterials', 'foodProvided', 'meals',
    'mealType', 'showDietaryRestrictions', 'drinksIncluded', 'dietaryOptions',
    'transportationProvided', 'transportationType', 'notSuitableFor', 'notAllowed', 'petFriendly',
    'wifiIncluded', 'mandatoryItems', 'knowBeforeYouGo', 'emergencyCountryCode', 'emergencyPhone', 'voucherInfo',
    'copyrightConfirmed', 'options', 'meetingPointDescription', 'meetingMode',
    'meetingPointPicture', 'arrivalTime', 'arrivalTimeType', 'arrivalTimeCustom', 'pickupProvided',
    'pickupAvailable', 'pickupType', 'pickupDescription', 'pickupTiming',
    'pickupFinalLocationTiming', 'referenceStartTime', 'pickupAreas', 'pickupLocations',
    'pickupGeoshape', 'dropoffProvided', 'dropoffAvailable', 'dropoffOption', 'dropoffLocation',
    'dropoffDescription', 'isPrivateActivity', 'passportRequired', 'flightInfoRequired',
    'shipInfoRequired', 'trainInfoRequired', 'hotelInfoRequired', 'contactPhone', 'crossCityTravel',
    'planPickupTimes', 'pickupStartTime',
  ],
  schedulesAndPricing: [
    'pricingModel', 'pricingApproach', 'uniformPrice', 'pricingCategories', 'ageGroups',
    'minParticipants', 'maxParticipants', 'groupSizes', 'additionalPersonsEnabled',
    'additionalPersonPrice', 'maxGroupsPerTimeSlot', 'currency', 'scheduleName',
    'scheduleStartDate', 'scheduleHasEndDate', 'scheduleEndDate', 'timeSlots', 'dateExceptions',
    'weeklySchedule', 'scheduleType', 'timezone',
  ],
  bookingAndTickets: [
    'cancellationType', 'cutoffHours', 'cutoffMinutes', 'supplierCanCancelBadWeather',
    'supplierCanCancelNotEnoughTravelers', 'meetingPoint', 'arrivalTime', 'pickupProvided',
    'pickupType', 'pickupDescription', 'pickupTiming', 'pickupFinalLocationTiming',
    'referenceStartTime', 'pickupAreas', 'pickupLocations', 'pickupGeoshape', 'dropoffOption',
    'dropoffProvided', 'dropoffLocation', 'dropoffDescription', 'ticketType', 'instantBooking',
    'instantConfirmation', 'maxQuantity', 'bookingWindow', 'minAdvanceBookingHours',
    'travelerRequiredInfo', 'lastMinuteBookings', 'perSlotCutoff', 'perSlotCutoffs', 'timezone',
  ],
};

// How each blob's LIVE values are re-injected into the flat view before the
// mapping runs. Most fields are 1:1 (`flatKey -> liveBlob[flatKey]`); the
// composites (duration, nested scheduler fields) get explicit resolvers.
const FLAT_BLOB_INJECTS = {
  categorization: {
    own: ['category', 'subcategory', 'activityType', 'difficulty', 'transportMode', 'transportModes', 'transportServices', 'accommodationIncluded'],
    duration: (blob) => (blob && blob.duration && typeof blob.duration === 'object'
      ? { duration: blob.duration.value, durationUnit: blob.duration.unit }
      : {}),
  },
  productContent: {
    own: [
      'writingLanguage', 'shortSummary', 'highlights', 'locations', 'attractions',
      'activitiesIncluded', 'pickupTransportTypes', 'guideType', 'guideMaterials',
      'foodProvided', 'meals', 'mealType', 'showDietaryRestrictions', 'drinksIncluded',
      'dietaryOptions', 'transportationProvided', 'transportationType', 'notAllowed',
      'petFriendly', 'wifiIncluded', 'emergencyCountryCode', 'emergencyPhone', 'voucherInfo',
      'copyrightConfirmed', 'options', 'meetingMode', 'meetingPointPicture', 'arrivalTime',
      'arrivalTimeType', 'arrivalTimeCustom', 'pickupProvided', 'pickupAvailable', 'pickupType',
      'pickupDescription', 'pickupTiming', 'pickupFinalLocationTiming', 'referenceStartTime',
      'pickupAreas', 'pickupLocations', 'pickupGeoshape', 'dropoffProvided', 'dropoffAvailable',
      'dropoffOption', 'dropoffLocation', 'dropoffDescription', 'isPrivateActivity',
      'passportRequired', 'flightInfoRequired', 'shipInfoRequired', 'trainInfoRequired',
      'hotelInfoRequired', 'contactPhone', 'crossCityTravel', 'planPickupTimes',
      'pickupStartTime',
    ],
    // The reverse map below drives these flat keys (notSuitableFor, mandatoryItems,
    // knowBeforeYouGo, meetingPointDescription); the canonical blob names here
    // are never read by productToTour, so they must not be injected directly.
    // Primary key + the alias flat keys the builder falls back to. When the
    // payload carries ANY form of the pair, the injected primary is discarded
    // so the request's own value is the one that maps through.
    aliases: {
      included: ['whatsIncluded'],
      excluded: ['whatsNotIncluded'],
      shortSummary: ['shortDescription'],
      writingLanguage: ['language'],
    },
    // Canonical blob name -> flat name the builder reads (reverse aliases).
    reverse: {
      healthRestrictions: 'notSuitableFor',
      whatToBring: 'mandatoryItems',
      additionalInfo: 'knowBeforeYouGo',
      meetingInstructions: 'meetingPointDescription',
    },
  },
  schedulesAndPricing: {
    aliases: {
      pricingCategories: ['ageGroups'],
    },
    paths: {
      pricingModel: ['travelerDetails', 'pricingModel'],
      pricingApproach: ['travelerDetails', 'pricingApproach'],
      uniformPrice: ['travelerDetails', 'uniformPrice'],
      minParticipants: ['travelerDetails', 'minParticipants'],
      maxParticipants: ['travelerDetails', 'maxParticipants'],
      groupSizes: ['travelerDetails', 'groupSizes'],
      additionalPersonsEnabled: ['travelerDetails', 'additionalPersonsEnabled'],
      additionalPersonPrice: ['travelerDetails', 'additionalPersonPrice'],
      maxGroupsPerTimeSlot: ['travelerDetails', 'maxGroupsPerTimeSlot'],
      pricingCategories: ['travelerDetails', 'pricingCategories'],
      ageGroups: ['travelerDetails', 'pricingCategories'],
      currency: ['pricingSchedules', 'currency'],
      scheduleName: ['pricingSchedules', 'schedules', 0, 'name'],
      scheduleStartDate: ['pricingSchedules', 'schedules', 0, 'startDate'],
      scheduleHasEndDate: ['pricingSchedules', 'schedules', 0, 'hasEndDate'],
      scheduleEndDate: ['pricingSchedules', 'schedules', 0, 'endDate'],
      timeSlots: ['pricingSchedules', 'schedules', 0, 'timeSlots'],
      dateExceptions: ['pricingSchedules', 'schedules', 0, 'dateExceptions'],
      weeklySchedule: ['availability', 'weeklySchedule'],
      scheduleType: ['availability', 'scheduleType'],
      timezone: ['availability', 'timezone'],
    },
  },
  bookingAndTickets: {
    own: [
      'meetingPoint', 'arrivalTime', 'pickupProvided', 'pickupType', 'pickupDescription',
      'pickupTiming', 'pickupFinalLocationTiming', 'referenceStartTime', 'pickupAreas',
      'pickupLocations', 'pickupGeoshape', 'dropoffOption', 'dropoffProvided', 'dropoffLocation',
      'dropoffDescription', 'ticketType', 'instantBooking', 'instantConfirmation', 'maxQuantity',
      'bookingWindow', 'minAdvanceBookingHours', 'travelerRequiredInfo', 'cutoffMinutes',
      'lastMinuteBookings', 'perSlotCutoff', 'perSlotCutoffs', 'timezone',
    ],
    paths: {
      cancellationType: ['cancellationPolicy', 'type'],
      supplierCanCancelBadWeather: ['cancellationPolicy', 'supplierCanCancelBadWeather'],
      supplierCanCancelNotEnoughTravelers: ['cancellationPolicy', 'supplierCanCancelNotEnoughTravelers'],
      cutoffHours: ['cancellationPolicy', 'cutoffHours'],
    },
  },
};

function getPath(obj, paths) {
  if (!obj || typeof obj !== 'object') return undefined;
  let node = obj;
  for (let i = 0; i < paths.length; i += 1) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[paths[i]];
  }
  return node;
}

function injectLiveValues(view, blob, table) {
  if (!blob || typeof blob !== 'object') return;
  // Primary key -> every key in its alias group. When the payload carries ANY
  // form of the group, the injected primary must stay out of the view so the
  // builder's `primary || alias` reads resolve to the supplier's own value.
  const groups = new Map();
  for (const [primary, aliases] of Object.entries(table.aliases || {})) {
    groups.set(primary, [primary, ...aliases]);
  }
  const groupPresent = (flatKey) => {
    const group = groups.get(flatKey);
    return group ? group.some((k) => view[k] !== undefined) : false;
  };

  for (const [primary, aliases] of Object.entries(table.aliases || {})) {
    const inGroup = [primary, ...aliases];
    if (view[primary] !== undefined) continue;
    if (!inGroup.some((k) => view[k] !== undefined) && blob[primary] !== undefined) view[primary] = blob[primary];
  }
  for (const flatKey of table.own || []) {
    if (groupPresent(flatKey)) continue;
    if (view[flatKey] === undefined && blob[flatKey] !== undefined) view[flatKey] = blob[flatKey];
  }
  for (const [canonical, flatKey] of Object.entries(table.canonicalMap || table.reverse || {})) {
    if (view[flatKey] === undefined && blob[canonical] !== undefined) view[flatKey] = blob[canonical];
  }
  for (const [flatKey, paths] of Object.entries(table.paths || {})) {
    if (groupPresent(flatKey)) continue;
    if (view[flatKey] === undefined) {
      const value = getPath(blob, paths);
      if (value !== undefined) view[flatKey] = value;
    }
  }
  if (table.duration) {
    const pair = table.duration(blob);
    for (const [k, v] of Object.entries(pair)) {
      if (view[k] === undefined && v !== undefined) view[k] = v;
    }
  }
}

/**
 * Presence-aware flat→blob mapping for the product builder.
 *
 * Maps flat 13-step store fields into the nested JSON blobs without letting
 * productToTour's defaults poison content the payload did not include — the
 * flat form inputs are the source of truth at BLOB granularity:
 *  - a blob whose flat inputs the payload touches is rebuilt, and the rebuild
 *    runs on a flat view seeded with live values for every omitted key, so
 *    untouched fields keep their live content (no default flood);
 *  - an explicit nested blob never overrides the flat inputs: the frontend
 *    can send a blob verbatim from a previous load, so trusting it would
 *    silently drop the supplier's edits (admin would see an empty diff for a
 *    real submission);
 *  - an explicit nested blob WITHOUT flat drivers stays authoritative (admin
 *    tooling / bulk imports send whole blobs);
 *  - a blob the payload never touches is left alone — the later
 *    mergeDraftContent keeps the live snapshot verbatim.
 * Flat duration/durationUnit remain the authoritative source for
 * categorization.duration in both directions.
 */
function applyFlatToBlobMapping(body, baseTour) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length === 0) return body;

  const hasExplicitBlob = (key) => body[key] && typeof body[key] === 'object' && !Array.isArray(body[key]) && JSON_BLOB_KEYS.includes(key);

  const touched = {};
  for (const key of JSON_BLOB_KEYS) {
    if (hasExplicitBlob(key)) {
      touched[key] = true;
      continue;
    }
    if (FLAT_BLOB_SOURCES[key] && FLAT_BLOB_SOURCES[key].some((driver) => body[driver] !== undefined)) {
      touched[key] = true;
    }
  }
  if (!JSON_BLOB_KEYS.some((key) => touched[key])) return body;

  const view = { ...body };
  for (const key of JSON_BLOB_KEYS) delete view[key];
  for (const key of JSON_BLOB_KEYS) {
    if (touched[key] && baseTour) injectLiveValues(view, baseTour[key], FLAT_BLOB_INJECTS[key]);
  }

  const mapped = productToTour(view);

  for (const key of Object.keys(mapped)) {
    if (JSON_BLOB_KEYS.includes(key)) {
      // Rebuild the blob when the payload carries the flat form inputs for it.
      // Flat keys are the builder's source of truth even if an explicit nested
      // object is also present — the frontend may send the nested blob
      // verbatim from the page's previous load, in which case trusting it
      // would silently drop the supplier's edits and the admin would see an
      // empty diff ("0 changes") for a real submission. An explicit blob with
      // NO flat drivers stays authoritative (admin tooling / bulk imports).
      const flatDriven = FLAT_BLOB_SOURCES[key]
        ? FLAT_BLOB_SOURCES[key].some((driver) => body[driver] !== undefined)
        : false;
      if (touched[key] && flatDriven) {
        // Carry forward any keys the builder does not emit (legacy fields such
        // as productContent.meetingPoint) from the explicit blob when present,
        // else from the live blob. Otherwise a rebuild silently drops them: the
        // stored draft loses the content and the admin diff invents a spurious
        // "removed" row on every unrelated edit.
        const rebuilt = mapped[key];
        const sourceBlob = (hasExplicitBlob(key) && body[key]) || (baseTour && baseTour[key]);
        if (
          rebuilt && typeof rebuilt === 'object' && !Array.isArray(rebuilt) &&
          sourceBlob && typeof sourceBlob === 'object' && !Array.isArray(sourceBlob)
        ) {
          for (const legacyKey of Object.keys(sourceBlob)) {
            if (!(legacyKey in rebuilt)) rebuilt[legacyKey] = sourceBlob[legacyKey];
          }
        }
        body[key] = rebuilt;
      }
      continue;
    }
  }
  for (const key of ['title', 'description', 'metaTitle', 'metaDescription', 'referenceCode']) {
    if (body[key] !== undefined && mapped[key] !== undefined) body[key] = mapped[key];
  }
  if (touched.categorization || hasExplicitBlob('categorization')) {
    for (const key of ['category', 'subcategory', 'activityType', 'difficulty', 'durationMinutes']) {
      if (body[key] !== undefined || mapped[key] !== undefined) body[key] = mapped[key];
    }
  }
  if (body.tags === undefined && (body.keywords !== undefined) && mapped.tags !== undefined) {
    body.tags = mapped.tags;
  }
  const locationDrivers = ['locations', 'city', 'country', 'region', 'meetingPoint', 'latitude', 'longitude'];
  if (locationDrivers.some((k) => body[k] !== undefined)) {
    for (const key of ['city', 'country', 'region', 'latitude', 'longitude']) {
      if (mapped[key] !== undefined) body[key] = mapped[key];
    }
  }

  // Flat duration/durationUnit are authoritative — they are the form's source
  // of truth for both the flattened and the nested representations.
  const hasFlatDuration = typeof body.duration === 'number' && typeof body.durationUnit === 'string' && body.durationUnit;
  const catObj = body.categorization && typeof body.categorization === 'object' ? body.categorization : null;
  const nestedDuration = catObj && catObj.duration && typeof catObj.duration === 'object' ? catObj.duration : null;
  if (!hasFlatDuration && nestedDuration && typeof nestedDuration.value === 'number' && nestedDuration.unit) {
    body.duration = nestedDuration.value;
    body.durationUnit = nestedDuration.unit;
  }
  if (hasFlatDuration) {
    if (catObj) {
      body.categorization = { ...catObj, duration: { value: body.duration, unit: body.durationUnit } };
    } else {
      body.categorization = { duration: { value: body.duration, unit: body.durationUnit } };
    }
  }

  return body;
}

const CONTENT_FIELDS = [
  'title',
  'description',
  'coverPhoto',
  'photos',
  'tags',
  'metaTitle',
  'metaDescription',
  'categorization',
  'productContent',
  'schedulesAndPricing',
  'bookingAndTickets',
];

function tourContentSnapshot(tour) {
  return {
    title: tour.title,
    description: tour.description,
    coverPhoto: tour.coverPhoto ?? null,
    photos: tour.photos || [],
    tags: tour.tags || [],
    metaTitle: tour.metaTitle ?? null,
    metaDescription: tour.metaDescription ?? null,
    categorization: tour.categorization,
    productContent: tour.productContent,
    schedulesAndPricing: tour.schedulesAndPricing,
    bookingAndTickets: tour.bookingAndTickets,
  };
}

function mergeDraftContent(liveRow, draftContent) {
  const snapshot = tourContentSnapshot(liveRow);
  if (!draftContent || typeof draftContent !== 'object') return snapshot;
  const merged = {
    ...snapshot,
    ...Object.fromEntries(CONTENT_FIELDS.map((f) => [f, draftContent[f] !== undefined ? draftContent[f] : snapshot[f]])),
  };
  return merged;
}

function truncate(value, max = 400) {
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (value && typeof value === 'object') return '[object]';
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}...` : value;
  return value;
}

function isDeeplyEmpty(value) {
  if (value === undefined || value === null || value === '' || value === false) return true;
  if (typeof value === 'object') return Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
  return false;
}

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = deepClone(value[key]);
    return out;
  }
  return value;
}

// Operating hours are stored twice: explicitly AND inside weeklySchedule.
// The editor rebuilds the explicit values FROM the daily schedule, so a
// stale explicit pair (09:00–17:00) next to a schedule that says 08:00–18:00
// creates a phantom "hours changed" row on every unrelated edit. Deriving
// the explicit values from the schedule cancels the layout difference while
// keeping real hour changes visible (they change the weeklySchedule too).
function normalizeOperatingHours(availability) {
  if (!availability || typeof availability !== 'object') return;
  const firstDay = availability.weeklySchedule && Object.values(availability.weeklySchedule)[0];
  const firstSlot = Array.isArray(firstDay) && firstDay[0];
  if (firstSlot && firstSlot.startTime && firstSlot.endTime) {
    availability.operatingHoursStart = firstSlot.startTime;
    availability.operatingHoursEnd = firstSlot.endTime;
  }
}

// The editor keeps each option's schedule, pricing and cutoffs inside
// productContent.options[i].availability/.pricing/.cutoff, while tours
// persisted in the legacy layout store the same facts under
// schedulesAndPricing.pricingSchedules.schedules and bookingAndTickets.
// Comparing raw trees invents "added/removed" rows for keys that merely
// moved locations. This folds the nested layout back into the legacy
// positions (merging, never overwriting), so both sides render identical
// unless the supplier actually changed a value.
function foldNestedOptionLayout(src) {
  const sp = src.schedulesAndPricing;
  const options = src.productContent && src.productContent.options;
  if (!sp || !Array.isArray(options)) return;

  const existing = sp.pricingSchedules && Array.isArray(sp.pricingSchedules.schedules)
    ? sp.pricingSchedules.schedules
    : [];
  const schedules = existing.map((sched) => deepClone(sched));

  options.forEach((option, i) => {
    if (!option || typeof option !== 'object') return;
    if (!schedules[i]) schedules[i] = {};

    const nested = option.availability && option.availability.schedules && option.availability.schedules[0];
    const pricing = option.pricing || {};

    if (nested && typeof nested === 'object') {
      for (const key of ['name', 'type', 'currency', 'startDate', 'endDate', 'hasEndDate']) {
        if (scheduleMissing(schedules[i][key])) schedules[i][key] = nested[key];
      }
      if (schedules[i].weeklySchedule === undefined && nested.weeklySchedule) {
        schedules[i].weeklySchedule = deepClone(nested.weeklySchedule);
      }
    }
    if (pricing && typeof pricing === 'object') {
      for (const key of ['currency', 'pricingModel', 'pricingApproach', 'minParticipants', 'maxParticipants', 'uniformPrice', 'groupSizes', 'pricingCategories']) {
        if (scheduleMissing(schedules[i][key])) schedules[i][key] = deepClone(pricing[key]);
      }
      // legacy derived array — must be identical to what the legacy
      // persistence writes, or the same values diff as separate rows
      if (!schedules[i].prices && Array.isArray(pricing.pricingCategories)) {
        schedules[i].prices = pricing.pricingCategories
          .filter((c) => c && c.name)
          .map((c) => ({ ageGroup: c.name, retailPrice: c.price }));
      }
    }
    if (option.cutoff && typeof option.cutoff === 'object' && src.bookingAndTickets && typeof src.bookingAndTickets === 'object') {
      for (const key of ['cutoffMinutes', 'perSlotCutoff', 'perSlotCutoffs', 'lastMinuteBookings']) {
        if (scheduleMissing(src.bookingAndTickets[key])) src.bookingAndTickets[key] = deepClone(option.cutoff[key]);
      }
    }

    // Keys the nested layout must not leak into the diff
    delete options[i].availability;
    delete options[i].cutoff;
    delete options[i].pricing;
  });

  if (schedules.some((s) => s && Object.keys(s).length)) {
    sp.pricingSchedules = { schedules };
  } else if (sp.pricingSchedules) {
    sp.pricingSchedules = {};
  }
}

function scheduleMissing(value) {
  return value === undefined;
}

function canonicalizeForDiff(src) {
  const out = deepClone(src);
  const root = out && typeof out === 'object' ? out : {};
  if (root.schedulesAndPricing && typeof root.schedulesAndPricing === 'object') {
    normalizeOperatingHours(root.schedulesAndPricing.availability);
    if (root.schedulesAndPricing.pricingSchedules) {
      // schedule-level currency is authoritative; the top-level copy is legacy noise
      delete root.schedulesAndPricing.pricingSchedules.currency;
    }
  }
  const options = root.productContent && root.productContent.options;
  if (Array.isArray(options)) {
    for (const option of options) {
      normalizeOperatingHours(option && option.availability);
    }
  }
  foldNestedOptionLayout(root);
  return root;
}

function buildTourDiff(live, draft, maxDepth = 4) {
  const liveSrc = canonicalizeForDiff(live) || {};
  const draftSrc = canonicalizeForDiff(draft) || {};
  const diffs = [];
  const record = (path, kind, before, after) => diffs.push({ path, kind, before, after });

  if (JSON.stringify(liveSrc.photos || []) !== JSON.stringify(draftSrc.photos || [])) {
    const oldSet = new Set(liveSrc.photos || []);
    const newSet = new Set(draftSrc.photos || []);
    const added = (draftSrc.photos || []).filter((p) => !oldSet.has(p));
    const removed = (liveSrc.photos || []).filter((p) => !newSet.has(p));
    if (added.length || removed.length) {
      record('photos', 'changed', `${removed.length} removed`, `${added.length} added`);
    }
  }

  const walk = (a, b, path, depth) => {
    if (a === b && (typeof a !== 'object' || a === null)) return;
    // Empty-equivalence: '' ≡ null ≡ undefined ≡ false ≡ {} ≡ [] and
    // combinations thereof. The rebuild pipeline produces these sentinels
    // interchangeably (contactPhone '' vs null, accommodationIncluded false
    // vs missing, perSlotCutoffs {} vs absent) — diffing them would invent
    // phantom add/remove rows on every unrelated edit of the same blob.
    const aEmpty = isDeeplyEmpty(a);
    const bEmpty = isDeeplyEmpty(b);
    if (aEmpty && bEmpty) return;
    if (a === undefined || a === null) {
      record(path, 'added', undefined, truncate(b));
      return;
    }
    if (b === undefined || b === null) {
      record(path, 'removed', truncate(a), undefined);
      return;
    }
    const aObj = typeof a === 'object' && a !== null;
    const bObj = typeof b === 'object' && b !== null;
    if (aObj && bObj) {
      const aArr = Array.isArray(a);
      const bArr = Array.isArray(b);
      if (aArr && bArr) {
        const len = Math.max(a.length, b.length);
        for (let i = 0; i < len; i += 1) walk(a[i], b[i], `${path}[${i}]`, depth + 1);
        return;
      }
      if (aArr !== bArr) {
        record(path, 'changed', truncate(a), truncate(b));
        return;
      }
      if (depth >= maxDepth) {
        if (JSON.stringify(a) !== JSON.stringify(b)) record(path, 'changed', truncate(a), truncate(b));
        return;
      }
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      for (const key of keys) walk(a[key], b[key], path ? `${path}.${key}` : key, depth + 1);
      return;
    }
    record(path, 'changed', truncate(a), truncate(b));
  };

  for (const field of CONTENT_FIELDS) {
    if (field === 'photos') continue;
    walk(liveSrc[field], draftSrc[field], field, 0);
  }

  return diffs;
}

function computeChangesSummary(diff) {
  const sections = {};
  for (const entry of diff) {
    const section = String(entry.path).split(/[.[]/)[0] || 'other';
    if (!sections[section]) sections[section] = [];
    sections[section].push(entry.path);
  }
  return {
    count: diff.length,
    sections: Object.keys(sections).map((name) => ({ section: name, changes: sections[name].length, paths: sections[name] })),
  };
}

function parseJson(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value || null;
}

async function buildLiveUpdateData(tx, liveRow, draftContent) {
  const merged = mergeDraftContent(liveRow, draftContent);

  const updateData = {
    title: merged.title,
    description: merged.description,
    coverPhoto: merged.coverPhoto,
    photos: merged.photos,
    tags: merged.tags,
    metaTitle: merged.metaTitle,
    metaDescription: merged.metaDescription,
    categorization: merged.categorization,
    productContent: merged.productContent,
    // Re-normalize the derived prices AND reconcile the availability aggregate
    // before the snapshot goes live. This is the last gate before the public
    // site reads schedulesAndPricing, so it must never commit a degraded
    // availability block (e.g. an empty daysOfWeek / weeklySchedule with valid
    // hours only on schedules[0]). reconcileAvailability is additive: it
    // backfills the empty side from the populated one and never invents hours.
    schedulesAndPricing: (() => {
      if (!merged.schedulesAndPricing || typeof merged.schedulesAndPricing !== 'object' || Array.isArray(merged.schedulesAndPricing)) {
        return merged.schedulesAndPricing;
      }
      const blob = rebuildSchedulePrices(merged.schedulesAndPricing);
      return reconcileAvailability(blob);
    })(),
    bookingAndTickets: merged.bookingAndTickets,
  };

  const cat = parseJson(merged.categorization);
  if (cat && typeof cat === 'object') {
    updateData.category = cat.category || null;
    updateData.subcategory = cat.subcategory || null;
    updateData.activityType = cat.activityType || null;
    updateData.difficulty = cat.difficulty || null;
    updateData.durationMinutes = durationToMinutes(cat.duration);
  }

  const pc = parseJson(merged.productContent);
  const firstLoc = Array.isArray(pc && pc.locations) ? pc.locations[0] : (pc && pc.location) || null;
  updateData.city = firstLoc ? firstLoc.city || null : null;
  updateData.country = firstLoc ? firstLoc.country || null : null;
  updateData.region = firstLoc ? firstLoc.region || null : null;

  if (merged.title && merged.title !== liveRow.title) {
    updateData.slug = await createSlug(merged.title, tx);
  }

  return updateData;
}

module.exports = {
  CONTENT_FIELDS,
  JSON_BLOB_KEYS,
  tourContentSnapshot,
  mergeDraftContent,
  buildTourDiff,
  computeChangesSummary,
  buildLiveUpdateData,
  applyFlatToBlobMapping,
};
