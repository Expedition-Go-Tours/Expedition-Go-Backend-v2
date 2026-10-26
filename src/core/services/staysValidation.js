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
};
