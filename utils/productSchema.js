const { z } = require('zod');
const { isValidPhoneNumber } = require('libphonenumber-js');
const { MAX_PRICE, isValidCurrencyCode } = require('./currencyCodes');

const locationSchema = z.object({
  name: z.string().min(1, 'Location name is required'),
  address: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  region: z.string().optional(),
  description: z.string().optional(),
  timeSpent: z.number().nullable().optional(),
  timeSpentUnit: z.enum(['minutes', 'hours']).optional(),
  admissionIncluded: z.enum(['yes', 'no', 'passby']).optional(),
  isDropoff: z.boolean().optional(),
  isPickup: z.boolean().optional(),
});

const locationPointSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  address: z.string().min(1, 'Address is required'),
  lat: z.number(),
  lng: z.number(),
});

const attractionSchema = z.object({
  id: z.string(),
  name: z.string().min(1, 'Attraction name is required'),
  location: z.string().optional(),
  description: z.string().optional(),
  timeSpent: z.number().nullable(),
  timeSpentUnit: z.enum(['minutes', 'hours']),
  admissionIncluded: z.enum(['yes', 'no', 'passby']),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
});

const productOptionSchema = z.object({
  id: z.string(),
  title: z.string().min(1, 'Option title is required'),
  refCode: z.string().optional(),
  description: z.string().optional(),
  isPrivate: z.boolean(),
  skipTheLine: z.enum(['none', 'skip_tickets', 'separate_entrance', 'express_security', 'express_elevators']),
  wheelchairAccessible: z.boolean().catch(false),
  audioGuide: z.boolean().optional(),
  infoBooklet: z.boolean().optional(),
  maxGroupSize: z.number().nullable().optional(),
  duration: z.number().nullable().optional(),
  durationUnit: z.enum(['minutes', 'hours', 'days']).nullable().optional(),
  validity: z.number().nullable(),
  validityUnit: z.enum(['days', 'weeks', 'months']).nullable(),
  validityEnabled: z.boolean().optional(),
  // The frontend labels the "from activation" validity type as "open_ended".
  // Accept the frontend's value and normalize it to the canonical stored value.
  validityType: z.enum(['date_picked', 'from_activation', 'period', 'open_ended'])
    .transform((v) => (v === 'open_ended' ? 'from_activation' : v))
    .optional(),
  validityStartDate: z.string().optional(),
  validityEndDate: z.string().optional(),
});

const pickupAreaSchema = z.object({
  name: z.string().min(1, 'Pickup area name is required'),
  time: z.string(),
});

const timeSlotSchema = z.object({
  id: z.string(),
  startTime: z.string().min(1, 'Start time is required'),
  cutoff: z.number().min(0).optional(),
});

const dateExceptionSchema = z.object({
  id: z.string(),
  date: z.string(),
  type: z.enum(['closed', 'override']),
  overrideTimes: z.array(z.string()).optional(),
});

const pricingTierSchema = z.object({
  id: z.string(),
  from: z.number().min(1).nullable(),
  to: z.number().min(1).nullable(),
  pricePerPerson: z.number().min(0).nullable(),
});

const pricingCategorySchema = z.object({
  name: z.string().min(1, 'Category name is required'),
  price: z.number().min(0, 'Price must be 0 or greater').nullable().optional(),
  minAge: z.number().min(0, 'Min age must be 0 or greater'),
  maxAge: z.number().min(0, 'Max age must be 0 or greater'),
  notAllowed: z.boolean().optional(),
  ticketNotRequired: z.boolean().optional(),
  needsAdult: z.boolean().optional(),
  idRequired: z.boolean().optional(),
  idType: z.string().optional(),
  tiers: z.array(pricingTierSchema).optional(),
});

const groupSizeSchema = z.object({
  id: z.string(),
  from: z.number().min(1).nullable(),
  to: z.number().min(1).nullable(),
  price: z.number().min(0).nullable(),
});

const photoObjectSchema = z.string();

/**
 * Coerce a price-like value to a finite number or null.
 * - null / undefined / ''  -> null (field absent or empty)
 * - numeric string         -> Number (e.g. "50" -> 50)
 * - finite number          -> unchanged
 * - anything else          -> NaN (fails the z.number() check below)
 */
