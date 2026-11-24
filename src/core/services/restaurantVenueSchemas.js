/**
 * Request contracts for /api/restaurant-venues.
 *
 * Wrapped in `{ body, query, params }` to match middleware/validate.js.
 * Queries are `.passthrough()` so a storefront can append campaign/UTM params
 * without a 400. The contract only promises the fields below.
 *
 * `brand` defaults to Ghana because the vertical launches on the Ghana
 * storefront; the other two are accepted now so a storefront can pass its own
 * key without a backend deploy.
 */

const { z } = require('zod');

const brand = z.enum(['ghana', 'africa', 'expedition']).default('ghana');

/** Query-string booleans must not use z.coerce.boolean(): "false" is truthy. */
const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

const emptyBody = z.any().optional();

const listQuerySchema = z.object({
  body: emptyBody,
  query: z
    .object({
      brand,
      q: z.string().trim().min(1).max(80).optional(),
      city: z.string().trim().min(1).max(80).optional(),
      cuisine: z.string().trim().min(1).max(40).optional(),
      dietary: z
        .string()
        .trim()
        .max(160)
        .optional()
        .transform((value) =>
          value
            ? value
                .split(',')
                .map((item) => item.trim().toLowerCase())
                .filter(Boolean)
            : undefined,
        ),
      priceBand: z.coerce.number().int().min(1).max(4).optional(),
      featured: booleanString.optional(),
      minRating: z.coerce.number().min(0).max(5).optional(),
      minReviews: z.coerce.number().int().min(0).max(1000000).optional(),
      sort: z.enum(['rating', 'reviews', 'newest']).default('rating'),
      limit: z.coerce.number().int().min(1).max(50).default(20),
      cursor: z.string().max(500).optional(),
    })
    .passthrough(),
  params: z.object({}).optional(),
});

const venueParams = z.object({
  slugOrId: z.string().trim().min(1).max(120),
});

const venueSchema = z.object({
  body: emptyBody,
  query: z.object({ brand }).passthrough(),
  params: venueParams,
});

const reviewsQuerySchema = z.object({
  body: emptyBody,
  query: z
    .object({
      brand,
      limit: z.coerce.number().int().min(1).max(50).default(10),
      cursor: z.string().max(500).optional(),
      rating: z.coerce.number().int().min(1).max(5).optional(),
      verified: booleanString.optional(),
    })
    .passthrough(),
  params: venueParams,
});

/* ── write contracts ─────────────────────────────────────────────────────── */

/**
 * The review body is strict on purpose. A client that sends `source`,
 * `verified` or `status` gets a 400 rather than the comforting illusion that
 * it set its own provenance. Those fields come from the signed invite on the
 * server, never from here.
 */
const createReviewSchema = z.object({
  body: z
    .object({
      rating: z.coerce.number().int().min(1).max(5),
      foodRating: z.coerce.number().int().min(1).max(5).optional(),
      serviceRating: z.coerce.number().int().min(1).max(5).optional(),
      atmosphereRating: z.coerce.number().int().min(1).max(5).optional(),
      valueRating: z.coerce.number().int().min(1).max(5).optional(),
      title: z.string().trim().min(3).max(120).optional(),
      body: z.string().trim().min(20).max(3000),
      visitedAt: z
        .string()
        .max(40)
        .refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isNaN(Date.parse(value)), {
          message: 'Must be YYYY-MM-DD or an ISO date-time',
        })
        .optional(),
      photos: z.array(z.string().max(500)).max(5).optional(),
      proofToken: z.string().min(20).max(1000).optional(),
    })
    .strict(),
  query: z.object({ brand }).passthrough(),
  params: venueParams,
});

const deleteReviewSchema = z.object({
  body: emptyBody,
  query: z.object({ brand }).passthrough(),
  params: venueParams.extend({ reviewId: z.string().trim().min(1).max(120) }),
});

const reviewIdParams = z.object({ reviewId: z.string().trim().min(1).max(120) });

const moderateReviewSchema = z.object({
  body: z
    .object({
      action: z.enum(['approve', 'reject', 'flag']),
      reason: z.string().trim().min(3).max(500).optional(),
    })
    .strict(),
  query: z.object({}).passthrough(),
  params: reviewIdParams,
});

const pendingReviewsQuerySchema = z.object({
  body: emptyBody,
  query: z
    .object({
      limit: z.coerce.number().int().min(1).max(50).default(20),
      cursor: z.string().max(500).optional(),
    })
    .passthrough(),
  params: z.object({}).optional(),
});

const submitReportSchema = z.object({
  body: z
    .object({
      reason: z.string().trim().min(3).max(120),
      detail: z.string().trim().max(1000).optional(),
    })
    .strict(),
  query: z.object({ brand }).passthrough(),
  params: venueParams.extend({ reviewId: z.string().trim().min(1).max(120) }),
});

const resolveReportSchema = z.object({
  body: z
    .object({
      classification: z.enum(['FAKE', 'CONTESTED']),
      outcome: z.enum(['UPHELD', 'DISMISSED']),
    })
    .strict(),
  query: z.object({}).passthrough(),
  params: z.object({ reportId: z.string().trim().min(1).max(120) }),
});

const createInviteSchema = z.object({
  body: z
    .object({
      proofMethod: z.enum(['QR_RECEIPT', 'EMAIL_INVITE']),
      email: z.string().trim().email().max(200).optional(),
      visitDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      expiresInDays: z.coerce.number().int().min(1).max(90).optional(),
    })
    .strict(),
  query: z.object({ brand }).passthrough(),
  params: venueParams,
});

module.exports = {
  listQuerySchema,
  venueSchema,
  reviewsQuerySchema,
  createReviewSchema,
  deleteReviewSchema,
  moderateReviewSchema,
  pendingReviewsQuerySchema,
  submitReportSchema,
  resolveReportSchema,
  createInviteSchema,
};
