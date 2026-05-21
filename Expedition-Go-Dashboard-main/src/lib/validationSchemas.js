import { z } from "zod";

// Common validation patterns
const emailSchema = z.string().email("Invalid email address");
const phoneSchema = z.string().regex(/^\+?[1-9]\d{1,14}$/, "Invalid phone number");
const urlSchema = z.string().url("Invalid URL");
const passwordSchema = z.string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
  .regex(/[a-z]/, "Password must contain at least one lowercase letter")
  .regex(/[0-9]/, "Password must contain at least one number");

// Authentication schemas
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required"),
  rememberMe: z.boolean().optional(),
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export const resetPasswordSchema = z.object({
  password: passwordSchema,
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

// Booking schemas
export const bookingFilterSchema = z.object({
  search: z.string().optional(),
  status: z.array(z.string()).optional(),
  travelDateFrom: z.string().optional(),
  travelDateTo: z.string().optional(),
  sortBy: z.string().optional(),
  page: z.number().min(0).optional(),
  pageSize: z.number().min(1).max(100).optional(),
});

export const updateBookingStatusSchema = z.object({
  status: z.enum([
    "AWAITING_CONFIRMATION",
    "CONFIRMED",
    "CANCELLED",
    "REJECTED",
    "REFUND_REQUEST",
    "REFUNDED",
    "REFUND_REJECTED",
    "AMENDMENT_REQUEST",
    "AMENDED",
  ]),
  reason: z.string().optional(),
  notes: z.string().optional(),
});

// Product/Tour schemas
export const productTypeSchema = z.object({
  productType: z.enum(["tour", "activity", "transport"], {
    required_error: "Please select a product type",
  }),
  tourTransportationModes: z.array(z.string()).optional(),
  tourDurationCategory: z.string().optional(),
  activityCategories: z.array(z.string()).optional(),
  transportCategories: z.array(z.string()).optional(),
}).refine((data) => {
  if (data.productType === "tour") {
    return data.tourTransportationModes && data.tourTransportationModes.length > 0;
  }
  return true;
}, {
  message: "Please select at least one transportation mode",
  path: ["tourTransportationModes"],
}).refine((data) => {
  if (data.productType === "tour") {
    return !!data.tourDurationCategory;
  }
  return true;
}, {
  message: "Please select a tour duration",
  path: ["tourDurationCategory"],
});

export const productBasicsSchema = z.object({
  title: z.string()
    .min(10, "Title must be at least 10 characters")
    .max(200, "Title must not exceed 200 characters"),
  description: z.string()
    .min(50, "Description must be at least 50 characters")
    .max(5000, "Description must not exceed 5000 characters"),
  shortSummary: z.string()
    .max(300, "Summary must not exceed 300 characters")
    .optional(),
  category: z.string().min(1, "Category is required"),
  theme: z.string().optional(),
  tags: z.array(z.string()).optional(),
  slug: z.string()
    .regex(/^[a-z0-9-]+$/, "Slug must contain only lowercase letters, numbers, and hyphens")
    .optional(),
  difficulty: z.enum(["easy", "moderate", "challenging", "extreme"]).optional(),
  duration: z.number().min(1, "Duration must be at least 1"),
  durationUnit: z.enum(["hours", "days", "weeks"]),
});

export const productPhotosSchema = z.object({
  photos: z.array(z.object({
    url: z.string().url(),
    alt: z.string().optional(),
  })).min(1, "At least one photo is required"),
  heroImage: z.string().url("Hero image is required"),
  videoUrl: urlSchema.optional().or(z.literal("")),
});

export const productPricingSchema = z.object({
  pricing: z.object({
    basePrice: z.number().min(1, "Base price must be greater than 0"),
    currency: z.string().default("USD"),
    tiers: z.array(z.object({
      name: z.string(),
      price: z.number().min(0),
      minAge: z.number().min(0),
      maxAge: z.number().min(0),
    })).optional(),
    taxes: z.number().min(0).optional(),
    fees: z.number().min(0).optional(),
    commissionRate: z.number().min(0).max(100).optional(),
  }),
  cancellationPolicy: z.enum(["flexible", "moderate", "strict", "non-refundable"]),
  refundRules: z.string().optional(),
});

export const productScheduleSchema = z.object({
  schedule: z.object({
    operatingDays: z.array(z.string()).min(1, "At least one operating day is required"),
    timeSlots: z.array(z.object({
      startTime: z.string(),
      endTime: z.string(),
    })).min(1, "At least one time slot is required"),
    seasonalAvailability: z.enum(["all_year", "seasonal"]),
    blackoutDates: z.array(z.string()).optional(),
    capacityPerSlot: z.number().min(1, "Capacity must be at least 1"),
    bookingCutoffHours: z.number().min(0),
  }),
});

export const productBookingRulesSchema = z.object({
  bookingRules: z.object({
    confirmationType: z.enum(["instant", "manual"]),
    minAdvanceBookingHours: z.number().min(0),
    maxGroupSize: z.number().min(1),
    minGroupSize: z.number().min(1),
    meetingPoint: z.string().min(1, "Meeting point is required"),
    pickupAvailable: z.boolean(),
    pickupDetails: z.string().optional(),
    inclusions: z.array(z.string()).optional(),
    exclusions: z.array(z.string()).optional(),
  }),
});

export const productContentSchema = z.object({
  content: z.object({
    itinerary: z.string().optional(),
    highlights: z.array(z.string()).optional(),
    included: z.array(z.string()).optional(),
    excluded: z.array(z.string()).optional(),
    meetingInstructions: z.string().optional(),
    additionalInfo: z.string().optional(),
    languages: z.array(z.string()).min(1, "At least one language is required"),
  }),
});

// User management schemas
export const createUserSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: emailSchema,
  role: z.enum(["ADMIN", "SUPPLIER", "CUSTOMER"]),
  phone: phoneSchema.optional(),
  status: z.enum(["active", "suspended"]).default("active"),
});

