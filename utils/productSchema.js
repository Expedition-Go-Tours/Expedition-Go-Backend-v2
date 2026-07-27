const { z } = require('zod');

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
  admissionIncluded: z.enum(['yes', 'no', 'na']).optional(),
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
  admissionIncluded: z.enum(['yes', 'no', 'na']),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
});

const productOptionSchema = z.object({
  id: z.string(),
  title: z.string().min(1, 'Option title is required'),
  refCode: z.string().optional(),
  description: z.string().optional(),
  languages: z.array(z.string()).min(1, 'At least one language required'),
  isPrivate: z.boolean(),
  skipTheLine: z.enum(['none', 'skip_tickets', 'separate_entrance', 'express_security', 'express_elevators']),
  wheelchairAccessible: z.boolean(),
  audioGuide: z.boolean().optional(),
  infoBooklet: z.boolean().optional(),
  maxGroupSize: z.number().nullable().optional(),
  duration: z.number().nullable(),
  durationUnit: z.enum(['minutes', 'hours', 'days']).nullable(),
  validity: z.number().nullable(),
  validityUnit: z.enum(['days', 'weeks', 'months']).nullable(),
  validityEnabled: z.boolean().optional(),
  validityType: z.enum(['date_picked', 'from_activation', 'period']).optional(),
  validityStartDate: z.string().optional(),
  validityEndDate: z.string().optional(),
});

const itineraryEntrySchema = z.object({
  day: z.number().min(1, 'Day number must be 1 or greater'),
  time: z.string().min(1, 'Start time is required'),
  type: z.enum(['activity', 'transfer']),
  locationName: z.string().optional(),
  locationAddress: z.string().optional(),
  locationLat: z.number().nullable().optional(),
  locationLng: z.number().nullable().optional(),
  isCustomLocation: z.boolean().optional(),
  duration: z.number().min(0, 'Duration is required'),
  durationUnit: z.enum(['minute', 'hour', 'day']),
  title: z.string().optional(),
  description: z.string().min(1, 'Description is required'),
  isOptional: z.boolean().optional(),
  additionalFee: z.boolean().optional(),
  activityName: z.string().optional(),
  importance: z.enum(['major', 'minor']).optional(),
  photo: z.string().optional(),
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
  size: z.number().min(1).nullable(),
  price: z.number().min(0).nullable(),
});

const photoObjectSchema = z.string();

const productSchema = z.object({
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
  // Step 3
  title: z.string().min(1, 'Title is required'),
  referenceCode: z.string().max(50).optional(),
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
  photos: z.array(photoObjectSchema).min(4, 'Upload at least 4 photos'),
  copyrightConfirmed: z.literal(true, {
    message: 'You must confirm copyright ownership',
  }).optional(),
  // Step 9
  notSuitableFor: z.array(z.string()).optional(),
  notAllowed: z.array(z.string()).optional(),
  petFriendly: z.boolean().optional(),
  mandatoryItems: z.array(z.string()).optional(),
  knowBeforeYouGo: z.string().max(2000).optional(),
  emergencyCountryCode: z.string().max(5).optional(),
  emergencyPhone: z.string().max(20).optional(),
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
  // Step 13
  itinerary: z.array(itineraryEntrySchema).optional(),

  // Theme fields
  primaryTheme: z.string().optional(),
  secondaryThemes: z.array(z.string()).optional(),
  // Cancellation
  cutoffHours: z.number().min(0).optional(),
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
  planPickupTimes: z.boolean().optional(),
  pickupStartTime: z.string().optional(),
});

module.exports = { productSchema, locationSchema, itineraryEntrySchema, attractionSchema };
