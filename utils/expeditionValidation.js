const { z } = require('zod');
const { isValidPhoneNumber } = require('libphonenumber-js');

// Non-numeric metadata keys allowed inside the travelers object (they are never
// counted toward capacity or pricing). Everything else must be a traveler count.
const TRAVELER_META_KEYS = new Set(['phoneNumber', 'location', 'details']);

/** Sum every numeric traveler-count key in the travelers object. */
function sumTravelerCounts(travelers) {
  if (!travelers || typeof travelers !== 'object') return 0;
  let total = 0;
  for (const [key, value] of Object.entries(travelers)) {
    if (TRAVELER_META_KEYS.has(key)) continue;
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) total += value;
  }
  return total;
}

const travelerSchema = z.object({
  adults: z.number().int().min(0).max(50).default(0),
  children: z.number().int().min(0).max(50).default(0),
  infants: z.number().int().min(0).max(50).default(0),
}).passthrough().superRefine((val, ctx) => {
  // Any additional category keys (seniors, students, youth, …) must be valid
  // non-negative integer counts, and the total must be at least 1.
  for (const [key, value] of Object.entries(val)) {
    if (TRAVELER_META_KEYS.has(key)) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 50) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `Traveler count for "${key}" must be a non-negative integer up to 50`,
      });
    }
  }
  if (sumTravelerCounts(val) < 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: 'At least one traveler is required',
    });
  }
});

