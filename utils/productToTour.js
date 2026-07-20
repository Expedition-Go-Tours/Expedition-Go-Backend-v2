/**
 * Maps the flat 13-step product builder store shape into:
 *   - 5 JSON blobs (categorization, theme, productContent, schedulesAndPricing, bookingAndTickets)
 *   - normalized columns (city, country, category, slug, tags, etc.)
 *
 * Inverse of the frontend's tourToProduct() mapper.
 */

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
    included: Array.isArray(flat.whatsIncluded) ? flat.whatsIncluded : [],
    excluded: Array.isArray(flat.whatsNotIncluded) ? flat.whatsNotIncluded : [],
    guideType: flat.guideType || 'guide',
    foodProvided: !!flat.foodProvided,
    mealType: flat.mealType || '',
    drinksIncluded: !!flat.drinksIncluded,
    dietaryOptions: Array.isArray(flat.dietaryOptions) ? flat.dietaryOptions : [],
    transportationProvided: !!flat.transportationProvided,
    transportationType: flat.transportationType || '',
    healthRestrictions: Array.isArray(flat.notSuitableFor) ? flat.notSuitableFor : [],
    notAllowed: Array.isArray(flat.notAllowed) ? flat.notAllowed : [],
    petFriendly: !!flat.petFriendly,
    whatToBring: Array.isArray(flat.mandatoryItems) ? flat.mandatoryItems : [],
    additionalInfo: flat.knowBeforeYouGo || '',
    emergencyCountryCode: flat.emergencyCountryCode || '',
    emergencyPhone: flat.emergencyPhone || '',
    voucherInfo: flat.voucherInfo || '',
    options: Array.isArray(flat.options) ? flat.options : [],
    meetingInstructions: flat.meetingPointDescription || '',
    arrivalTime: flat.arrivalTime || '',
    pickupAvailable: !!flat.pickupProvided,
    pickupType: flat.pickupType || 'area',
    pickupDescription: flat.pickupDescription || '',
    referenceStartTime: flat.referenceStartTime || '',
    pickupAreas: Array.isArray(flat.pickupAreas) ? flat.pickupAreas : [],
    dropoffAvailable: !!flat.dropoffProvided,
    dropoffDescription: flat.dropoffDescription || '',
    itinerary: Array.isArray(flat.itinerary) ? flat.itinerary : [],
  };
}

function buildSchedulesAndPricing(flat) {
  return {
    travelerDetails: {
      pricingModel: flat.pricingModel || 'perPerson',
      pricingApproach: flat.pricingApproach || 'dependsOnAge',
      ageGroups: Array.isArray(flat.ageGroups) ? flat.ageGroups : [],
      minParticipants: flat.minParticipants ?? null,
      maxParticipants: flat.maxParticipants ?? null,
      pricingTiers: Array.isArray(flat.pricingTiers) ? flat.pricingTiers : [],
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
        },
      ],
    },
    availability: {
      scheduleType: flat.scheduleType || 'fixedTimeSlot',
      operatingHoursStart: flat.operatingHoursStart || '09:00',
      operatingHoursEnd: flat.operatingHoursEnd || '17:00',
    },
  };
}

function buildBookingAndTickets(flat) {
  const cancellationPolicy = {};
  if (flat.cutoffHours != null) cancellationPolicy.cutoffHours = flat.cutoffHours;

  return {
    meetingPoint: flat.meetingPoint || null,
    arrivalTime: flat.arrivalTime || '',
    pickupProvided: !!flat.pickupProvided,
    pickupType: flat.pickupType || 'area',
    pickupDescription: flat.pickupDescription || '',
    referenceStartTime: flat.referenceStartTime || '',
    pickupAreas: Array.isArray(flat.pickupAreas) ? flat.pickupAreas : [],
    dropoffProvided: !!flat.dropoffProvided,
    dropoffDescription: flat.dropoffDescription || '',
    cancellationPolicy: Object.keys(cancellationPolicy).length > 0 ? cancellationPolicy : undefined,
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
  const unit = flat.durationUnit || 'hours';
  if (unit === 'minutes') return flat.duration;
  if (unit === 'days') return flat.duration * 1440;
  return flat.duration * 60;
}

module.exports = { productToTour };