const toNullableNumber = (v) => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
};

/** Nullable, finite, non-negative price capped at the Decimal(10,2) ceiling. */
const numericOrNull = z.preprocess(toNullableNumber, z.number().min(0).max(MAX_PRICE).nullable());

/** Nullable, finite, positive integer (participants, group size bounds). */
const intOrNull = z.preprocess(toNullableNumber, z.number().int().min(1).nullable());

const storedPriceSchema = z.object({
  ageGroup: z.string().optional(),
  label: z.string().optional(),
  retailPrice: numericOrNull.optional(),
  groupSize: z.boolean().optional(),
  days: z.array(z.string()).optional(),
  times: z.array(z.string()).optional(),
});

const storedPricingCategorySchema = z.object({
  name: z.string().optional(),
  label: z.string().optional(),
  price: numericOrNull.optional(),
  minAge: z.number().finite().optional(),
  maxAge: z.number().finite().optional(),
  notAllowed: z.boolean().optional(),
  ticketNotRequired: z.boolean().optional(),
  needsAdult: z.boolean().optional(),
  idRequired: z.boolean().optional(),
  idType: z.string().optional(),
  tiers: z.array(z.object({
    id: z.string().optional(),
    from: intOrNull.optional(),
    to: intOrNull.optional(),
    pricePerPerson: numericOrNull.optional(),
  })).optional(),
});

const storedGroupSizeSchema = z.object({
  id: z.string().optional(),
  from: intOrNull.optional(),
  to: intOrNull.optional(),
  price: numericOrNull.optional(),
});

const storedTimeSlotSchema = z.object({
  id: z.string().optional(),
  startTime: z.string().optional(),
  cutoff: z.number().finite().optional(),
});

const storedDateExceptionSchema = z.object({
  id: z.string().optional(),
  date: z.string().optional(),
  type: z.string().optional(),
  overrideTimes: z.array(z.string()).optional(),
});

const weeklyHoursSchema = z.record(z.array(z.object({
  startTime: z.string().optional(),
  endTime: z.string().optional(),
}))).nullable().optional();

const isoCurrencyRefine = (c) => c === '' || c == null || isValidCurrencyCode(c);
const isoCurrencyCode = z.string().refine(isoCurrencyRefine, { message: 'Invalid ISO 4217 currency code' });

const storedPricingScheduleSchema = z.object({
  name: z.string().optional(),
  type: z.string().optional(),
  startDate: z.string().optional(),
  hasEndDate: z.boolean().optional(),
  endDate: z.string().nullable().optional(),
  weeklySchedule: weeklyHoursSchema,
  dateExceptions: z.array(storedDateExceptionSchema).optional(),
  timeSlots: z.array(storedTimeSlotSchema).optional(),
  pricingModel: z.string().optional(),
  currency: isoCurrencyCode.optional(),
  pricingApproach: z.string().optional(),
  uniformPrice: numericOrNull.optional(),
  pricingCategories: z.array(storedPricingCategorySchema).optional(),
  prices: z.array(storedPriceSchema).optional(),
  minParticipants: intOrNull.optional(),
  maxParticipants: intOrNull.optional(),
});

const promotionSchema = z.object({
  id: z.string().optional(),
  isActive: z.boolean().optional(),
  type: z.enum(['percentage', 'fixedAmount']).optional(),
  discountValue: numericOrNull.optional(),
  maximumDiscountAmount: numericOrNull.optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  promoCode: z.string().optional(),
});

/**
 * Type-level validation for the nested `schedulesAndPricing` blob that the
 * supplier dashboard sends on every save. Completeness (at least one schedule,
 * positive prices, currency present) is NOT enforced here — that is the job of
 * `validateStoredPricing` at publish time. This schema exists to reject
 * structurally-garbage data (non-numeric prices, out-of-range values, NaN,
 * bogus currency) on every write, including partial DRAFT saves, so bad data
 * can never accumulate silently in storage.
 *
 * Every nested field is optional so partial wizard saves validate cleanly.
 */
