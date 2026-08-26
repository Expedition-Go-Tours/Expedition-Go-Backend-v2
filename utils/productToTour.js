/**
 * Maps the flat 13-step product builder store shape into:
 *   - 4 JSON blobs (categorization, productContent, schedulesAndPricing, bookingAndTickets)
 *   - normalized columns (city, country, category, slug, tags, etc.)
 *
 * Inverse of the frontend's tourToProduct() mapper.
 */

const { normalizeToE164 } = require('./phoneValidation');
const { durationToMinutes } = require('./tourHelpers');

function productToTour(flat) {
  if (!flat || typeof flat !== 'object') return {};

  const categorization = buildCategorization(flat);
  const productContent = buildProductContent(flat);
  const schedulesAndPricing = buildSchedulesAndPricing(flat);
  const bookingAndTickets = buildBookingAndTickets(flat);

  const firstLoc = Array.isArray(flat.locations) && flat.locations.length > 0 ? flat.locations[0] : null;

  // Extract unique attraction/stop names from all locations
  const attractions = Array.isArray(flat.locations)
    ? [...new Set(flat.locations.map(l => l?.name).filter(n => n && n.trim()))]
    : [];

  const result = {
    title: flat.title || '',
    description: flat.fullDescription || '',
    referenceCode: flat.referenceCode || null,
    categorization,
    productContent,
    schedulesAndPricing,
    bookingAndTickets,
    metaTitle: flat.metaTitle || null,
    metaDescription: flat.metaDescription || null,
    tags: Array.isArray(flat.keywords) ? flat.keywords : [],
    latitude: extractLatitude(flat),
    longitude: extractLongitude(flat),
    city: firstLoc?.city || null,
    country: firstLoc?.country || null,
    region: firstLoc?.region || null,
    category: categorization?.category || null,
    subcategory: categorization?.subcategory || null,
    activityType: categorization?.activityType || null,
    difficulty: categorization?.difficulty || null,
    durationMinutes: computeDurationMinutes(flat),
    attractions,
  };

  // Remove undefined fields so they don't overwrite existing values on update
  for (const key of Object.keys(result)) {
    if (result[key] === undefined) delete result[key];
  }

  return result;
}

function asSource(flat, key) {
  // prefer nested blob (flat[key]) if present, otherwise use top-level flat
  if (flat[key] && typeof flat[key] === 'object') return flat[key];
  return flat;
}

function buildCategorization(flat) {
  const src = asSource(flat, 'categorization');
  const durationValue = src.duration != null
    ? { value: src.duration, unit: src.durationUnit || 'hours' }
    : null;

  return {
    category: src.category || null,
    subcategory: src.subcategory || null,
    activityType: src.activityType || null,
    difficulty: src.difficulty || null,
    duration: durationValue,
    transportMode: src.transportMode || null,
    transportModes: Array.isArray(src.transportModes) ? src.transportModes : [],
    transportServices: Array.isArray(src.transportServices) ? src.transportServices : [],
    accommodationIncluded: src.accommodationIncluded != null ? !!src.accommodationIncluded : null,
  };
}