export const updateUserSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").optional(),
  email: emailSchema.optional(),
  role: z.enum(["ADMIN", "SUPPLIER", "CUSTOMER"]).optional(),
  phone: phoneSchema.optional(),
  status: z.enum(["active", "suspended"]).optional(),
});

// Review moderation schemas
export const moderateReviewSchema = z.object({
  action: z.enum(["approve", "reject", "flag"]),
  reason: z.string().optional(),
  internalNotes: z.string().optional(),
});

export const replyToReviewSchema = z.object({
  reply: z.string()
    .min(10, "Reply must be at least 10 characters")
    .max(1000, "Reply must not exceed 1000 characters"),
});

// Settings schemas
export const companyProfileSchema = z.object({
  name: z.string().min(2, "Company name is required"),
  email: emailSchema,
  phone: phoneSchema,
  address: z.string().min(5, "Address is required"),
  city: z.string().min(2, "City is required"),
  country: z.string().min(2, "Country is required"),
  timezone: z.string(),
  currency: z.string(),
  logo: urlSchema.optional(),
});

export const notificationPreferencesSchema = z.object({
  emailNotifications: z.object({
    bookings: z.boolean(),
    reviews: z.boolean(),
    payments: z.boolean(),
    systemAlerts: z.boolean(),
  }),
  pushNotifications: z.object({
    bookings: z.boolean(),
    reviews: z.boolean(),
    payments: z.boolean(),
    systemAlerts: z.boolean(),
  }),
});

// Export all schemas
export const validationSchemas = {
  // Auth
  login: loginSchema,
  forgotPassword: forgotPasswordSchema,
  resetPassword: resetPasswordSchema,
  
  // Bookings
  bookingFilter: bookingFilterSchema,
  updateBookingStatus: updateBookingStatusSchema,
  
  // Products
  productType: productTypeSchema,
  productBasics: productBasicsSchema,
  productPhotos: productPhotosSchema,
  productPricing: productPricingSchema,
  productSchedule: productScheduleSchema,
  productBookingRules: productBookingRulesSchema,
  productContent: productContentSchema,
  
  // Users
  createUser: createUserSchema,
  updateUser: updateUserSchema,
  
  // Reviews
  moderateReview: moderateReviewSchema,
  replyToReview: replyToReviewSchema,
  
  // Settings
  companyProfile: companyProfileSchema,
  notificationPreferences: notificationPreferencesSchema,
};
