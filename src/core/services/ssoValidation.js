const { z } = require('zod');

/**
 * Cross-storefront handoff bodies.
 *
 * `destination` is checked against the client-origin allow-list in the route
 * rather than here: which sites we own is configuration, not shape, and the
 * failure should read as "not an allowed site" instead of a zod type error.
 */

const mintSchema = z.object({
  body: z.object({
    destination: z.string().min(1).max(300),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

const exchangeSchema = z.object({
  body: z.object({
    ticket: z.string().min(1).max(4000),
    destination: z.string().min(1).max(300),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

module.exports = { mintSchema, exchangeSchema };
