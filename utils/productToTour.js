/**
 * Maps the flat 13-step product builder store shape into:
 *   - 5 JSON blobs (categorization, theme, productContent, schedulesAndPricing, bookingAndTickets)
 *   - normalized columns (city, country, category, slug, tags, etc.)
 *
 * Inverse of the frontend's tourToProduct() mapper.
 */

const { normalizeToE164, extractCountryFromE164 } = require('./phoneValidation');
const { durationToMinutes } = require('./tourHelpers');

function productToTour(flat) {
  if (!flat || typeof flat !== 'object') return {};

  const categorization = buildCategorization(flat);
  const theme = buildTheme(flat);
  const productContent = buildProductContent(flat);
  const schedulesAndPricing = buildSchedulesAndPricing(flat);
  const bookingAndTickets = buildBookingAndTickets(flat);

  const firstLoc = Array.isArray(flat.locations) && flat.locations.length > 0 ? flat.locations[0] : null;

  const result = {
    title: flat.title || '',
    description: flat.fullDescription || '',
    referenceCode: flat.referenceCode || null,
    categorization,
    theme,
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
    primaryTheme: theme?.primaryTheme || theme?.primary || null,
  };

  // Remove undefined fields so they don't overwrite existing values on update
  for (const key of Object.keys(result)) {
    if (result[key] === undefined) delete result[key];
  }

  return result;
}

function buildCategorization(flat) {
  const durationValue = flat.duration != null
    ? { value: flat.duration, unit: flat.durationUnit || 'hours' }
    : null;

  return {
    category: flat.category || null,
    subcategory: flat.subcategory || null,
    activityType: flat.activityType || null,
    difficulty: flat.difficulty || null,
    duration: durationValue,
    transportMode: flat.transportMode || null,
    transportModes: Array.isArray(flat.transportModes) ? flat.transportModes : [],
    transportServices: Array.isArray(flat.transportServices) ? flat.transportServices : [],
  };
}

function buildTheme(flat) {
  return {
    primaryTheme: flat.primaryTheme || null,
    secondary: Array.isArray(flat.secondaryThemes) ? flat.secondaryThemes : [],
  };
}

function buildProductContent(flat) {
  return {
    writingLanguage: flat.language || '',
    shortSummary: flat.shortDescription || '',
    highlights: Array.isArray(flat.highlights) ? flat.highlights : [],
    locations: Array.isArray(flat.locations) ? flat.locations : [],
    attractions: Array.isArray(flat.attractions) ? flat.attractions : [],
    activitiesIncluded: Array.isArray(flat.activitiesIncluded) ? flat.activitiesIncluded : [],
    pickupTransportTypes: Array.isArray(flat.pickupTransportTypes) ? flat.pickupTransportTypes : [],
    included: Array.isArray(flat.whatsIncluded) ? flat.whatsIncluded : [],
    excluded: Array.isArray(flat.whatsNotIncluded) ? flat.whatsNotIncluded : [],
    guideType: flat.guideType || 'tour-guide',
    guideMaterials: flat.guideMaterials || { audioGuide: false, infoBooklet: false },
    foodProvided: !!flat.foodProvided,
    meals: Array.isArray(flat.meals) ? flat.meals : [],
    mealType: flat.mealType || '',
    showDietaryRestrictions: !!flat.showDietaryRestrictions,
    drinksIncluded: !!flat.drinksIncluded,
    dietaryOptions: Array.isArray(flat.dietaryOptions) ? flat.dietaryOptions : [],
    transportationProvided: !!flat.transportationProvided,
    transportationType: flat.transportationType || '',
    healthRestrictions: Array.isArray(flat.notSuitableFor) ? flat.notSuitableFor : [],
    notAllowed: Array.isArray(flat.notAllowed) ? flat.notAllowed : [],
    petFriendly: !!flat.petFriendly,
    whatToBring: Array.isArray(flat.mandatoryItems) ? flat.mandatoryItems : [],
    additionalInfo: flat.knowBeforeYouGo || '',
    emergencyCountryCode: (() => {
      if (flat.emergencyCountryCode) return flat.emergencyCountryCode;
      if (flat.emergencyPhone) return extractCountryFromE164(flat.emergencyPhone) || '';
      return '';
    })(),
    emergencyPhone: normalizeToE164(flat.emergencyPhone) || '',
    voucherInfo: flat.voucherInfo || '',
    copyrightConfirmed: !!flat.copyrightConfirmed,
    options: Array.isArray(flat.options) ? flat.options : [],
    meetingInstructions: flat.meetingPointDescription || '',
    meetingMode: flat.meetingMode || 'meeting_point',
    meetingPointPicture: flat.meetingPointPicture || '',
    arrivalTime: flat.arrivalTime || '',
    arrivalTimeType: flat.arrivalTimeType || 'none',
    arrivalTimeCustom: flat.arrivalTimeCustom || '',
    pickupProvided: flat.meetingMode === 'pickup',
    pickupAvailable: flat.meetingMode === 'pickup',
    pickupType: flat.pickupType || 'area',
    pickupDescription: flat.pickupDescription || '',
    pickupTiming: flat.pickupTiming || 'at_start',
    pickupFinalLocationTiming: flat.pickupFinalLocationTiming || 'day_before',
    referenceStartTime: flat.referenceStartTime || '',
    pickupAreas: Array.isArray(flat.pickupAreas) ? flat.pickupAreas : [],
    pickupLocations: Array.isArray(flat.pickupLocations) ? flat.pickupLocations : [],
    pickupGeoshape: flat.pickupGeoshape || null,
    dropoffProvided: flat.dropoffOption && flat.dropoffOption !== 'none',
    dropoffAvailable: flat.dropoffOption && flat.dropoffOption !== 'none',
    dropoffOption: flat.dropoffOption || 'none',
    dropoffLocation: flat.dropoffLocation || null,
    dropoffDescription: flat.dropoffDescription || '',
    itinerary: Array.isArray(flat.itinerary) ? flat.itinerary : [],
    itineraryOverview: flat.itineraryOverview || '',
    additionalItineraryInfo: flat.additionalItineraryInfo || '',
    dayTitles: flat.dayTitles || {},
    isPrivateActivity: !!flat.isPrivateActivity,
    passportRequired: !!flat.passportRequired,
    flightInfoRequired: !!flat.flightInfoRequired,
    shipInfoRequired: !!flat.shipInfoRequired,
    trainInfoRequired: !!flat.trainInfoRequired,
    hotelInfoRequired: !!flat.hotelInfoRequired,
    contactPhone: normalizeToE164(flat.contactPhone),
    crossCityTravel: !!flat.crossCityTravel,
    planPickupTimes: !!flat.planPickupTimes,
    pickupStartTime: flat.pickupStartTime || '08:00',
  };
}

