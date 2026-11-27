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

// The review composer mirrors Tripadvisor's "Who did you go with?" choices.
// Stored as stable values so the UI can localise the labels later.
const companionValues = ['BUSINESS', 'COUPLES', 'FAMILY', 'FRIENDS', 'SOLO'];
const companionsSchema = z.array(z.enum(companionValues)).max(5).optional();

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
      highDemand: booleanString.optional(),
      hasOffer: booleanString.optional(),
      minRating: z.coerce.number().min(0).max(5).optional(),
      minReviews: z.coerce.number().int().min(0).max(1000000).optional(),
      // Map-server place search: a selected place supplies a point and a
      // radius. Browsing by city still works without coordinates.
      lat: z.coerce.number().min(-90).max(90).optional(),
      lng: z.coerce.number().min(-180).max(180).optional(),
      radiusKm: z.coerce.number().min(0.1).max(50).optional(),
      place: z.string().trim().min(1).max(160).optional(),
      sort: z.enum(['rating', 'reviews', 'newest', 'demand']).default('rating'),
      limit: z.coerce.number().int().min(1).max(50).default(20),
      cursor: z.string().max(500).optional(),
    })
    .passthrough(),
  params: z.object({}).optional(),
});

const suggestQuerySchema = z.object({
  body: emptyBody,
  query: z
    .object({
      brand,
      q: z.string().trim().min(2).max(80),
      limit: z.coerce.number().int().min(1).max(8).default(6),
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

/** Cross-venue review feed ("What Diners Are Saying"). No venue params. */
const reviewFeedQuerySchema = z.object({
  body: emptyBody,
  query: z
    .object({
      brand,
      limit: z.coerce.number().int().min(1).max(50).default(10),
      cursor: z.string().max(500).optional(),
    })
    .passthrough(),
  params: z.object({}).optional(),
});

/**
 * Public homepage rails. Reads are anonymous by default; an authenticated
 * storefront may send a token, in which case optionalAuth attaches req.user
 * and the recommended rail personalizes from recent events.
 */
const homeQuerySchema = z.object({
  body: emptyBody,
  query: z
    .object({
      brand,
      city: z.string().trim().min(1).max(80).optional(),
      lat: z.coerce.number().min(-90).max(90).optional(),
      lng: z.coerce.number().min(-180).max(180).optional(),
      limit: z.coerce.number().int().min(1).max(20).default(8),
    })
    .passthrough(),
  params: z.object({}).optional(),
});

const homeSectionQuerySchema = z.object({
  body: emptyBody,
  query: z
    .object({
      brand,
      section: z
        .enum(['recommended', 'likely-to-book-out', 'offers'])
        .optional(),
      city: z.string().trim().min(1).max(80).optional(),
      lat: z.coerce.number().min(-90).max(90).optional(),
      lng: z.coerce.number().min(-180).max(180).optional(),
      limit: z.coerce.number().int().min(1).max(20).default(8),
    })
    .passthrough(),
  params: z.object({}).optional(),
});

/* ── admin offer contracts ───────────────────────────────────────────────── */

const offerDate = z
  .string()
  .trim()
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'Must be an ISO date-time',
  });

/**
 * Body is strict: an admin cannot set venueId or id through the body. Brand
 * travels in the query and is stamped by the service; a client may echo it,
 * but it is optional and must match the route. Never default it here — a
 * `ghana` default used to reject every non-Ghana create that omitted it. The
 * date order is checked here and again in the service for direct callers.
 */
// Defaults live on the create schema only. Applying them to the partial
// update schema would silently re-enable an offer on every unrelated PATCH.
const offerBodyFields = z
  .object({
    brand: z.enum(['ghana', 'africa', 'expedition']).optional(),
    title: z.string().trim().min(2).max(120),
    discountType: z.enum(['PERCENTAGE', 'FIXED']),
    discountValue: z.coerce.number().positive().max(1000000),
    promoCode: z.string().trim().min(2).max(40).nullable().optional(),
    startsAt: offerDate.nullable().optional(),
    endsAt: offerDate.nullable().optional(),
    isActive: z.boolean(),
    terms: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

function checkOfferWindow(data, ctx) {
  if (!data.startsAt || !data.endsAt) return;
  const start = new Date(data.startsAt);
  const end = new Date(data.endsAt);
  if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end <= start) {
    ctx.addIssue({
      code: 'custom',
      path: ['endsAt'],
      message: 'endsAt must be after startsAt',
    });
  }
}

const createOfferBodySchema = offerBodyFields
  .extend({ isActive: z.boolean().default(true) })
  .superRefine(checkOfferWindow);

const updateOfferBodySchema = offerBodyFields.partial().superRefine((data, ctx) => {
  if (Object.keys(data).length === 0) {
    ctx.addIssue({ code: 'custom', message: 'At least one field is required' });
  }
  checkOfferWindow(data, ctx);
});

const offerVenueParams = z.object({ venueId: z.string().trim().min(1).max(120) });
const offerParams = offerVenueParams.extend({
  offerId: z.string().trim().min(1).max(120),
});
const offerQuery = z.object({ brand }).passthrough();

const listVenueOffersSchema = z.object({
  body: emptyBody,
  query: offerQuery,
  params: offerVenueParams,
});

const createVenueOfferSchema = z.object({
  body: createOfferBodySchema,
  query: offerQuery,
  params: offerVenueParams,
});

const updateVenueOfferSchema = z.object({
  body: updateOfferBodySchema,
  query: offerQuery,
  params: offerParams,
});

const deleteVenueOfferSchema = z.object({
  body: emptyBody,
  query: offerQuery,
  params: offerParams,
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
      companions: companionsSchema,
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

/**
 * An author correction replaces their review. Provenance, visit date and
 * moderation state stay server-owned; the client may only change the content.
 */
const updateReviewSchema = z.object({
  body: z
    .object({
      rating: z.coerce.number().int().min(1).max(5),
      foodRating: z.coerce.number().int().min(1).max(5).optional(),
      serviceRating: z.coerce.number().int().min(1).max(5).optional(),
      atmosphereRating: z.coerce.number().int().min(1).max(5).optional(),
      valueRating: z.coerce.number().int().min(1).max(5).optional(),
      title: z.string().trim().min(3).max(120).optional(),
      body: z.string().trim().min(20).max(3000),
      photos: z.array(z.string().max(500)).max(5).optional(),
      companions: companionsSchema,
    })
    .strict(),
  query: z.object({ brand }).passthrough(),
  params: venueParams.extend({ reviewId: z.string().trim().min(1).max(120) }),
});

const authorReviewQuerySchema = z.object({
  body: emptyBody,
  query: z.object({ brand }).passthrough(),
  params: venueParams.extend({ reviewId: z.string().trim().min(1).max(120) }),
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

const httpUrl = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), { message: 'Must be an http(s) URL' });

/* ── claims and owner surface ────────────────────────────────────────────── */

/** Provenance is evidence for a human reviewer, never a self-granted role. */
const submitClaimSchema = z.object({
  body: z
    .object({
      businessName: z.string().trim().min(2).max(160).optional(),
      role: z.string().trim().min(2).max(80).optional(),
      contactEmail: z.string().trim().email().max(200).optional(),
      phone: z.string().trim().min(7).max(40).optional(),
      message: z.string().trim().min(10).max(2000),
      evidenceUrl: httpUrl.optional(),
    })
    .strict(),
  query: z.object({ brand }).passthrough(),
  params: venueParams,
});

const myClaimSchema = z.object({
  body: emptyBody,
  query: z.object({ brand }).passthrough(),
  params: venueParams,
});

const pendingClaimsQuerySchema = z.object({
  body: emptyBody,
  query: z
    .object({
      limit: z.coerce.number().int().min(1).max(50).default(20),
      cursor: z.string().max(500).optional(),
    })
    .passthrough(),
  params: z.object({}).optional(),
});

const resolveClaimSchema = z.object({
  body: z
    .object({
      action: z.enum(['approve', 'reject']),
      note: z.string().trim().max(500).optional(),
    })
    .strict(),
  query: z.object({}).passthrough(),
  params: z.object({ claimId: z.string().trim().min(1).max(120) }),
});

/** Owners can correct presentation fields, never ratings or external stats. */
const updateOwnVenueSchema = z.object({
  body: z
    .object({
      description: z.string().trim().max(3000).optional(),
      phone: z.string().trim().min(7).max(40).optional(),
      website: httpUrl.optional(),
      menuUrl: httpUrl.nullable().optional(),
      mealTypes: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
      cuisines: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
      dietary: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
      amenities: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
      hours: z.record(z.string(), z.any()).optional(),
      // ACTIVE / PAUSED only. A permanently closed listing stays an admin
      // decision; an owner cannot reopen a DRAFT or closed venue either.
      status: z.enum(['ACTIVE', 'PAUSED']).optional(),
      photos: z.array(z.string().max(500)).max(20).optional(),
      coverPhoto: z.string().max(500).nullable().optional(),
    })
    .strict(),
  query: z.object({ brand }).passthrough(),
  params: venueParams,
});

/* ── owner dashboard ─────────────────────────────────────────────────────── */

const dashboardParams = z.object({
  slugOrId: z.string().trim().min(1).max(120),
});

const dashboardReadSchema = z.object({
  body: emptyBody,
  query: z.object({ brand }).passthrough(),
  params: dashboardParams,
});

const dashboardActivitySchema = z.object({
  body: emptyBody,
  query: z
    .object({
      brand,
      type: z.enum(['reviews', 'photos', 'menu', 'team', 'business', 'hours']).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20),
      cursor: z.string().max(80).optional(),
    })
    .passthrough(),
  params: dashboardParams,
});

const dashboardInsightsSchema = z.object({
  body: emptyBody,
  query: z
    .object({
      brand,
      days: z.coerce.number().int().refine((value) => [7, 30, 90, 365].includes(value), {
        message: 'Must be 7, 30, 90 or 365',
      }).default(30),
    })
    .passthrough(),
  params: dashboardParams,
});

/** Owner review queue. `pending` means a reply is awaiting moderation. */
const ownerReviewsQuerySchema = z.object({
  body: emptyBody,
  query: z
    .object({
      brand,
      filter: z.enum(['all', 'unanswered', 'negative', 'replied', 'pending']).default('all'),
      rating: z.coerce.number().int().min(1).max(5).optional(),
      sort: z.enum(['newest', 'oldest', 'lowest']).default('newest'),
      limit: z.coerce.number().int().min(1).max(50).default(20),
      cursor: z.string().max(500).optional(),
    })
    .passthrough(),
  params: dashboardParams,
});

const ownerReviewParams = dashboardParams.extend({
  reviewId: z.string().trim().min(1).max(120),
});

const ownerReviewSchema = z.object({
  body: emptyBody,
  query: z.object({ brand }).passthrough(),
  params: ownerReviewParams,
});

const createResponseSchema = z.object({
  body: z
    .object({
      body: z.string().trim().min(20).max(2000),
    })
    .strict(),
  query: z.object({ brand }).passthrough(),
  params: ownerReviewParams,
});

const responseParams = dashboardParams.extend({
  responseId: z.string().trim().min(1).max(120),
});

const deleteResponseSchema = z.object({
  body: emptyBody,
  query: z.object({ brand }).passthrough(),
  params: responseParams,
});

const moderateResponseSchema = z.object({
  body: z
    .object({
      action: z.enum(['publish', 'reject']),
      reason: z.string().trim().max(500).optional(),
    })
    .strict(),
  query: z.object({}).passthrough(),
  params: z.object({ responseId: z.string().trim().min(1).max(120) }),
});

const pendingResponsesQuerySchema = z.object({
  body: emptyBody,
  query: z
    .object({
      limit: z.coerce.number().int().min(1).max(50).default(20),
      cursor: z.string().max(500).optional(),
    })
    .passthrough(),
  params: z.object({}).optional(),
});

/* photos */

const uploadVenuePhotosSchema = z.object({
  body: z
    .object({ caption: z.string().trim().max(200).optional() })
    .passthrough()
    .optional(),
  query: z.object({ brand }).passthrough(),
  params: dashboardParams,
});

const photoParams = dashboardParams.extend({
  photoId: z.string().trim().min(1).max(120),
});

const updatePhotoSchema = z.object({
  body: z
    .object({
      caption: z.string().trim().max(200).nullable().optional(),
      position: z.coerce.number().int().min(0).max(1000).optional(),
    })
    .strict(),
  query: z.object({ brand }).passthrough(),
  params: photoParams,
});

const deletePhotoSchema = z.object({
  body: emptyBody,
  query: z.object({ brand }).passthrough(),
  params: photoParams,
});

const reorderPhotosSchema = z.object({
  body: z
    .object({
      photoIds: z.array(z.string().trim().min(1).max(120)).min(1).max(40),
    })
    .strict(),
  query: z.object({ brand }).passthrough(),
  params: dashboardParams,
});

const setCoverPhotoSchema = z.object({
  body: z.object({ photoId: z.string().trim().min(1).max(120) }).strict(),
  query: z.object({ brand }).passthrough(),
  params: dashboardParams,
});

const moderatePhotoSchema = z.object({
  body: z
    .object({
      action: z.enum(['publish', 'reject']),
      reason: z.string().trim().max(500).optional(),
    })
    .strict(),
  query: z.object({}).passthrough(),
  params: z.object({ photoId: z.string().trim().min(1).max(120) }),
});

const pendingPhotosQuerySchema = z.object({
  body: emptyBody,
  query: z
    .object({ limit: z.coerce.number().int().min(1).max(100).default(40) })
    .passthrough(),
  params: z.object({}).optional(),
});

/* menus */

const menuItemBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(600).nullable().optional(),
    priceMinor: z.coerce.number().int().min(0).max(100000000).nullable().optional(),
    dietary: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
    isAvailable: z.boolean().optional(),
    photoUrl: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

const menuSectionBody = z
  .object({
    title: z.string().trim().min(1).max(80),
    description: z.string().trim().max(400).nullable().optional(),
    items: z.array(menuItemBody).max(100).default([]),
  })
  .strict();

const saveMenuSchema = z.object({
  body: z
    .object({
      id: z.string().trim().min(1).max(120).optional(),
      name: z.string().trim().min(1).max(80).optional(),
      description: z.string().trim().max(400).nullable().optional(),
      currency: z.string().trim().length(3).optional(),
      sections: z.array(menuSectionBody).max(20),
    })
    .strict(),
  query: z.object({ brand }).passthrough(),
  params: dashboardParams,
});

const menuParams = dashboardParams.extend({
  menuId: z.string().trim().min(1).max(120),
});

const menuActionSchema = z.object({
  body: emptyBody,
  query: z.object({ brand }).passthrough(),
  params: menuParams,
});

/* team */

const teamReadSchema = z.object({
  body: emptyBody,
  query: z.object({ brand }).passthrough(),
  params: dashboardParams,
});

const inviteMemberSchema = z.object({
  body: z
    .object({
      email: z.string().trim().email().max(200),
      role: z.enum(['MANAGER']).default('MANAGER'),
      expiresInDays: z.coerce.number().int().min(1).max(30).optional(),
    })
    .strict(),
  query: z.object({ brand }).passthrough(),
  params: dashboardParams,
});

const inviteParams = dashboardParams.extend({
  inviteId: z.string().trim().min(1).max(120),
});

const inviteActionSchema = z.object({
  body: emptyBody,
  query: z.object({ brand }).passthrough(),
  params: inviteParams,
});

const acceptInviteSchema = z.object({
  body: z.object({ token: z.string().trim().min(20).max(500) }).strict(),
  query: z.object({}).passthrough(),
  params: z.object({}).optional(),
});

const memberParams = dashboardParams.extend({
  memberId: z.string().trim().min(1).max(120),
});

const updateMemberRoleSchema = z.object({
  body: z.object({ role: z.enum(['OWNER', 'MANAGER']) }).strict(),
  query: z.object({ brand }).passthrough(),
  params: memberParams,
});

const memberActionSchema = z.object({
  body: emptyBody,
  query: z.object({ brand }).passthrough(),
  params: memberParams,
});

module.exports = {
  listQuerySchema,
  suggestQuerySchema,
  venueSchema,
  reviewsQuerySchema,
  reviewFeedQuerySchema,
  homeQuerySchema,
  homeSectionQuerySchema,
  listVenueOffersSchema,
  createVenueOfferSchema,
  updateVenueOfferSchema,
  deleteVenueOfferSchema,
  createReviewSchema,
  updateReviewSchema,
  authorReviewQuerySchema,
  deleteReviewSchema,
  moderateReviewSchema,
  pendingReviewsQuerySchema,
  submitReportSchema,
  resolveReportSchema,
  createInviteSchema,
  submitClaimSchema,
  myClaimSchema,
  pendingClaimsQuerySchema,
  resolveClaimSchema,
  updateOwnVenueSchema,
  dashboardReadSchema,
  dashboardActivitySchema,
  dashboardInsightsSchema,
  ownerReviewsQuerySchema,
  ownerReviewSchema,
  createResponseSchema,
  deleteResponseSchema,
  moderateResponseSchema,
  pendingResponsesQuerySchema,
  uploadVenuePhotosSchema,
  updatePhotoSchema,
  deletePhotoSchema,
  reorderPhotosSchema,
  setCoverPhotoSchema,
  moderatePhotoSchema,
  pendingPhotosQuerySchema,
  saveMenuSchema,
  menuActionSchema,
  teamReadSchema,
  inviteMemberSchema,
  inviteActionSchema,
  acceptInviteSchema,
  updateMemberRoleSchema,
  memberActionSchema,
};