const schedulesAndPricingSchema = z.object({
  currency: isoCurrencyCode.optional(),
  travelerDetails: z.object({
    pricingModel: z.enum(['perPerson', 'perGroup']).optional(),
    pricingApproach: z.enum(['sameForEveryone', 'dependsOnAge']).optional(),
    uniformPrice: numericOrNull.optional(),
    pricingCategories: z.array(storedPricingCategorySchema).optional(),
    ageGroups: z.array(storedPricingCategorySchema).optional(),
    minParticipants: intOrNull.optional(),
    maxParticipants: intOrNull.optional(),
    groupSizes: z.array(storedGroupSizeSchema).optional(),
    additionalPersonsEnabled: z.boolean().optional(),
    additionalPersonPrice: numericOrNull.optional(),
    maxGroupsPerTimeSlot: z.number().finite().optional(),
  }).optional(),
  pricingSchedules: z.object({
    currency: isoCurrencyCode.optional(),
    schedules: z.array(storedPricingScheduleSchema).optional(),
  }).optional(),
  availability: z.object({
    scheduleType: z.string().optional(),
    operatingHoursStart: z.string().optional(),
    operatingHoursEnd: z.string().optional(),
    weeklySchedule: weeklyHoursSchema,
    timeSlots: z.array(z.union([z.string(), storedTimeSlotSchema])).optional(),
    daysOfWeek: z.array(z.string()).optional(),
    startDate: z.string().optional(),
    endDate: z.string().nullable().optional(),
    timezone: z.string().optional(),
  }).optional(),
  promotions: z.array(promotionSchema).optional(),
});

