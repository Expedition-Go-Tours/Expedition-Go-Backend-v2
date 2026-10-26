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

module.exports = {
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