const travelerWithDetailsSchema = travelerSchema.extend({
  phoneNumber: z.string().superRefine((val, ctx) => {
    if (!isValidPhoneNumber(val)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid phone number "${val}". Use international format (e.g., +12025551234)`,
      });
    }
  }),
  location: z.string().min(3).max(200).optional(),
  details: z
    .array(
      z.object({
        name: z.string().min(1).max(100).optional(),
        age: z.number().int().min(0).max(150).optional(),
        ageGroup: z.string().max(50).optional(),
        specialRequests: z.string().max(500).optional(),
      }),
    )
    .max(50)
    .optional(),
});

const getToursSchema = z.object({
  body: z.any().optional(),
  query: z.object({
    page: z.coerce.number().int().min(1).default(1).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(12).optional(),
    search: z.string().max(200).optional(),
    category: z.string().max(100).optional(),
    city: z.string().max(100).optional(),
    country: z.string().max(100).optional(),
    minPrice: z.coerce.number().min(0).optional(),
    maxPrice: z.coerce.number().min(0).optional(),
    sortBy: z.enum(['price_asc', 'price_desc', 'rating', 'newest', 'popular', 'views']).optional(),
  }).passthrough(),
  params: z.object({}).optional(),
});

const contactSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100),
    email: z.string().email().max(255),
    phone: z.string()
      .refine((val) => !val || isValidPhoneNumber(val), 'Invalid phone number')
      .optional(),
    subject: z.string().max(200).optional(),
    message: z.string().min(10).max(5000),
  }),
  query: z.any().optional(),
  params: z.object({}).optional(),
});

const trackClickSchema = z.object({
  body: z.object({
    event: z.string().min(1).max(100),
    target: z.string().min(1).max(500),
    tourId: z.string().max(100).optional(),
    metadata: z.any().optional(),
  }),
  query: z.any().optional(),
  params: z.object({}).optional(),
});

const calculateCheckoutSchema = z.object({
  body: z.object({
    tourId: z.string().min(1).max(100),
    travelDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format').optional(),
    selectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format').optional(),
    travelers: travelerSchema,
    promoCode: z.string().max(50).optional(),
    selectedTime: z.string().max(50).optional(),
  }).passthrough().superRefine((val, ctx) => {
    if (!val.travelDate && val.selectedDate) {
      val.travelDate = val.selectedDate;
    }
    if (!val.travelDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['travelDate'], message: 'travelDate is required (YYYY-MM-DD)' });
    }
  }),
  query: z.any().optional(),
  params: z.object({}).optional(),
});

const confirmBookingSchema = z.object({
  body: z.object({
    tourId: z.string().min(1).max(100),
    travelDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format').optional(),
    selectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format').optional(),
    travelers: travelerWithDetailsSchema,
    // Required for reserve-now-pay-later (card captured for auto-charge).
    // Pay-now uses Stripe's hosted Checkout page and does not send a card.
    paymentMethodId: z.string().min(1).max(100).optional(),
    paymentTiming: z.enum(['now', 'later']).optional(),
    specialRequests: z.string().max(1000).optional(),
    selectedTime: z.string().max(50).optional(),
    pickup: z.any().optional(),
    leadTraveler: z.object({
      name: z.string().max(200).optional(),
      email: z.string().email().max(255).optional(),
      phone: z.string().max(50).optional(),
    }).optional(),
    promoCode: z.string().max(50).optional(),
  }).passthrough().superRefine((val, ctx) => {
    if (!val.travelDate && val.selectedDate) {
      val.travelDate = val.selectedDate;
    }
    if (!val.travelDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['travelDate'], message: 'travelDate is required (YYYY-MM-DD)' });
    }
  }),
  query: z.any().optional(),
  params: z.object({}).optional(),
});

const tourIdParamSchema = z.object({
  body: z.any().optional(),
  query: z.any().optional(),
  params: z.object({
    tourId: z.string().min(1).max(100),
  }),
});

const searchToursSchema = z.object({
  body: z.any().optional(),
  query: z.object({
    q: z.string().min(2).max(200),
    category: z.string().max(100).optional(),
    city: z.string().max(100).optional(),
    country: z.string().max(100).optional(),
    page: z.coerce.number().int().min(1).default(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20).optional(),
  }).passthrough(),
  params: z.object({}).optional(),
});

const getAdminToursSchema = z.object({
  body: z.any().optional(),
  query: z.object({
    page: z.coerce.number().int().min(1).default(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20).optional(),
    isActive: z.enum(['true', 'false']).optional(),
  }).passthrough(),
  params: z.object({}).optional(),
});

const addTourSchema = z.object({
  body: z.object({
    tourId: z.string().min(1).max(100),
    displayOrder: z.number().int().min(0).default(0).optional(),
    isFeatured: z.boolean().default(false).optional(),
  }),
  query: z.any().optional(),
  params: z.object({}).optional(),
});

const updateTourSchema = z.object({
  body: z.object({
    displayOrder: z.number().int().min(0).optional(),
    isFeatured: z.boolean().optional(),
    isActive: z.boolean().optional(),
  }).refine((data) => data.displayOrder !== undefined || data.isFeatured !== undefined || data.isActive !== undefined, {
    message: 'At least one of displayOrder, isFeatured, or isActive must be provided',
  }),
  query: z.any().optional(),
  params: z.object({
    id: z.string().min(1).max(100),
  }),
});

const removeTourSchema = z.object({
  body: z.any().optional(),
  query: z.any().optional(),
  params: z.object({
    id: z.string().min(1).max(100),
  }),
});

const refreshCacheSchema = z.object({
  body: z.any().optional(),
  query: z.any().optional(),
  params: z.object({
    tourId: z.string().max(100).optional(),
  }),
});

const subscribeSchema = z.object({
  body: z.object({
    email: z.string().email().max(255),
    name: z.string().max(100).optional(),
  }),
  query: z.any().optional(),
  params: z.object({}).optional(),
});

const availabilityCalendarSchema = z.object({
  body: z.any().optional(),
  query: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format'),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format'),
  }),
  params: z.object({
    slug: z.string().min(1).max(300),
  }),
});

const slugParamSchema = z.object({
  body: z.any().optional(),
  query: z.any().optional(),
  params: z.object({
    slug: z.string().min(1).max(300),
  }),
});

const getTourReviewsSchema = z.object({
  body: z.any().optional(),
  query: z.object({
    page: z.coerce.number().int().min(1).default(1).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(10).optional(),
    sortBy: z.enum(['newest', 'highest', 'lowest']).optional(),
  }).passthrough(),
  params: z.object({
    slug: z.string().min(1).max(300),
  }),
});

const getBookingsSchema = z.object({
  body: z.any().optional(),
  query: z.object({
    page: z.coerce.number().int().min(1).default(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(10).optional(),
    status: z.enum(['PENDING', 'CONFIRMED', 'CANCELLED', 'REFUNDED', 'COMPLETED', 'NO_SHOW']).optional(),
  }).passthrough(),
  params: z.object({}).optional(),
});

const bookingIdParamSchema = z.object({
  body: z.any().optional(),
  query: z.any().optional(),
  params: z.object({
    id: z.string().min(1).max(100),
  }),
});

const cancelBookingSchema = z.object({
  body: z.object({
    reason: z.string().max(500).optional(),
  }),
  query: z.any().optional(),
  params: z.object({
    id: z.string().min(1).max(100),
  }),
});

const createReviewSchema = z.object({
  body: z.object({
    bookingId: z.string().min(1).max(100),
    rating: z.number().int().min(1).max(5),
    title: z.string().min(1).max(200).optional(),
    comment: z.string().min(10).max(5000),
  }),
  query: z.any().optional(),
  params: z.object({}).optional(),
});

const getSupplierBookingsSchema = z.object({
  body: z.any().optional(),
  query: z.object({
    page: z.coerce.number().int().min(1).default(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(10).optional(),
    status: z.enum(['PENDING', 'CONFIRMED', 'CANCELLED', 'REFUNDED', 'COMPLETED', 'NO_SHOW']).optional(),
  }).passthrough(),
  params: z.object({}).optional(),
});

const updateBookingStatusSchema = z.object({
  body: z.object({
    status: z.enum(['CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW']),
    reason: z.string().max(500).optional(),
  }),
  query: z.any().optional(),
  params: z.object({
    id: z.string().min(1).max(100),
  }),
});

const analyticsOverviewSchema = z.object({
  body: z.any().optional(),
  query: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format').optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format').optional(),
  }).passthrough(),
  params: z.object({}).optional(),
});

const analyticsRevenueTrendSchema = z.object({
  body: z.any().optional(),
  query: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format').optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format').optional(),
    granularity: z.enum(['day', 'week', 'month']).optional(),
  }).passthrough(),
  params: z.object({}).optional(),
});

const analyticsFunnelSchema = z.object({
  body: z.any().optional(),
  query: z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format').optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format').optional(),
  }).passthrough(),
  params: z.object({}).optional(),
});

module.exports = {
  getToursSchema,
  contactSchema,
  trackClickSchema,
  calculateCheckoutSchema,
  confirmBookingSchema,
  tourIdParamSchema,
  searchToursSchema,
  getAdminToursSchema,
  addTourSchema,
  updateTourSchema,
  removeTourSchema,
  refreshCacheSchema,
  subscribeSchema,
  availabilityCalendarSchema,
  slugParamSchema,
  getTourReviewsSchema,
  getBookingsSchema,
  bookingIdParamSchema,
  cancelBookingSchema,
  createReviewSchema,
  getSupplierBookingsSchema,
  updateBookingStatusSchema,
  analyticsOverviewSchema,
  analyticsRevenueTrendSchema,
  analyticsFunnelSchema,
};