const productObjectSchema = z.object({
  // Step 1
  language: z.string().min(1, 'Select a language').max(50, 'Language must be at most 50 characters'),
  // Step 2
  category: z.string().min(1, 'Select a product category'),
  subcategory: z.string().max(100).optional(),
  activityType: z.string().max(100).optional(),
  difficulty: z.string().max(50).optional(),
  transportMode: z.string().max(50).optional(),
  duration: z.number().nullable().optional(),
  durationUnit: z.enum(['minutes', 'hours', 'days']).optional(),
  accommodationIncluded: z.boolean().optional(),
  // Step 3
  title: z.string().min(1, 'Title is required').max(60, 'Title must be at most 60 characters'),
  referenceCode: z.string().max(20).optional(),
  // Step 4
  shortDescription: z.string().min(10, 'Short description must be at least 10 characters').max(200, 'Short description must be at most 200 characters'),
  fullDescription: z.string().min(500, 'Full description must be at least 500 characters').max(3000, 'Full description must be at most 3000 characters'),
  highlights: z.array(z.string().min(1, 'Each highlight must have at least 1 character')).min(3, 'Add at least 3 highlights').max(5, 'Maximum 5 highlights'),
  // Step 5
  locations: z.array(locationSchema).optional(),
  attractions: z.array(attractionSchema).optional(),
  // Step 6
  keywords: z.array(z.string()).max(15, 'Maximum 15 keywords').optional(),
  // Step 7
  activitiesIncluded: z.array(z.string()).optional(),
  pickupTransportTypes: z.array(z.string()).optional(),
  whatsIncluded: z.array(z.string()).optional(),
  whatsNotIncluded: z.array(z.string()).optional(),
  guideType: z.enum(['tour-guide', 'driver', 'host', 'greeter', 'self-guided', 'instructor']).optional(),
    guideMaterials: z.object({
    audioGuide: z.boolean(),
    infoBooklet: z.boolean(),
  }),
  foodProvided: z.boolean().optional(),
  meals: z.array(z.object({
    type: z.string().optional(),
    format: z.string().optional(),
  })).optional(),
  mealType: z.string().optional(),
  showDietaryRestrictions: z.boolean().optional(),
  drinksIncluded: z.boolean().optional(),
  dietaryOptions: z.array(z.string()).optional(),
  transportationProvided: z.boolean().optional(),
  transportationType: z.string().optional(),
  // Step 8
  photos: z.array(photoObjectSchema).min(5, 'Upload at least 5 photos'),
  copyrightConfirmed: z.literal(true, {
    message: 'You must confirm copyright ownership',
  }).optional(),
  // Step 9
  notSuitableFor: z.array(z.string()).optional(),
  notAllowed: z.array(z.string()).optional(),
  petFriendly: z.boolean().optional(),
  wifiIncluded: z.boolean({ required_error: 'WiFi/Internet availability is required' }),
  mandatoryItems: z.array(z.string()).optional(),
  knowBeforeYouGo: z.string().max(2000).optional(),
  emergencyCountryCode: z.string().max(5).optional(),
  emergencyPhone: z.string()
    .refine((val) => !val || isValidPhoneNumber(val), { message: 'Invalid phone number' })
    .optional(),
  voucherInfo: z.string().max(500).optional(),
  // Step 10
  options: z.array(productOptionSchema).optional(),
  // Step 11
  meetingMode: z.enum(['meeting_point', 'pickup', 'none']),
  meetingPoint: locationPointSchema.nullable().optional(),
  meetingPointPicture: z.string().max(2000).optional(),
  meetingPointDescription: z.string().max(1000).optional(),
  arrivalTimeType: z.enum(['none', '5min', '10min', '15min', '30min', 'notified', 'custom']).optional(),
  arrivalTimeCustom: z.string().max(20).optional(),
  pickupType: z.enum(['area', 'address']).optional(),
  pickupDescription: z.string().max(500).optional(),
  pickupTiming: z.enum(['at_start', 'before_start']).optional(),
  pickupAtSpecificTime: z.boolean().optional(),
  pickupFinalLocationTiming: z.enum(['day_before', 'after_selection']).optional(),
  referenceStartTime: z.string().max(20).optional(),
  pickupAreas: z.array(pickupAreaSchema).optional(),
  pickupLocations: z.array(locationPointSchema).optional(),
  pickupGeoshape: z.any().nullable().optional(),
  dropoffOption: z.enum(['same_location', 'different_location', 'none', 'service']).optional(),
  dropoffLocation: locationPointSchema.nullable().optional(),
  dropoffDescription: z.string().max(500).optional(),
  // Step 12
  pricingModel: z.enum(['perPerson', 'perGroup']).optional(),
  currency: z.string().optional(),
  scheduleType: z.enum(['fixedTimeSlot', 'operatingHours']).optional(),
  scheduleName: z.string().max(100).optional(),
  scheduleStartDate: z.string().optional(),
  scheduleHasEndDate: z.boolean().optional(),
  scheduleEndDate: z.string().optional(),
  timeSlots: z.array(timeSlotSchema).optional(),
  operatingHoursStart: z.string().optional(),
  operatingHoursEnd: z.string().optional(),
  dateExceptions: z.array(dateExceptionSchema).optional(),
  pricingApproach: z.enum(['sameForEveryone', 'dependsOnAge']).optional(),
  pricingCategories: z.array(pricingCategorySchema).optional(),
  ageGroups: z.array(pricingCategorySchema).optional(),
  weeklySchedule: z.record(z.array(z.object({
    startTime: z.string(),
    endTime: z.string(),
  }))).optional(),
  minParticipants: z.number().min(1).optional(),
  maxParticipants: z.number().min(1).optional(),
  groupSizes: z.array(groupSizeSchema).optional(),
  additionalPersonsEnabled: z.boolean().optional(),
  additionalPersonPrice: z.number().min(0).nullable().optional(),
  maxGroupsPerTimeSlot: z.number().min(1).optional(),
  // Full nested pricing/availability blob written by the dashboard's autosave.
  // Validated for structural soundness on every write (type-safe numbers,
  // bounded prices, ISO 4217 currency); completeness is enforced at publish by
  // validateStoredPricing.
  schedulesAndPricing: schedulesAndPricingSchema.nullable().optional(),

  // Cancellation
  cutoffHours: z.number().min(0).optional(),
  cancellationType: z.enum(['standard', 'all_sales_final']).optional(),
  supplierCanCancelBadWeather: z.boolean().optional(),
  supplierCanCancelNotEnoughTravelers: z.boolean().optional(),
  // Prisma-level fields
  status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED']).optional(),
  coverPhoto: z.string().optional(),
  coverPhotoIndex: z.number().optional(),
  existingPhotos: z.array(z.string()).optional(),
  metaTitle: z.string().max(120).optional(),
  metaDescription: z.string().max(320).optional(),
  transportModes: z.array(z.string()).optional(),
  transportServices: z.array(z.string()).optional(),
  crossCityTravel: z.boolean().optional(),
  cutoffMinutes: z.number().optional(),
  lastMinuteBookings: z.boolean().optional(),
  perSlotCutoff: z.boolean().optional(),
  // Per-slot cut-off values in minutes, keyed by slot start time ("HH:MM").
  // Bounded to GYG's range (5 min..10 h); the frontend offers 5-min increments
  // for the first hour then fixed hours. 0 is tolerated for legacy/edge data.
  perSlotCutoffs: z.record(z.string(), z.number().min(0).max(600)).optional(),
  timezone: z.string().optional(),
  planPickupTimes: z.boolean().optional(),
  pickupStartTime: z.string().optional(),
});

