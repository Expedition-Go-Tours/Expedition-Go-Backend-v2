const { z } = require('zod');

const locationSchema = z.object({
  name: z.string().min(1, 'Location name is required'),
  visitType: z.string().min(1, 'Visit type is required'),
  address: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  region: z.string().optional(),
});

const locationPointSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  address: z.string().min(1, 'Address is required'),
  lat: z.number(),
  lng: z.number(),
});

const productOptionSchema = z.object({
  id: z.string(),
  title: z.string().min(1, 'Option title is required'),
  refCode: z.string().optional(),
  description: z.string().optional(),
  languages: z.array(z.string()).min(1, 'At least one language required'),
  guideMaterials: z.object({
    audioGuide: z.boolean(),
    infoBooklet: z.boolean(),
  }),
  isPrivate: z.boolean(),
  skipTheLine: z.enum(['none', 'skip_tickets', 'separate_entrance', 'express_security', 'express_elevators']),
  wheelchairAccessible: z.boolean(),
  duration: z.number().nullable(),
  durationUnit: z.enum(['minutes', 'hours', 'days']).nullable(),
  validity: z.number().nullable(),
  validityUnit: z.enum(['days', 'weeks', 'months']).nullable(),
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
});

const pickupAreaSchema = z.object({
  name: z.string().min(1, 'Pickup area name is required'),
  time: z.string().min(1, 'Pickup time is required'),
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

const ageGroupSchema = z.object({
  name: z.string().min(1, 'Age group name is required'),
  price: z.number().min(0, 'Price must be 0 or greater').nullable().optional(),
  minAge: z.number().min(0, 'Min age must be 0 or greater'),
  maxAge: z.number().min(0, 'Max age must be 0 or greater'),
  notAllowed: z.boolean().optional(),
  ticketNotRequired: z.boolean().optional(),
  needsAdult: z.boolean().optional(),
});

const pricingTierSchema = z.object({
  id: z.string(),
  from: z.number().min(1).nullable(),
  to: z.number().min(1).nullable(),
  pricePerPerson: z.number().min(0).nullable(),
});

const groupSizeSchema = z.object({
  id: z.string(),
  size: z.number().min(1).nullable(),
  price: z.number().min(0).nullable(),
});

const photoObjectSchema = z.object({
  id: z.string(),
  url: z.string(),
});

const productSchema = z.object({
  // Step 1
  language: z.string().min(1, 'Select a language'),
  // Step 2
  category: z.string().min(1, 'Select a product category'),
  activityType: z.string().optional(),
  difficulty: z.string().optional(),
  duration: z.number().nullable().optional(),
  durationUnit: z.enum(['minutes', 'hours', 'days']).optional(),
  // Step 3
  title: z.string().min(1, 'Title is required'),
  referenceCode: z.string().optional(),
  // Step 4
  shortDescription: z.string().optional(),
  fullDescription: z.string().optional(),
  highlights: z.array(z.string()).optional(),
  // Step 5
  locations: z.array(locationSchema).optional(),
  // Step 6
  keywords: z.array(z.string()).max(15, 'Maximum 15 keywords').optional(),
  // Step 7
  whatsIncluded: z.array(z.string()).optional(),
  whatsNotIncluded: z.array(z.string()).optional(),
  guideType: z.enum(['guide', 'driver', 'host', 'nobody']).optional(),
  foodProvided: z.boolean().optional(),
  mealType: z.string().optional(),
  drinksIncluded: z.boolean().optional(),
  dietaryOptions: z.array(z.string()).optional(),
  transportationProvided: z.boolean().optional(),
  transportationType: z.string().optional(),
  // Step 8
  photos: z.array(photoObjectSchema).optional(),
  copyrightConfirmed: z.boolean().optional(),
  // Step 9
  notSuitableFor: z.array(z.string()).optional(),
  notAllowed: z.array(z.string()).optional(),
  petFriendly: z.boolean().optional(),
  mandatoryItems: z.array(z.string()).optional(),
  knowBeforeYouGo: z.string().optional(),
  emergencyCountryCode: z.string().optional(),
  emergencyPhone: z.string().optional(),
  voucherInfo: z.string().optional(),
  // Step 10
  options: z.array(productOptionSchema).optional(),
  // Step 11
  meetingPoint: locationPointSchema.nullable().optional(),
  meetingPointDescription: z.string().optional(),
  arrivalTime: z.string().optional(),
  pickupProvided: z.boolean().optional(),
  pickupType: z.enum(['area', 'address']).optional(),
  pickupDescription: z.string().optional(),
  referenceStartTime: z.string().optional(),
  pickupAreas: z.array(pickupAreaSchema).optional(),
  dropoffProvided: z.boolean().optional(),
  dropoffDescription: z.string().optional(),
  // Step 12
  pricingModel: z.enum(['perPerson', 'perGroup']).optional(),
  currency: z.string().optional(),
  scheduleType: z.enum(['fixedTimeSlot', 'operatingHours']).optional(),
  scheduleName: z.string().optional(),
  scheduleStartDate: z.string().optional(),
  scheduleHasEndDate: z.boolean().optional(),
  scheduleEndDate: z.string().optional(),
  timeSlots: z.array(timeSlotSchema).optional(),
  operatingHoursStart: z.string().optional(),
  operatingHoursEnd: z.string().optional(),
  dateExceptions: z.array(dateExceptionSchema).optional(),
  pricingApproach: z.enum(['sameForEveryone', 'dependsOnAge']).optional(),
  ageGroups: z.array(ageGroupSchema).optional(),
  minParticipants: z.number().min(1).optional(),
  maxParticipants: z.number().min(1).optional(),
  pricingTiers: z.array(pricingTierSchema).optional(),
  groupSizes: z.array(groupSizeSchema).optional(),
  additionalPersonsEnabled: z.boolean().optional(),
  additionalPersonPrice: z.number().min(0).nullable().optional(),
  maxGroupsPerTimeSlot: z.number().min(1).optional(),
  // Step 13
  itinerary: z.array(itineraryEntrySchema).optional(),

  // Prisma-level fields
  status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED']).optional(),
  coverPhoto: z.string().optional(),
  coverPhotoIndex: z.number().optional(),
  existingPhotos: z.array(z.string()).optional(),
  metaTitle: z.string().optional(),
  metaDescription: z.string().optional(),
});

module.exports = { productSchema, locationSchema, itineraryEntrySchema };