function buildSchedulesAndPricing(flat) {
  const cats = Array.isArray(flat.pricingCategories) ? flat.pricingCategories : (Array.isArray(flat.ageGroups) ? flat.ageGroups : [])

  const prices = []
  if (flat.pricingModel === 'perGroup') {
    if (Array.isArray(flat.groupSizes)) {
      for (const gs of flat.groupSizes) {
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
      pricingModel: flat.pricingModel || 'perPerson',
      pricingApproach: flat.pricingApproach || 'dependsOnAge',
      uniformPrice: flat.uniformPrice ?? null,
      pricingCategories: cats,
      ageGroups: cats.map(c => ({ label: c.name, minAge: c.minAge, maxAge: c.maxAge })),
      minParticipants: flat.minParticipants ?? null,
      maxParticipants: flat.maxParticipants ?? null,
      groupSizes: Array.isArray(flat.groupSizes) ? flat.groupSizes : [],
      additionalPersonsEnabled: !!flat.additionalPersonsEnabled,
      additionalPersonPrice: flat.additionalPersonPrice ?? null,
      maxGroupsPerTimeSlot: flat.maxGroupsPerTimeSlot ?? 1,
    },
    pricingSchedules: {
      currency: flat.currency || '',
      schedules: [
        {
          name: flat.scheduleName || '',
          startDate: flat.scheduleStartDate || '',
          hasEndDate: !!flat.scheduleHasEndDate,
          endDate: flat.scheduleHasEndDate ? (flat.scheduleEndDate || '') : null,
          timeSlots: Array.isArray(flat.timeSlots) ? flat.timeSlots : [],
          dateExceptions: Array.isArray(flat.dateExceptions) ? flat.dateExceptions : [],
          pricingCategories: cats,
          prices,
        },
      ],
    },
    availability: buildAvailability(flat),
  };
}

function buildAvailability(flat) {
  const weekly = flat.weeklySchedule
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
    timeSlots: Array.isArray(flat.timeSlots) ? flat.timeSlots.map(t => t.startTime) : [],
    startDate: flat.scheduleStartDate || '',
    endDate: flat.scheduleHasEndDate ? (flat.scheduleEndDate || '') : null,
  }
}

function buildBookingAndTickets(flat) {
  const cancellationPolicy = {};

  if (flat.cancellationType === 'standard') {
    cancellationPolicy.type = 'standard';
    cancellationPolicy.label = 'Free cancellation up to 24 hours before';
    cancellationPolicy.cancellationWindowHours = 24;
    cancellationPolicy.refundPercentage = 100;
  } else if (flat.cancellationType === 'all_sales_final') {
    cancellationPolicy.type = 'all_sales_final';
    cancellationPolicy.label = 'No refunds';
    cancellationPolicy.cancellationWindowHours = 0;
    cancellationPolicy.refundPercentage = 0;
  }

  if (flat.supplierCanCancelBadWeather) cancellationPolicy.supplierCanCancelBadWeather = true;
  if (flat.supplierCanCancelNotEnoughTravelers) cancellationPolicy.supplierCanCancelNotEnoughTravelers = true;

  if (flat.cutoffHours != null) cancellationPolicy.cutoffHours = flat.cutoffHours;

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
    ticketType: flat.ticketType || null,
    instantBooking: flat.instantBooking ?? false,
    instantConfirmation: flat.instantConfirmation ?? false,
    maxQuantity: flat.maxQuantity ?? null,
    bookingWindow: flat.bookingWindow || null,
    minAdvanceBookingHours: flat.minAdvanceBookingHours ?? null,
    travelerRequiredInfo: Array.isArray(flat.travelerRequiredInfo) ? flat.travelerRequiredInfo : [],
    cancellationPolicy: Object.keys(cancellationPolicy).length > 0 ? cancellationPolicy : undefined,
    cutoffMinutes: flat.cutoffMinutes ?? 20,
    lastMinuteBookings: !!flat.lastMinuteBookings,
    perSlotCutoff: !!flat.perSlotCutoff,
  };
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