function buildProductContent(flat) {
  const src = asSource(flat, 'productContent');
  return {
    writingLanguage: src.writingLanguage || src.language || '',
    shortSummary: src.shortSummary || src.shortDescription || '',
    highlights: Array.isArray(src.highlights) ? src.highlights : [],
    locations: Array.isArray(src.locations) ? src.locations : [],
    attractions: Array.isArray(src.attractions) ? src.attractions : [],
    activitiesIncluded: Array.isArray(src.activitiesIncluded) ? src.activitiesIncluded : [],
    pickupTransportTypes: Array.isArray(src.pickupTransportTypes) ? src.pickupTransportTypes : [],
    included: Array.isArray(src.included) ? src.included : (Array.isArray(src.whatsIncluded) ? src.whatsIncluded : []),
    excluded: Array.isArray(src.excluded) ? src.excluded : (Array.isArray(src.whatsNotIncluded) ? src.whatsNotIncluded : []),
    guideType: src.guideType || 'tour-guide',
    guideMaterials: src.guideMaterials || { audioGuide: false, infoBooklet: false },
    foodProvided: !!src.foodProvided,
    meals: Array.isArray(src.meals) ? src.meals : [],

    showDietaryRestrictions: !!src.showDietaryRestrictions,
    drinksIncluded: !!src.drinksIncluded,
    dietaryOptions: Array.isArray(src.dietaryOptions) ? src.dietaryOptions : [],
    dayLogistics: (src.dayLogistics && typeof src.dayLogistics === 'object') ? src.dayLogistics : {},
    transportationProvided: !!src.transportationProvided,
    transportationType: src.transportationType || '',
    healthRestrictions: Array.isArray(src.notSuitableFor) ? src.notSuitableFor : [],
    notAllowed: Array.isArray(src.notAllowed) ? src.notAllowed : [],
    petFriendly: !!src.petFriendly,
    wheelchairAccessible: !!src.wheelchairAccessible,
    wifiIncluded: !!src.wifiIncluded,
    whatToBring: Array.isArray(src.mandatoryItems) ? src.mandatoryItems : [],
    additionalInfo: src.knowBeforeYouGo || '',
    emergencyPhone: normalizeToE164(src.emergencyPhone) || '',
    voucherInfo: src.voucherInfo || '',
    copyrightConfirmed: !!src.copyrightConfirmed,
    options: Array.isArray(src.options) ? src.options.map((o) => ({ ...o, wheelchairAccessible: !!o.wheelchairAccessible })) : [],
    meetingInstructions: src.meetingPointDescription || '',
    meetingMode: src.meetingMode || 'meeting_point',
    meetingPointPicture: src.meetingPointPicture || '',
    arrivalTime: src.arrivalTime || src.arrivalTimeCustom || '',
    arrivalTimeType: src.arrivalTimeType || 'none',
    arrivalTimeCustom: src.arrivalTimeCustom || '',
    pickupProvided: src.meetingMode === 'pickup',
    pickupAvailable: src.meetingMode === 'pickup',
    pickupType: src.pickupType || 'area',
    pickupDescription: src.pickupDescription || '',
    pickupTiming: src.pickupTiming || 'at_start',
    pickupFinalLocationTiming: src.pickupFinalLocationTiming || 'day_before',
    referenceStartTime: src.referenceStartTime || '',
    pickupAreas: Array.isArray(src.pickupAreas) ? src.pickupAreas : [],
    pickupLocations: Array.isArray(src.pickupLocations) ? src.pickupLocations : [],
    pickupGeoshape: src.pickupGeoshape || null,
    dropoffProvided: src.dropoffOption && src.dropoffOption !== 'none',
    dropoffAvailable: src.dropoffOption && src.dropoffOption !== 'none',
    dropoffOption: src.dropoffOption || 'none',
    dropoffLocation: src.dropoffLocation || null,
    dropoffDescription: src.dropoffDescription || '',
    isPrivateActivity: !!src.isPrivateActivity,
    passportRequired: !!src.passportRequired,
    flightInfoRequired: !!src.flightInfoRequired,
    shipInfoRequired: !!src.shipInfoRequired,
    trainInfoRequired: !!src.trainInfoRequired,
    hotelInfoRequired: !!src.hotelInfoRequired,
    contactPhone: normalizeToE164(src.contactPhone) || '',
    crossCityTravel: !!src.crossCityTravel,
    planPickupTimes: !!src.planPickupTimes,
    pickupStartTime: src.pickupStartTime || '08:00',
  };
}

function buildSchedulesAndPricing(flat) {
  const src = asSource(flat, 'schedulesAndPricing');
  const cats = Array.isArray(src.pricingCategories) ? src.pricingCategories : (Array.isArray(src.ageGroups) ? src.ageGroups : [])

  const prices = []
  if (src.pricingModel === 'perGroup') {
    if (Array.isArray(src.groupSizes)) {
      for (const gs of src.groupSizes) {
        if (gs.price != null) {
          prices.push({ label: gs.from === gs.to ? `Group of ${gs.from}` : `Group of ${gs.from}-${gs.to}`, retailPrice: gs.price, groupSize: true })
        }
      }
    }
  } else {
    for (const c of cats) {
      if (c.price != null) {
        prices.push({ ageGroup: c.name, retailPrice: c.price })
      }
    }
  }

  return {
    travelerDetails: {
      pricingModel: src.pricingModel || 'perPerson',
      pricingApproach: src.pricingApproach || 'dependsOnAge',
      uniformPrice: src.uniformPrice ?? null,
      pricingCategories: cats,
      ageGroups: cats.map(c => ({ label: c.name, minAge: c.minAge, maxAge: c.maxAge })),
      minParticipants: src.minParticipants ?? null,
      maxParticipants: src.maxParticipants ?? null,
      groupSizes: Array.isArray(src.groupSizes) ? src.groupSizes : [],
      additionalPersonsEnabled: !!src.additionalPersonsEnabled,
      additionalPersonPrice: src.additionalPersonPrice ?? null,
      maxGroupsPerTimeSlot: src.maxGroupsPerTimeSlot ?? 1,
    },
    pricingSchedules: {
      currency: src.currency || '',
      schedules: [
        {
          name: src.scheduleName || '',
          startDate: src.scheduleStartDate || '',
          hasEndDate: !!src.scheduleHasEndDate,
          endDate: src.scheduleHasEndDate ? (src.scheduleEndDate || '') : null,
          timeSlots: Array.isArray(src.timeSlots) ? src.timeSlots : [],
          dateExceptions: Array.isArray(src.dateExceptions) ? src.dateExceptions : [],
          pricingCategories: cats,
          prices,
        },
      ],
    },
    availability: buildAvailability(src),
  };
}

