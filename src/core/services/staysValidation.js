const { z } = require('zod');

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

const bodyObject = z.record(z.string(), z.any()).optional();
const queryObject = z.record(z.string(), z.any()).optional();

const propertyParams = z.object({
  body: bodyObject,
  query: queryObject,
  params: z.object({ id: z.string().min(1) }),
});

const createPropertySchema = z.object({
  body: bodyObject,
  query: queryObject,
  params: z.object({}).optional(),
});

const ratePlanParams = z.object({
  body: bodyObject,
  query: queryObject,
  params: z.object({ id: z.string().min(1), planId: z.string().min(1) }),
});

const photoIndexParams = z.object({
  body: bodyObject,
  query: queryObject,
  params: z.object({ id: z.string().min(1), index: z.coerce.number().int().min(0) }),
});

const availabilityQuery = z.object({
  body: bodyObject,
  query: z.object({
    from: z.string().regex(DATE_KEY).optional(),
    to: z.string().regex(DATE_KEY).optional(),
  }),
  params: z.object({ id: z.string().min(1) }),
});

const availabilityCellBody = z.object({
  body: z.object({
    roomId: z.string().min(1),
    date: z.string().regex(DATE_KEY),
    count: z.coerce.number().int().min(0).nullable().optional(),
    closed: z.boolean().optional(),
    price: z.coerce.number().min(0).nullable().optional(),
    minStay: z.coerce.number().int().min(1).nullable().optional(),
  }).passthrough(),
  query: queryObject,
  params: z.object({ id: z.string().min(1) }),
});

const availabilityCellDelete = z.object({
  body: bodyObject,
  query: z.object({
    roomId: z.string().min(1),
    date: z.string().regex(DATE_KEY),
  }),
  params: z.object({ id: z.string().min(1) }),
});

const emptyBody = z.object({
  body: bodyObject,
  query: queryObject,
  params: z.object({ id: z.string().min(1) }),
});

const idParams = z.object({
  body: bodyObject,
  query: queryObject,
  params: z.object({ id: z.string().min(1) }),
});

const listQuery = z.object({
  body: bodyObject,
  query: z.record(z.string(), z.any()).optional(),
  params: z.object({}).optional(),
});

const offerSaveSchema = z.object({
  body: z.record(z.string(), z.any()),
  query: queryObject,
  // POST has no :id, PATCH does. Express always supplies {} for params, so the
  // id must be optional at the schema level; the controller enforces it on edit.
  params: z.object({ id: z.string().min(1).optional() }).optional(),
});

const createBookingSchema = z.object({
  body: z.record(z.string(), z.any()),
  query: queryObject,
  params: z.object({}).optional(),
});

const bookingStatusSchema = z.object({
  body: z.object({ status: z.string().min(1) }).passthrough(),
  query: queryObject,
  params: z.object({ id: z.string().min(1) }),
});

const reviewReplySchema = z.object({
  body: z.object({ reply: z.string().min(1).max(2000) }),
  query: queryObject,
  params: z.object({ id: z.string().min(1) }),
});

const analyticsQuery = z.object({
  body: bodyObject,
  query: z.object({
    period: z.string().max(50).optional(),
    months: z.coerce.number().int().min(1).max(24).optional(),
  }).passthrough(),
  params: z.object({}).optional(),
});

const cancellationQuery = z.object({
  body: bodyObject,
  query: z.object({
    days: z.coerce.number().int().min(1).max(3650).optional(),
    propertyId: z.string().max(100).optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }).passthrough(),
  params: z.object({}).optional(),
});

/* ── Availability tooling ──────────────────────────────────────────────── */

const calendarQuery = z.object({
  body: bodyObject,
  query: z.object({
    from: z.string().regex(DATE_KEY).optional(),
    to: z.string().regex(DATE_KEY).optional(),
    roomId: z.string().min(1).optional(),
  }),
  params: z.object({ id: z.string().min(1) }),
});

const availabilityBulkSchema = z.object({
  body: z.object({
    action: z.enum(['close', 'open']),
    roomIds: z.array(z.string().min(1)).min(1).max(100),
    from: z.string().regex(DATE_KEY),
    to: z.string().regex(DATE_KEY),
  }),
  query: queryObject,
  params: z.object({ id: z.string().min(1) }),
});