/**
 * Conditional validation: require accommodationIncluded when duration >= 24 hours
 */
function accommodationInclusionRefinement(data, ctx) {
  if (data.duration != null && data.durationUnit) {
    const durationInHours = data.durationUnit === 'days' ? data.duration * 24
      : data.durationUnit === 'hours' ? data.duration
      : data.duration / 60;
    if (durationInHours >= 24 && data.accommodationIncluded === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['accommodationIncluded'],
        message: 'Accommodation inclusion is required for tours 24 hours or longer',
      });
    }
  }
}

const MINUTES_PER = {
  minutes: 1,
  hours: 60,
  days: 60 * 24,
};

function durationToMinutes(value, unit) {
  if (value == null || Number.isNaN(Number(value))) return 0;
  const factor = MINUTES_PER[unit] || MINUTES_PER.minutes;
  return Number(value) * factor;
}

function sumStopMinutes(locations) {
  if (!Array.isArray(locations)) return 0;
  return locations.reduce((sum, loc) => {
    if (!loc || loc.timeSpent == null || Number.isNaN(Number(loc.timeSpent))) return sum;
    const factor = MINUTES_PER[loc.timeSpentUnit] || MINUTES_PER.minutes;
    return sum + Number(loc.timeSpent) * factor;
  }, 0);
}

/**
 * The sum of stop durations in the itinerary must not exceed the product
 * duration declared in the category step.
 */
function locationDurationRefinement(data, ctx) {
  if (data.duration == null || Number.isNaN(Number(data.duration))) return;
  const productMin = durationToMinutes(data.duration, data.durationUnit || 'hours');
  if (productMin <= 0) return;
  const stopsMin = sumStopMinutes(data.locations);
  if (stopsMin > productMin) {
    ctx.addIssue({
      code: 'custom',
      path: ['locations'],
      message: `Total stop time exceeds the product duration (${productMin} minutes)`,
    });
  }
}

// Full schema used for strict validation (submit-for-review).
const productSchema = productObjectSchema
  .superRefine(accommodationInclusionRefinement)
  .superRefine(locationDurationRefinement);

// Partial variant for progressive wizard/draft saves. Each field is optional
// so the wizard can save progress step-by-step. Fields that enforce
// completeness in the full schema (e.g. photos.min(4), highlights.min(3))
// are relaxed here — the submit-for-review endpoint enforces completeness
// via validateTourForReview() instead.
const productSchemaPartial = productObjectSchema.partial().superRefine(accommodationInclusionRefinement);
// Override strict .min() constraints that block autosave of incomplete drafts.
// Keep type/max-length validation for structural correctness.
productSchemaPartial._def.shape = {
  ...productSchemaPartial._def.shape,
  language: z.string().max(50).optional(),
  category: z.string().optional(),
  title: z.string().max(60).optional(),
  shortDescription: z.string().max(200).optional(),
  fullDescription: z.string().max(3000).optional(),
  highlights: z.array(z.string()).optional(),
  photos: z.array(photoObjectSchema).optional(),
  meetingMode: z.enum(['meeting_point', 'pickup', 'none']).optional(),
  guideMaterials: z.object({ audioGuide: z.boolean(), infoBooklet: z.boolean() }).optional(),
};

module.exports = { productSchema, productSchemaPartial, locationSchema, attractionSchema };