function buildAvailability(flat) {
  const src = asSource(flat, 'schedulesAndPricing');
  const weekly = src.weeklySchedule
  let daysOfWeek = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  let operatingHoursStart = '09:00'
  let operatingHoursEnd = '17:00'

  if (weekly && typeof weekly === 'object') {
    const activeDays = Object.entries(weekly)
      .filter(([, slots]) => Array.isArray(slots) && slots.length > 0)
      .map(([day]) => day)
    if (activeDays.length > 0) {
      daysOfWeek = activeDays
      const allStarts = []
      const allEnds = []
      for (const slots of Object.values(weekly)) {
        if (Array.isArray(slots)) {
          for (const slot of slots) {
            if (slot.startTime) allStarts.push(slot.startTime)
            if (slot.endTime) allEnds.push(slot.endTime)
          }
        }
      }
      if (allStarts.length > 0) allStarts.sort()
      if (allEnds.length > 0) allEnds.sort()
      if (allStarts.length > 0) operatingHoursStart = allStarts[0]
      if (allEnds.length > 0) operatingHoursEnd = allEnds[allEnds.length - 1]
    }
  }

  return {
    scheduleType: flat.scheduleType || 'operatingHours',
    operatingHoursStart,
    operatingHoursEnd,
    daysOfWeek,
    weeklySchedule: flat.weeklySchedule || null,
    timeSlots: Array.isArray(flat.timeSlots) ? flat.timeSlots.map(t => typeof t === 'string' ? { startTime: t, endTime: '' } : t) : [],
    startDate: flat.scheduleStartDate || '',
    endDate: flat.scheduleHasEndDate ? (flat.scheduleEndDate || '') : null,
    timezone: flat.timezone || 'UTC',
  }
}

function buildBookingAndTickets(flat) {
  const src = flat;
  const cancellationPolicy = {};

  if (src.cancellationType === 'standard') {
    cancellationPolicy.type = 'standard';
    cancellationPolicy.label = 'Free cancellation up to 24 hours before';
    cancellationPolicy.cancellationWindowHours = 24;
    cancellationPolicy.refundPercentage = 100;
  } else if (src.cancellationType === 'all_sales_final') {
    cancellationPolicy.type = 'all_sales_final';
    cancellationPolicy.label = 'No refunds';
    cancellationPolicy.cancellationWindowHours = 0;
    cancellationPolicy.refundPercentage = 0;
  }

  if (src.supplierCanCancelBadWeather) cancellationPolicy.supplierCanCancelBadWeather = true;
  if (src.supplierCanCancelNotEnoughTravelers) cancellationPolicy.supplierCanCancelNotEnoughTravelers = true;

  return {
    meetingPoint: flat.meetingPoint || null,
    arrivalTime: flat.arrivalTime || '',
    pickupProvided: flat.meetingMode === 'pickup' || !!flat.pickupProvided,
    pickupType: flat.pickupType || 'area',
    pickupDescription: flat.pickupDescription || '',
    pickupTiming: flat.pickupTiming || 'at_start',
    pickupFinalLocationTiming: flat.pickupFinalLocationTiming || 'day_before',
    referenceStartTime: flat.referenceStartTime || '',
    pickupAreas: Array.isArray(flat.pickupAreas) ? flat.pickupAreas : [],
    pickupLocations: Array.isArray(flat.pickupLocations) ? flat.pickupLocations : [],
    pickupGeoshape: flat.pickupGeoshape || null,
    dropoffOption: flat.dropoffOption || 'none',
    dropoffProvided: (flat.dropoffOption && flat.dropoffOption !== 'none') || !!flat.dropoffProvided,
    dropoffLocation: flat.dropoffLocation || null,
    dropoffDescription: flat.dropoffDescription || '',
    instantConfirmation: flat.instantConfirmation ?? false,
    cancellationPolicy: Object.keys(cancellationPolicy).length > 0 ? cancellationPolicy : undefined,
    cutoffMinutes: flat.cutoffMinutes ?? 20,
    lastMinuteBookings: !!flat.lastMinuteBookings,
    perSlotCutoff: !!flat.perSlotCutoff,
    perSlotCutoffs: normalizePerSlotCutoffs(flat.perSlotCutoffs),
    timezone: flat.timezone || 'UTC',
  };
}

function normalizePerSlotCutoffs(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
  const out = {};
  for (const [time, value] of Object.entries(map)) {
    if (!time || typeof time !== 'string') continue;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0 && n <= 600) out[time] = n;
  }
  return out;
}

function extractLatitude(flat) {
  if (flat.meetingPoint?.lat != null) return flat.meetingPoint.lat;
  if (flat.latitude != null) return flat.latitude;
  return null;
}

function extractLongitude(flat) {
  if (flat.meetingPoint?.lng != null) return flat.meetingPoint.lng;
  if (flat.longitude != null) return flat.longitude;
  return null;
}

function computeDurationMinutes(flat) {
  if (flat.durationMinutes != null) return flat.durationMinutes;
  if (flat.duration == null) return null;
  return durationToMinutes({ value: flat.duration, unit: flat.durationUnit || 'hours' });
}

module.exports = { productToTour };