const availabilityCopySchema = z.object({
  body: z.object({
    roomIds: z.array(z.string().min(1)).min(1).max(100),
    sourceFrom: z.string().regex(DATE_KEY),
    sourceTo: z.string().regex(DATE_KEY),
    targetStart: z.string().regex(DATE_KEY),
    fields: z.array(z.enum(['price', 'count', 'minStay', 'closed'])).min(1).optional(),
    overwrite: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  }),
  query: queryObject,
  params: z.object({ id: z.string().min(1) }),
});

const restrictionRuleBody = z.object({
  name: z.string().trim().max(120).nullable().optional(),
  startDate: z.string().regex(DATE_KEY).nullable().optional(),
  endDate: z.string().regex(DATE_KEY).nullable().optional(),
  weekdays: z.array(z.string().min(1)).max(7).optional(),
  roomIds: z.array(z.string().min(1)).max(100).optional(),
  minStay: z.coerce.number().int().min(1).max(365).nullable().optional(),
  maxStay: z.coerce.number().int().min(1).max(365).nullable().optional(),
  stopSell: z.boolean().optional(),
  closedToArrival: z.boolean().optional(),
  closedToDeparture: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const restrictionRuleCreateSchema = z.object({
  body: restrictionRuleBody,
  query: queryObject,
  params: z.object({ id: z.string().min(1) }),
});

const restrictionRuleUpdateSchema = z.object({
  body: restrictionRuleBody,
  query: queryObject,
  params: z.object({ id: z.string().min(1), ruleId: z.string().min(1) }),
});

const restrictionRuleParams = z.object({
  body: bodyObject,
  query: queryObject,
  params: z.object({ id: z.string().min(1), ruleId: z.string().min(1) }),
});

const valueAddBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  price: z.coerce.number().min(0).max(100000000).optional(),
  unit: z.string()
    .transform((value) => value.toUpperCase())
    .pipe(z.enum(['PER_STAY', 'PER_NIGHT', 'PER_PERSON']))
    .optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(10000).optional(),
});

const valueAddCreateSchema = z.object({
  body: valueAddBody,
  query: queryObject,
  params: z.object({ id: z.string().min(1) }),
});

const valueAddUpdateSchema = z.object({
  body: valueAddBody,
  query: queryObject,
  params: z.object({ id: z.string().min(1), valueAddId: z.string().min(1) }),
});

const valueAddParams = z.object({
  body: bodyObject,
  query: queryObject,
  params: z.object({ id: z.string().min(1), valueAddId: z.string().min(1) }),
});

const guestPricingBody = z.object({
  baseGuests: z.coerce.number().int().min(1).max(100).optional(),
  singleGuestDiscount: z.coerce.number().min(0).max(1000000).optional(),
  extraAdult: z.coerce.number().min(0).max(1000000).optional(),
}).refine(
  (value) => Object.keys(value).length > 0,
  { message: 'Provide at least one guest-pricing field' },
);

const ratePlanGuestPricingSchema = z.object({
  body: guestPricingBody,
  query: queryObject,
  params: z.object({ id: z.string().min(1), planId: z.string().min(1) }),
});

const ratePlanChildPricingSchema = z.object({
  body: z.object({
    extraChild: z.coerce.number().min(0).max(1000000),
  }),
  query: queryObject,
  params: z.object({ id: z.string().min(1), planId: z.string().min(1) }),
});

module.exports = {
  idParams,
  listQuery,
  offerSaveSchema,
  createBookingSchema,
  bookingStatusSchema,
  reviewReplySchema,
  analyticsQuery,
  cancellationQuery,
  createPropertySchema,
  propertyParams,
  ratePlanParams,
  photoIndexParams,
  availabilityQuery,
  availabilityCellBody,
  availabilityCellDelete,
  emptyBody,
  DATE_KEY,
  calendarQuery,
  availabilityBulkSchema,
  availabilityCopySchema,
  restrictionRuleCreateSchema,
  restrictionRuleUpdateSchema,
  restrictionRuleParams,
  valueAddCreateSchema,
  valueAddUpdateSchema,
  valueAddParams,
  ratePlanGuestPricingSchema,
  ratePlanChildPricingSchema,
};
